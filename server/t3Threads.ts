/**
 * Input: node:crypto、node:fs、node:os、node:path 与 ./scanner 导出的 openSqliteSafe 只读快照工具。
 * Output: 导出 T3ThreadLink、resolveDefaultT3UserdataDir 与 createT3ThreadIndex，提供零写入、带指纹缓存的 T3 线程与标题索引。
 * Pos: 服务端 T3 Code 线程归并辅助层，将同一 T3 线程（如定时任务 fresh_session 多次轮转）产生的多个底层会话关联到同一组并还原正式中文标题。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface T3ThreadLink {
  t3ThreadId: string; // 脱敏短哈希后的 T3 线程分组键（避免暴露本地项目 ID）
  t3ThreadTitle: string; // T3 侧正式线程标题（若有效）
}

type SqliteOpener = (dbPath: string) => {
  db: { prepare(sql: string): { all(): unknown[] }; close(): void };
  cleanup: () => void;
};

const PLACEHOLDER_TITLES = new Set(["deleted thread", "new thread", "untitled"]);
const NATIVE_THREAD_ID_RE = /native-thread:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 解析默认 T3 Code userdata 目录路径 */
export function resolveDefaultT3UserdataDir(): string {
  return process.env.T3_USERDATA_DIR || path.join(os.homedir(), ".t3", "userdata");
}

function getSig(filePath: string): string {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "0:0:0";
  }
}

function toOpaqueThreadKey(rawThreadId: string): string {
  return `t3-${crypto.createHash("sha256").update(rawThreadId).digest("hex").slice(0, 12)}`;
}

function sanitizeTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title || PLACEHOLDER_TITLES.has(title.toLowerCase())) return "";
  return title;
}

/**
 * 职责：创建带文件指纹缓存的 T3 statev2.sqlite 只读索引器，按底层 Antigravity conversationId 反查所属 T3 线程与正式标题。
 * 思路：1) 当 t3UserdataDir 为 null 或 statev2.sqlite 不存在时零开销返回空表；2) 仅在主库或 -wal 指纹变化时通过零写入临时快照重读一次。
 * 参数：openSqlite — 零写入只读快照打开函数；t3UserdataDir — T3 userdata 目录（null 表示禁用，undefined 使用默认路径）。
 * 返回值：暴露 load(forceRefresh) 的索引器实例。
 */
export function createT3ThreadIndex(openSqlite: SqliteOpener, t3UserdataDir?: string | null) {
  let lastSig = "";
  let cachedMap = new Map<string, T3ThreadLink>();

  return {
    load(forceRefresh = false): Map<string, T3ThreadLink> {
      if (t3UserdataDir === null) return cachedMap;
      const baseDir = t3UserdataDir || resolveDefaultT3UserdataDir();
      const dbPath = path.join(baseDir, "statev2.sqlite");
      const sig = `${getSig(dbPath)}#${getSig(`${dbPath}-wal`)}`;
      if (sig === "0:0:0#0:0:0") {
        lastSig = "";
        cachedMap = new Map();
        return cachedMap;
      }
      if (!forceRefresh && sig === lastSig) {
        return cachedMap;
      }

      let opened: ReturnType<SqliteOpener> | null = null;
      try {
        opened = openSqlite(dbPath);
        const schedTitleByThread = new Map<string, string>();
        try {
          const schedRows = opened.db
            .prepare("SELECT thread_id, title FROM scheduled_tasks WHERE thread_id IS NOT NULL")
            .all() as Array<{ thread_id: string | null; title: string | null }>;
          for (const r of schedRows) {
            const title = sanitizeTitle(r.title);
            if (r.thread_id && title) schedTitleByThread.set(r.thread_id, title);
          }
        } catch {
          /* 旧版库无 scheduled_tasks 表时忽略 */
        }

        const rows = opened.db
          .prepare(`
            SELECT pt.provider_thread_id, pt.thread_id, pt.payload_json, t.title
            FROM orchestration_v2_projection_provider_threads pt
            LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
          `)
          .all() as Array<{
          provider_thread_id: string | null;
          thread_id: string | null;
          payload_json: string | null;
          title: string | null;
        }>;

        const nextMap = new Map<string, T3ThreadLink>();
        for (const r of rows) {
          if (!r.thread_id) continue;
          let nativeId = "";
          if (r.payload_json) {
            try {
              const parsed = JSON.parse(r.payload_json) as { nativeThreadRef?: { nativeId?: unknown } };
              if (typeof parsed?.nativeThreadRef?.nativeId === "string") {
                nativeId = parsed.nativeThreadRef.nativeId.trim();
              }
            } catch {
              /* 忽略异常 JSON */
            }
          }
          if (!nativeId && r.provider_thread_id) {
            const m = r.provider_thread_id.match(NATIVE_THREAD_ID_RE);
            if (m && m[1]) nativeId = m[1];
          }
          if (!nativeId) continue;

          const t3ThreadTitle = sanitizeTitle(r.title) || schedTitleByThread.get(r.thread_id) || "";
          const key = nativeId.toLowerCase();
          const prev = nextMap.get(key);
          if (!prev || (!prev.t3ThreadTitle && t3ThreadTitle)) {
            nextMap.set(key, {
              t3ThreadId: toOpaqueThreadKey(r.thread_id),
              t3ThreadTitle,
            });
          }
        }
        lastSig = sig;
        cachedMap = nextMap;
        return cachedMap;
      } catch {
        // statev2.sqlite 并发写冲突或表结构不兼容时静默退化，绝不影响主遥测扫描
        return cachedMap;
      } finally {
        try {
          opened?.db.close();
        } catch {
          /* ignore */
        }
        opened?.cleanup();
      }
    },
  };
}
