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

  const readLocalStrict = (): StoredLocalResetEvent[] => {
    if (!fs.existsSync(filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `本地重置记录文件已损坏或不可读，已阻止覆盖以保留原件 (${filePath}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`本地重置记录文件格式损坏（非数组），已阻止覆盖以保留原件 (${filePath})`);
    }
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`本地重置记录第 ${i + 1} 条已损坏，已阻止覆盖以保留原件 (${filePath})`);
      }
      const obj = item as Record<string, unknown>;
      const tsMs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp.trim()) : Number.NaN;
      if (!Number.isFinite(tsMs) || tsMs <= 0) {
        throw new Error(`本地重置记录第 ${i + 1} 条时间字段无效，已阻止覆盖以保留原件 (${filePath})`);
      }
      if (!VALID_POOLS.has(obj.pool as QuotaResetEvent["pool"])) {
        throw new Error(`本地重置记录第 ${i + 1} 条配额池字段无效，已阻止覆盖以保留原件 (${filePath})`);
      }
    }
    return normalizeResetList(parsed, true);
  };

  const readLocalSafe = (): StoredLocalResetEvent[] => {
    try {
      return readLocalStrict();
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
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
    return mergeAll(normalized);
  };

  return {
    list(): QuotaResetEvent[] {
      return mergeAll(readLocalSafe());
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
      const current = readLocalStrict().filter((r) => !(r.timestamp === iso && r.pool === input.pool));
      current.push({ id: crypto.randomUUID(), timestamp: iso, pool: input.pool, note });
      return writeLocalRaw(current);
    },
    remove(id: string): QuotaResetEvent[] {
      const target = id.trim();
      const localRaw = readLocalStrict();
      if (!target) return mergeAll(localRaw);
      const shared = readShared();
      const sharedKeys = new Set(shared.map((s) => `${s.timestamp}|${s.pool}`));

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
 * 职责：严格校验单条周剩余%校准记录（禁止 null/非数字转 0%，禁止非法时间静默替换为当前时刻）。
 */
function validateCalibrationEntry(rawKey: string, item: unknown, contextLabel: string): {
  key: string;
  entry: WeeklyQuotaCalibration;
} {
  const key = rawKey.trim().slice(0, 160);
  if (!key) throw new Error(`${contextLabel}：校准键不能为空`);
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`${contextLabel}：校准条目格式非法 (${key})`);
  }
  const obj = item as Record<string, unknown>;
  if (
    typeof obj.remainingPct !== "number" ||
    !Number.isFinite(obj.remainingPct) ||
    obj.remainingPct < 0 ||
    obj.remainingPct >= 100
  ) {
    throw new Error(`${contextLabel}：周剩余百分比必须为 0 到 99.9 之间的数值 (${key})`);
  }
  if (
    typeof obj.calibratedCostUsd !== "number" ||
    !Number.isFinite(obj.calibratedCostUsd) ||
    obj.calibratedCostUsd < 0
  ) {
    throw new Error(`${contextLabel}：校准基准成本必须为非负数值 (${key})`);
  }
  if (
    typeof obj.calibratedTokens !== "number" ||
    !Number.isFinite(obj.calibratedTokens) ||
    obj.calibratedTokens < 0
  ) {
    throw new Error(`${contextLabel}：校准基准 Token 必须为非负数值 (${key})`);
  }
  const rawAt = typeof obj.calibratedAt === "string" ? obj.calibratedAt.trim() : "";
  const atMs = rawAt ? Date.parse(rawAt) : Number.NaN;
  if (!Number.isFinite(atMs) || atMs <= 0) {
    throw new Error(`${contextLabel}：校准时间无效 (${key})`);
  }
  return {
    key,
    entry: {
      remainingPct: obj.remainingPct,
      calibratedCostUsd: obj.calibratedCostUsd,
      calibratedTokens: obj.calibratedTokens,
      calibratedAt: new Date(atMs).toISOString(),
    },
  };
}

const CALIBRATION_TOMBSTONE_KEY = "__deletedAt"; // calibrations.json 内保留的删除墓碑时间戳字典键

/**
 * 职责：创建本地周剩余%校准快照存储实例，跨浏览器、跨端口持久保存每周满额反算基准。
 * 思路：1) 读写均严格校验数值类型与时间（阻断 null->0% 与伪造当前时间）；2) 单条写入按时间戳与删除墓碑保护较新校准及删除状态；3) 首次批量迁移整批预验且遇已初始化文件返回 conflict。
 * 参数：customPath — 可选文件路径。
 * 返回值：包含 readState / list / isInitialized / set / migrateBatch / remove 的存储对象。
 */
export function createCalibrationStore(customPath?: string) {
  const filePath = resolveCalibrationStorePath(customPath);

  const readDocStrict = (): {
    entries: Record<string, WeeklyQuotaCalibration>;
    deletedAt: Record<string, string>;
  } => {
    if (!fs.existsSync(filePath)) return { entries: {}, deletedAt: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `本地周校准文件已损坏或不可读，已阻止覆盖以保留原件 (${filePath}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`本地周校准文件格式损坏（非 JSON 对象），已阻止覆盖以保留原件 (${filePath})`);
    }
    const entries: Record<string, WeeklyQuotaCalibration> = {};
    const deletedAt: Record<string, string> = {};
    for (const [rawKey, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (rawKey === CALIBRATION_TOMBSTONE_KEY) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error(`本地周校准文件删除标记格式损坏，已阻止覆盖以保留原件 (${filePath})`);
        }
        for (const [dk, dv] of Object.entries(item as Record<string, unknown>)) {
          const cleanDk = dk.trim().slice(0, 160);
          const ms = typeof dv === "string" ? Date.parse(dv.trim()) : Number.NaN;
          if (!cleanDk || !Number.isFinite(ms) || ms <= 0) {
            throw new Error(`本地周校准文件删除时间戳无效 (${dk})，已阻止覆盖以保留原件 (${filePath})`);
          }
          deletedAt[cleanDk] = new Date(ms).toISOString();
        }
        continue;
      }
      const { key, entry } = validateCalibrationEntry(rawKey, item, `本地周校准文件含损坏条目 (${filePath})`);
      entries[key] = entry;
    }
    return { entries, deletedAt };
  };

  const readEntriesSafe = (): Record<string, WeeklyQuotaCalibration> => {
    try {
      return readDocStrict().entries;
    } catch {
      return {};
    }
  };

  const writeDoc = (
    entries: Record<string, WeeklyQuotaCalibration>,
    deletedAt: Record<string, string>
  ): Record<string, WeeklyQuotaCalibration> => {
    const normalized = normalizeCalibrationMap(entries);
    const payload: Record<string, unknown> = { ...normalized };
    if (Object.keys(deletedAt).length > 0) {
      payload[CALIBRATION_TOMBSTONE_KEY] = deletedAt;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
    return normalized;
  };

  return {
    isInitialized(): boolean {
      return fs.existsSync(filePath);
    },
    readState():
      | { ok: true; calibrations: Record<string, WeeklyQuotaCalibration>; initialized: boolean }
      | { ok: false; error: string } {
      const exists = fs.existsSync(filePath);
      if (!exists) return { ok: true, calibrations: {}, initialized: false };
      try {
        return { ok: true, calibrations: readDocStrict().entries, initialized: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    list(): Record<string, WeeklyQuotaCalibration> {
      return readEntriesSafe();
    },
    set(
      key: string,
      value: WeeklyQuotaCalibration,
      options?: { source?: "manual" | "auto" }
    ): Record<string, WeeklyQuotaCalibration> {
      if (key.trim() === CALIBRATION_TOMBSTONE_KEY) {
        throw new Error("周校准键名不可使用保留字");
      }
      const { key: cleanKey, entry } = validateCalibrationEntry(key, value, "周校准参数非法");
      const { entries, deletedAt } = readDocStrict();
      const nextMs = Date.parse(entry.calibratedAt);
      const existing = entries[cleanKey];
      if (existing) {
        const existingMs = Date.parse(existing.calibratedAt);
        // 服务端按时间戳保护较新校准：旧采样/迟到请求绝不覆盖较新的手工或已保存校准
        if (options?.source === "auto" ? existingMs >= nextMs : existingMs > nextMs) {
          return entries;
        }
      }
      const tombIso = deletedAt[cleanKey];
      if (tombIso) {
        const tombMs = Date.parse(tombIso);
        // 服务端按删除墓碑时间戳保护已删除状态：删除前的旧采样/迟到写入绝不重建已删键
        if (options?.source === "auto" ? tombMs >= nextMs : tombMs > nextMs) {
          return entries;
        }
        delete deletedAt[cleanKey];
      }
      return writeDoc({ ...entries, [cleanKey]: entry }, deletedAt);
    },
    migrateBatch(entriesInput: Record<string, WeeklyQuotaCalibration>): {
      conflict: boolean;
      calibrations: Record<string, WeeklyQuotaCalibration>;
    } {
      // 1. 服务端已初始化时绝不重新写入旧批次，返回冲突态与权威服务端快照以保留其他窗口的删除操作
      if (fs.existsSync(filePath)) {
        return { conflict: true, calibrations: readDocStrict().entries };
      }
      const pairs = Object.entries(entriesInput);
      if (pairs.length > 1000) {
        throw new Error("单次迁移周校准条目数超出上限（最多 1000 条）");
      }
      // 2. 整批原子预校验：任一条目不合法即整体拒绝，不落盘、不标记初始化
      const validated: Record<string, WeeklyQuotaCalibration> = {};
      for (const [rawKey, value] of pairs) {
        if (rawKey.trim() === CALIBRATION_TOMBSTONE_KEY) {
          throw new Error("批量迁移条目键名不可使用保留字");
        }
        const { key, entry } = validateCalibrationEntry(rawKey, value, "批量迁移条目非法");
        validated[key] = entry;
      }
      return { conflict: false, calibrations: writeDoc(validated, {}) };
    },
    remove(key: string, deletedAtIso?: string): Record<string, WeeklyQuotaCalibration> {
      const cleanKey = key.trim().slice(0, 160);
      const { entries, deletedAt } = readDocStrict();
      if (!cleanKey || cleanKey === CALIBRATION_TOMBSTONE_KEY) return entries;
      let delMs = Date.now();
      if (deletedAtIso !== undefined) {
        const parsedDel = Date.parse(deletedAtIso.trim());
        if (!Number.isFinite(parsedDel) || parsedDel <= 0) {
          throw new Error("无效的删除时间戳");
        }
        delMs = parsedDel;
      }
      const existing = entries[cleanKey];
      if (existing && Date.parse(existing.calibratedAt) > delMs) {
        // 迟到的旧删除请求晚于新写入版本，保留较新校准
        return entries;
      }
      delete entries[cleanKey];
      const prevTombMs = deletedAt[cleanKey] ? Date.parse(deletedAt[cleanKey]) : 0;
      if (delMs >= prevTombMs) {
        deletedAt[cleanKey] = new Date(delMs).toISOString();
      }
      return writeDoc(entries, deletedAt);
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
  customPath?: string,
  nowMs = Date.now()
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
    const cutoffMs = nowMs - 7 * 86_400_000;
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
