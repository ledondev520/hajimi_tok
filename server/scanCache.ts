/**
 * Input: node:crypto、node:fs、node:path、node:zlib 与 ../src/types/telemetry 类型契约。
 * Output: 导出 resolveScanCachePath、computePricingSig 与 createPersistentScanCache，提供带 schema/费率指纹校验、原子落盘与异步防抖的扫描缓存持久化能力。
 * Pos: 服务端本地扫描索引持久化层，将 150+ 会话库与轨迹解析结果按文件指纹缓存至 ~/.hamiji-sta/scan-cache/*.json.gz，加速常驻服务重启冷启动与 npm run stats CLI。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { ConversationDetail, ModelPriceRate } from "../src/types/telemetry";

export interface PersistedScanEntry {
  fingerprint: string; // 多源文件 mtimeMs:size:ino 与元数据组合指纹
  detail: ConversationDetail; // 已构建的会话详情快照
  readMode: "wal-readonly" | "immutable-fallback" | "none"; // 最近一次 SQLite 读取模式
}

interface PersistedScanCacheFile {
  schemaVersion: number;
  pricingSig: string;
  dataDir: string;
  entries: Record<string, PersistedScanEntry>;
}

export interface PersistentScanCache {
  load(): Map<string, PersistedScanEntry>;
  scheduleSave(entries: Map<string, PersistedScanEntry>, immediate?: boolean): void;
  flushSync(): void;
}

const SCAN_CACHE_SCHEMA_VERSION = 1; // 缓存结构版本号，字段变更时自增即可自动失效旧缓存
const SAVE_DEBOUNCE_MS = 1500; // 常驻增量更新防抖延迟，避免阻塞 HTTP 响应

const pendingExitFlushers = new Set<() => void>();
let exitHookRegistered = false;

function registerBeforeExitFlush(flusher: () => void): void {
  pendingExitFlushers.add(flusher);
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("beforeExit", () => {
    for (const fn of [...pendingExitFlushers]) {
      try {
        fn();
      } catch {
        /* 退出前缓存落盘失败静默忽略 */
      }
    }
  });
}

/** 计算模型单价表指纹，单价升级时自动失效旧扫描缓存 */
export function computePricingSig(rates: ModelPriceRate[]): string {
  return crypto.createHash("sha1").update(JSON.stringify(rates)).digest("hex").slice(0, 16);
}

/** 根据状态根目录与数据目录生成独立缓存文件路径（.json.gz） */
export function resolveScanCachePath(stateRootDir: string, dataDir: string): string {
  const hash = crypto.createHash("sha1").update(path.resolve(dataDir)).digest("hex").slice(0, 12);
  return path.join(stateRootDir, "scan-cache", `${hash}.json.gz`);
}

function serializePayload(
  resolvedDir: string,
  pricingSig: string,
  entries: Map<string, PersistedScanEntry>
): Buffer {
  const record: Record<string, PersistedScanEntry> = {};
  for (const [k, v] of entries.entries()) record[k] = v;
  const fileObj: PersistedScanCacheFile = {
    schemaVersion: SCAN_CACHE_SCHEMA_VERSION,
    pricingSig,
    dataDir: resolvedDir,
    entries: record,
  };
  return zlib.gzipSync(JSON.stringify(fileObj), { level: 1 });
}

function writeAtomicSync(targetPath: string, buf: Buffer): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
    fs.renameSync(tmpPath, targetPath);
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

async function writeAtomicAsync(targetPath: string, buf: Buffer): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, buf, { mode: 0o600 });
    await fs.promises.rename(tmpPath, targetPath);
  } catch {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 职责：为单个扫描目录创建带 schema/费率校验与原子写入的持久化磁盘扫描缓存。
 * 思路：1) 首次扫描加载 .json.gz 填充内存指纹缓存；2) 首次建档或大批变化立即写盘，日常增量走异步防抖落盘（HTTP 零阻塞），CLI 进程在 beforeExit 自动同步落盘。
 */
export function createPersistentScanCache(
  cachePath: string,
  dataDir: string,
  rates: ModelPriceRate[]
): PersistentScanCache {
  const resolvedDir = path.resolve(dataDir);
  const pricingSig = computePricingSig(rates);
  let pendingSnapshot: Map<string, PersistedScanEntry> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushSync = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pendingSnapshot) return;
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    pendingExitFlushers.delete(flushSync);
    try {
      writeAtomicSync(cachePath, serializePayload(resolvedDir, pricingSig, snap));
    } catch {
      /* 磁盘不可写时静默降级为纯内存缓存 */
    }
  };

  return {
    load(): Map<string, PersistedScanEntry> {
      const out = new Map<string, PersistedScanEntry>();
      if (process.env.AGY_DISABLE_SCAN_CACHE === "1" || !fs.existsSync(cachePath)) {
        return out;
      }
      try {
        const raw = fs.readFileSync(cachePath);
        const jsonText = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
        const parsed = JSON.parse(jsonText) as Partial<PersistedScanCacheFile>;
        if (
          parsed.schemaVersion !== SCAN_CACHE_SCHEMA_VERSION ||
          parsed.pricingSig !== pricingSig ||
          parsed.dataDir !== resolvedDir ||
          !parsed.entries ||
          typeof parsed.entries !== "object"
        ) {
          return out;
        }
        for (const [id, item] of Object.entries(parsed.entries)) {
          if (item && typeof item.fingerprint === "string" && item.detail && Array.isArray(item.detail.steps)) {
            out.set(id, item);
          }
        }
      } catch {
        /* 缓存损坏或被截断时静默回退全量扫描 */
      }
      return out;
    },

    scheduleSave(entries: Map<string, PersistedScanEntry>, immediate = false): void {
      if (process.env.AGY_DISABLE_SCAN_CACHE === "1") return;
      pendingSnapshot = new Map(entries);
      if (immediate) {
        flushSync();
        return;
      }
      registerBeforeExitFlush(flushSync);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!pendingSnapshot) return;
        const snap = pendingSnapshot;
        pendingSnapshot = null;
        pendingExitFlushers.delete(flushSync);
        try {
          const buf = serializePayload(resolvedDir, pricingSig, snap);
          void writeAtomicAsync(cachePath, buf);
        } catch {
          /* ignore */
        }
      }, SAVE_DEBOUNCE_MS);
      timer.unref();
    },

    flushSync,
  };
}
