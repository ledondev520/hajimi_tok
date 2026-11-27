/**
 * Input: node:fs、node:os、node:path、node:crypto、node:url 与 ../src/types/telemetry 中的 QuotaResetEvent / WeeklyQuotaCalibration 类型。
 * Output: 导出 createResetStore()（自动合并仓库 shared-resets.json 与本机 ~/.hamiji-sta/resets.json，支持个人隐藏公共条目）与 createCalibrationStore()。
 * Pos: 服务端配额重置记录与周剩余%校准快照的轻量本地存储层（server/resetStore.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LivePoolQuotaSnapshot,
  QuotaResetEvent,
  WeeklyQuotaCalibration,
} from "../src/types/telemetry";

const VALID_POOLS = new Set<QuotaResetEvent["pool"]>(["all", "gemini", "claude"]); // 合法配额池枚举
const DEFAULT_SHARED_RESETS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "shared-resets.json"
); // 仓库内置全员强制重置公共种子文件路径

/** 本机 resets.json 落盘条目（兼容旧格式，新增可选 dismissed 墓碑以支持个人隐藏某条公共重置） */
interface StoredLocalResetEvent extends QuotaResetEvent {
  dismissed?: boolean;
}

/**
 * 职责：解析用户重置记录 JSON 文件的落盘路径（优先环境变量 AGY_RESETS_FILE，默认 ~/.hamiji-sta/resets.json）。
 * 参数：customPath — 可选显式路径（供单测隔离）。
 * 返回值：绝对文件路径。
 */
export function resolveResetStorePath(customPath?: string): string {
  if (customPath) return customPath;
  const fromEnv = process.env.AGY_RESETS_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".hamiji-sta", "resets.json");
}

/**
 * 职责：解析仓库公共强制重置种子文件路径（单测传 customPath 但未传 customSharedPath 时返回 null 保持隔离）。
 * 参数：customPath — 本机自定义路径；customSharedPath — 可选公共文件路径。
 * 返回值：公共文件绝对路径或 null。
 */
export function resolveSharedResetsPath(customPath?: string, customSharedPath?: string): string | null {
  if (customSharedPath) return customSharedPath;
  if (customPath) return null;
  const fromEnv = process.env.AGY_SHARED_RESETS_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return DEFAULT_SHARED_RESETS_PATH;
}

/**
 * 职责：将原始未知数组过滤归一化为按时间升序排列的合法存储记录列表。
 * 参数：raw — JSON 反序列化结果；keepDismissed — 是否保留个人隐藏墓碑标记。
 * 返回值：排序去重后的 StoredLocalResetEvent 数组。
 */
