/**
 * Input: node:crypto、node:fs、node:os、node:path、node:sqlite 与可选 ./scanner 只读快照兜底打开器。
 * Output: 导出 T3ThreadLink、T3ThreadIndex、resolveDefaultT3UserdataDir 与 createT3ThreadIndex，提供零拷贝优先、带指纹与短窗缓存的 T3 线程与标题索引。
 * Pos: 服务端 T3 Code 线程归并辅助层，将同一 T3 线程（如定时任务 fresh_session 多次轮转）产生的多个底层会话关联到同一组并还原正式中文标题。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface T3ThreadLink {
  t3ThreadId: string; // 脱敏短哈希后的 T3 线程分组键（避免暴露本地项目 ID）
  t3ThreadTitle: string; // T3 侧正式线程标题（若有效）
}

type SqliteOpener = (dbPath: string) => {
  db: { prepare(sql: string): { all(): unknown[] }; close(): void };
  cleanup: () => void;
};

export interface T3ThreadIndex {
  load(forceRefresh?: boolean): Map<string, T3ThreadLink>;
}

const PLACEHOLDER_TITLES = new Set(["deleted thread", "new thread", "untitled"]);
const NATIVE_THREAD_ID_RE = /native-thread:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_SNAPSHOT_COPY_BYTES = 32 * 1024 * 1024; // 仅对 <=32MB 的小型无 -shm WAL 库回退临时拷贝，避免复制数百 MB statev2.sqlite 阻塞事件循环
const WAL_CHURN_DEDUP_MS = 2500; // 同一次多源扫描突发内复用刚加载的索引，防止 T3 持续写 WAL 导致同请求反复重查

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

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
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
 * 职责：优先以零拷贝只读模式打开大型 statev2.sqlite（无活跃 WAL 走 immutable=1；有活跃 WAL 且 -shm 已存在时直连 readOnly WAL 读取，不复制数百 MB 文件也不创建新文件）；仅对缺失 -shm 的小型 WAL 库回退临时快照拷贝。
 */
function openStateDbReadOnly(
  dbPath: string,
  fallbackOpenSqlite: SqliteOpener
): ReturnType<SqliteOpener> {
  const walSize = getFileSize(`${dbPath}-wal`);
  const hasShm = fs.existsSync(`${dbPath}-shm`);
  const dbSize = getFileSize(dbPath);
  const noop = () => undefined;

  if (walSize === 0) {
    const db = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true });
    return { db, cleanup: noop };
  }

  if (hasShm) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 200; PRAGMA query_only = ON;");
      return { db, cleanup: noop };
    } catch {
      try { db?.close(); } catch { /* ignore */ }
      if (dbSize <= MAX_SNAPSHOT_COPY_BYTES) {
        return fallbackOpenSqlite(dbPath);
      }
      const immutableDb = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true });
      return { db: immutableDb, cleanup: noop };
    }
  }

  if (dbSize <= MAX_SNAPSHOT_COPY_BYTES) {
    return fallbackOpenSqlite(dbPath);
  }
  const db = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true });
  return { db, cleanup: noop };
}

/**
 * 职责：创建带文件指纹与短窗复用缓存的 T3 statev2.sqlite 只读索引器，按底层 Antigravity conversationId 反查所属 T3 线程与正式标题。
 * 思路：1) 当 t3UserdataDir 为 null 或 statev2.sqlite 不存在时零开销返回空表；2) 指纹未变或刚完成加载时直接 O(1) 返回；3) 需要刷新时优先零拷贝只读查询，彻底消除数百 MB 临时复制卡顿。
 * 参数：openSqlite — 零写入只读快照兜底打开函数；t3UserdataDir — T3 userdata 目录（null 表示禁用，undefined 使用默认路径）。
 * 返回值：暴露 load(forceRefresh) 的 T3ThreadIndex 实例。
 */
export function createT3ThreadIndex(openSqlite: SqliteOpener, t3UserdataDir?: string | null): T3ThreadIndex {
  let lastSig = "";
  let lastLoadedAt = 0;
  let cachedMap = new Map<string, T3ThreadLink>();

  return {
    load(forceRefresh = false): Map<string, T3ThreadLink> {
      if (t3UserdataDir === null) return cachedMap;
      const baseDir = t3UserdataDir || resolveDefaultT3UserdataDir();
      const dbPath = path.join(baseDir, "statev2.sqlite");
      const sig = `${getSig(dbPath)}#${getSig(`${dbPath}-wal`)}`;
      if (sig === "0:0:0#0:0:0") {
        lastSig = "";
        lastLoadedAt = 0;
        cachedMap = new Map();
        return cachedMap;
      }
      const now = Date.now();
      if (!forceRefresh && (sig === lastSig || (lastLoadedAt > 0 && now - lastLoadedAt < WAL_CHURN_DEDUP_MS))) {
        return cachedMap;
      }

      let opened: ReturnType<SqliteOpener> | null = null;
      try {
        opened = openStateDbReadOnly(dbPath, openSqlite);
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
        lastLoadedAt = Date.now();
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