function normalizeResetList(raw: unknown, keepDismissed = false): StoredLocalResetEvent[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: StoredLocalResetEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const rawTs = typeof obj.timestamp === "string" ? obj.timestamp.trim() : "";
    const tsMs = Date.parse(rawTs);
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;
    const iso = new Date(tsMs).toISOString();
    const pool = VALID_POOLS.has(obj.pool as QuotaResetEvent["pool"])
      ? (obj.pool as QuotaResetEvent["pool"])
      : "all";
    const dismissed = obj.dismissed === true;
    if (dismissed && !keepDismissed) continue;
    const dedupeKey = `${iso}|${pool}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID();
    const note = typeof obj.note === "string" ? obj.note.trim().slice(0, 120) : "";
    out.push(dismissed ? { id, timestamp: iso, pool, note: "", dismissed: true } : { id, timestamp: iso, pool, note });
  }
  return out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/**
 * 职责：创建本地配额重置事件存储实例，自动合并仓库公共强制重置与本机个人登记。
 * 思路：1) 公共文件只读；2) 合并时以 `timestamp|pool` 去重，本机覆盖公共，支持墓碑隐藏指定公共条目；3) 写入仍原子落盘至本机文件。
 * 参数：customPath — 可选本机文件路径；customSharedPath — 可选仓库公共种子路径。
 * 返回值：包含 list / add / remove 的存储对象。
 */
export function createResetStore(customPath?: string, customSharedPath?: string) {
  const filePath = resolveResetStorePath(customPath);
  const sharedPath = resolveSharedResetsPath(customPath, customSharedPath);

  const readShared = (): QuotaResetEvent[] => {
    if (!sharedPath || !fs.existsSync(sharedPath)) return [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sharedPath, "utf8"));
      return normalizeResetList(parsed, false).map((r) => ({ ...r, source: "shared" as const }));
    } catch {
      return [];
    }
  };

  const readLocalRaw = (): StoredLocalResetEvent[] => {
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalizeResetList(parsed, true);
    } catch {
      return [];
    }
  };

  const mergeAll = (localRaw: StoredLocalResetEvent[]): QuotaResetEvent[] => {
    const shared = readShared();
    const dismissedKeys = new Set<string>();
    const localActiveByKey = new Map<string, QuotaResetEvent>();

    for (const item of localRaw) {
      const key = `${item.timestamp}|${item.pool}`;
      if (item.dismissed) {
        dismissedKeys.add(key);
      } else {
        localActiveByKey.set(key, {
          id: item.id,
          timestamp: item.timestamp,
          pool: item.pool,
          note: item.note,
          source: "local",
        });
      }
    }

    const merged: QuotaResetEvent[] = [];
    for (const s of shared) {
      const key = `${s.timestamp}|${s.pool}`;
      if (dismissedKeys.has(key) || localActiveByKey.has(key)) continue;
      merged.push(s);
    }
    for (const l of localActiveByKey.values()) {
      merged.push(l);
    }
    return merged.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  };

  const writeLocalRaw = (list: StoredLocalResetEvent[]): QuotaResetEvent[] => {
    const normalized = normalizeResetList(list, true);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
    return mergeAll(normalized);
  };

  return {
    list(): QuotaResetEvent[] {
      return mergeAll(readLocalRaw());
    },
    add(input: { timestamp: string; pool: "all" | "gemini" | "claude"; note?: string }): QuotaResetEvent[] {
      const tsMs = Date.parse(input.timestamp);
      if (!Number.isFinite(tsMs) || tsMs <= 0) {
        throw new Error("无效的重置时间格式");
      }
      if (!VALID_POOLS.has(input.pool)) {
        throw new Error("无效的配额池类型（仅支持 all / gemini / claude）");
      }
      const iso = new Date(tsMs).toISOString();
      const note = (input.note ?? "").trim().slice(0, 120);
      const current = readLocalRaw().filter((r) => !(r.timestamp === iso && r.pool === input.pool));
      current.push({ id: crypto.randomUUID(), timestamp: iso, pool: input.pool, note });
      return writeLocalRaw(current);
    },
    remove(id: string): QuotaResetEvent[] {
      const target = id.trim();
      if (!target) return mergeAll(readLocalRaw());
      const shared = readShared();
      const sharedKeys = new Set(shared.map((s) => `${s.timestamp}|${s.pool}`));
      const localRaw = readLocalRaw();

      const localHit = localRaw.find((r) => !r.dismissed && r.id === target);
      if (localHit) {
        const next = localRaw.filter((r) => r.id !== target);
        const key = `${localHit.timestamp}|${localHit.pool}`;
        if (sharedKeys.has(key)) {
          next.push({
            id: `dismiss:${localHit.id}`,
            timestamp: localHit.timestamp,
            pool: localHit.pool,
            note: "",
            dismissed: true,
          });
        }
        return writeLocalRaw(next);
      }

      const sharedHit = shared.find((s) => s.id === target);
      if (sharedHit) {
        const next = localRaw.filter(
          (r) => !(r.timestamp === sharedHit.timestamp && r.pool === sharedHit.pool)
        );
        next.push({
          id: `dismiss:${sharedHit.id}`,
          timestamp: sharedHit.timestamp,
          pool: sharedHit.pool,
          note: "",
          dismissed: true,
        });
        return writeLocalRaw(next);
      }

      return mergeAll(localRaw);
    },
  };
}

/**
 * 职责：解析周配额剩余%校准记录 JSON 文件的落盘路径（优先环境变量 AGY_CALIBRATIONS_FILE，默认 ~/.hamiji-sta/calibrations.json）。
 * 参数：customPath — 可选显式路径（供单测隔离）。
 * 返回值：绝对文件路径。
 */
export function resolveCalibrationStorePath(customPath?: string): string {
  if (customPath) return customPath;
  const fromEnv = process.env.AGY_CALIBRATIONS_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".hamiji-sta", "calibrations.json");
}

/**
 * 职责：归一化原始校准记录字典，过滤非法键值与超界百分比。
 * 参数：raw — JSON 反序列化结果。
 * 返回值：合法的 key -> WeeklyQuotaCalibration 映射表。
 */
function normalizeCalibrationMap(raw: unknown): Record<string, WeeklyQuotaCalibration> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, WeeklyQuotaCalibration> = {};
  for (const [rawKey, item] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim().slice(0, 160);
    if (!key || !item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const remainingPct = Number(obj.remainingPct);
    const calibratedCostUsd = Number(obj.calibratedCostUsd);
    const calibratedTokens = Number(obj.calibratedTokens);
    if (!Number.isFinite(remainingPct) || remainingPct < 0 || remainingPct >= 100) continue;
    if (!Number.isFinite(calibratedCostUsd) || calibratedCostUsd < 0) continue;
    if (!Number.isFinite(calibratedTokens) || calibratedTokens < 0) continue;
    const rawAt = typeof obj.calibratedAt === "string" ? obj.calibratedAt.trim() : "";
    const atMs = Date.parse(rawAt);
    const calibratedAt = Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : new Date().toISOString();
    out[key] = { remainingPct, calibratedCostUsd, calibratedTokens, calibratedAt };
  }
  return out;
}

/**
 * 职责：创建本地周剩余%校准快照存储实例，跨浏览器、跨端口持久保存每周满额反算基准。
 * 思路：容错读取 JSON，写入采用同目录临时文件 + rename 原子替换。
 * 参数：customPath — 可选文件路径。
 * 返回值：包含 list / set / remove 的存储对象。
 */
export function createCalibrationStore(customPath?: string) {
  const filePath = resolveCalibrationStorePath(customPath);

  const readAll = (): Record<string, WeeklyQuotaCalibration> => {
    if (!fs.existsSync(filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalizeCalibrationMap(parsed);
    } catch {
      return {};
    }
  };

  const writeAll = (
    map: Record<string, WeeklyQuotaCalibration>
  ): Record<string, WeeklyQuotaCalibration> => {
    const normalized = normalizeCalibrationMap(map);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
    return normalized;
  };

  return {
    list(): Record<string, WeeklyQuotaCalibration> {
      return readAll();
    },
    set(key: string, value: WeeklyQuotaCalibration): Record<string, WeeklyQuotaCalibration> {
      const cleanKey = key.trim().slice(0, 160);
      if (!cleanKey) throw new Error("校准键不能为空");
      if (!Number.isFinite(value.remainingPct) || value.remainingPct < 0 || value.remainingPct >= 100) {
        throw new Error("周剩余百分比必须在 0 到 99.9 之间");
      }
      if (!Number.isFinite(value.calibratedCostUsd) || value.calibratedCostUsd < 0) {
        throw new Error("校准基准成本非法");
      }
      if (!Number.isFinite(value.calibratedTokens) || value.calibratedTokens < 0) {
        throw new Error("校准基准 Token 非法");
      }
      const atMs = Date.parse(value.calibratedAt || "");
      const calibratedAt = Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : new Date().toISOString();
      const next = {
        ...readAll(),
        [cleanKey]: {
          remainingPct: value.remainingPct,
          calibratedCostUsd: value.calibratedCostUsd,
          calibratedTokens: value.calibratedTokens,
          calibratedAt,
        },
      };
      return writeAll(next);
    },
    remove(key: string): Record<string, WeeklyQuotaCalibration> {
      const cleanKey = key.trim();
      if (!cleanKey) return readAll();
      const next = readAll();
      if (!(cleanKey in next)) return next;
      delete next[cleanKey];
      return writeAll(next);
    },
  };
}

/**
 * 职责：只读解析由 scripts/statusline-bridge.mjs 写入的 ~/.hamiji-sta/live-quota.json。
 * 思路：文件不存在、解析失败或超过 7 天过期时静默返回空对象，不影响纯桌面端用户。
 * 参数：customPath — 可选显式路径（供单测隔离）。
 * 返回值：poolKey -> LivePoolQuotaSnapshot 映射。
 */
export function readLiveQuotaSnapshots(
  customPath?: string
): Record<string, LivePoolQuotaSnapshot> {
  const filePath =
    customPath ||
    process.env.AGY_LIVE_QUOTA_FILE?.trim() ||
    path.join(os.homedir(), ".hamiji-sta", "live-quota.json");
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      pools?: Record<string, Record<string, unknown>>;
    };
    if (!parsed || typeof parsed.pools !== "object" || !parsed.pools) return {};
    const out: Record<string, LivePoolQuotaSnapshot> = {};
    const cutoffMs = Date.now() - 7 * 86_400_000;
    for (const [poolKey, item] of Object.entries(parsed.pools)) {
      if (!item || typeof item !== "object") continue;
      const pct = Number(item.remainingPct);
      const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : "";
      const updMs = Date.parse(updatedAt);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
      if (!Number.isFinite(updMs) || updMs < cutoffMs) continue;
      out[poolKey] = {
        remainingPct: pct,
        resetTime: typeof item.resetTime === "string" ? item.resetTime : "",
        updatedAt: new Date(updMs).toISOString(),
      };
    }
    return out;
  } catch {
    return {};
  }
}
