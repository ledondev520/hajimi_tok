/**
 * Input: Antigravity CLI (agy) 官方 statusLine 机制通过 stdin 推送的会话状态 JSON（含 quota.remaining_fraction 与 reset_time）。
 * Output: 在带唯一归属校验的跨进程锁与唯一临时文件保护下将官方精确周剩余配额原子落盘至 ~/.hamiji-sta/live-quota.json；支持 --install 精确无侵入配置。
 * Pos: 可选 agy CLI 官方 statusLine 桥接脚本，无 agy 时零侵入零运行（scripts/statusline-bridge.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const AGY_CLI_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const AGY_SETTINGS_PATH = path.join(AGY_CLI_DIR, "settings.json");
const LIVE_QUOTA_PATH =
  process.env.AGY_LIVE_QUOTA_FILE?.trim() ||
  path.join(os.homedir(), ".hamiji-sta", "live-quota.json");
const OWNED_STATUSLINE_KEYS = new Set(["type", "command", "enabled", "stack_with_default"]);
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const CORRUPT_LOCK_STALE_MS = 10_000;

/** 使用进程+随机唯一临时文件原子落盘 JSON */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

/** 判断进程是否仍存活 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && typeof err === "object" && err.code === "EPERM");
  }
}

/** 读取文件稳定身份指纹（dev:ino:mtimeMs:size） */
function getFileIdentity(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { id: `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** 读取锁文件归属元数据（非法/缺失 PID 归一化为 0，避免 NaN 自比不等） */
function readLockMeta(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rawPid = Number(parsed.pid);
      const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : 0;
      const token = typeof parsed.token === "string" ? parsed.token : "";
      return { pid, token, corrupt: pid === 0 };
    }
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return null;
  }
  return { pid: 0, token: "", corrupt: true };
}

/** 判定现有锁是否可安全回收：存活 PID 永不回收；仅死进程或超龄损坏锁可回收 */
function isLockReapable(lockPath, meta) {
  if (!meta) return false;
  if (!meta.corrupt && meta.pid > 0) return !isPidAlive(meta.pid);
  const ident = getFileIdentity(lockPath);
  return Boolean(ident && Date.now() - ident.mtimeMs > CORRUPT_LOCK_STALE_MS);
}

/** 释放带唯一 token 校验的锁文件 */
function releaseTokenFile(filePath, expectedToken) {
  const cur = readLockMeta(filePath);
  if (cur && cur.token === expectedToken) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

/** 仅当持有人已退出或损坏锁超龄时，通过带唯一 token 的 .reap 原子锁二次核验文件身份后回收 */
function tryReapDeadLock(lockPath) {
  const ident = getFileIdentity(lockPath);
  const cur = readLockMeta(lockPath);
  if (!ident || !cur || !isLockReapable(lockPath, cur)) return false;

  const reapPath = `${lockPath}.reap`;
  const reapToken = `reap:${process.pid}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
  let acquiredReap = false;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(reapPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: reapToken, startedAt: Date.now() }), "utf8");
      fs.closeSync(fd);
      acquiredReap = true;
      break;
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "EEXIST") return false;
      if (i === 0) {
        const rIdent = getFileIdentity(reapPath);
        const rm = readLockMeta(reapPath);
        const reapDead =
          (rm && !rm.corrupt && rm.pid > 0 && !isPidAlive(rm.pid)) ||
          Boolean(rm && rm.corrupt && rIdent && Date.now() - rIdent.mtimeMs > CORRUPT_LOCK_STALE_MS);
        if (reapDead && rIdent && getFileIdentity(reapPath)?.id === rIdent.id) {
          try {
            fs.unlinkSync(reapPath);
            continue;
          } catch {
            return false;
          }
        }
      }
      return false;
    }
  }
  if (!acquiredReap) return false;

  try {
    const afterIdent = getFileIdentity(lockPath);
    if (!afterIdent || afterIdent.id !== ident.id) return false;
    const recheck = readLockMeta(lockPath);
    if (!recheck || !isLockReapable(lockPath, recheck)) return false;
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    releaseTokenFile(reapPath, reapToken);
  }
}

/**
 * 职责：以带唯一归属令牌的跨进程文件锁保护读写合并临界区，防止并发进程丢池数据或误删他进程新锁。
 */
function withFileLock(targetPath, fn) {
  const lockPath = `${targetPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const myToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
  let acquired = false;
  for (let i = 0; i < 40; i++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: myToken, startedAt: Date.now() }), "utf8");
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "EEXIST") throw err;
      if (tryReapDeadLock(lockPath)) continue;
      Atomics.wait(SLEEP_BUF, 0, 0, 15);
    }
  }
  if (!acquired) {
    throw new Error(`等待配额快照锁超时: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    releaseTokenFile(lockPath, myToken);
  }
}

/** 检测本机是否安装了官方 agy CLI 或存在其配置目录 */
function hasAgyCli(agyDir = AGY_CLI_DIR) {
  if (fs.existsSync(agyDir)) return true;
  if (fs.existsSync(path.join(os.homedir(), ".local", "bin", "agy"))) return true;
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["agy"], {
      stdio: "ignore",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 判断现有 settings.statusLine 是否严格属于本桥接脚本 */
function isOwnedStatusLineConfig(existing, expectedCmd) {
  if (existing === undefined) return true;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const keys = Object.keys(existing);
  if (keys.some((k) => !OWNED_STATUSLINE_KEYS.has(k))) return false;
  return typeof existing.command === "string" && existing.command.trim() === expectedCmd;
}

/** 在检测到本机存在 agy CLI 且未占用自定义 statusLine 时，无侵入注册官方 statusLine 桥接配置 */
export function installAgyStatuslineHook(options = {}) {
  const agyDir = options.agyDir || AGY_CLI_DIR;
  const settingsPath = options.settingsPath || AGY_SETTINGS_PATH;
  const expectedCmd = options.expectedCmd || `"${process.execPath}" "${SCRIPT_PATH}"`;

  if (!options.agyDir && !hasAgyCli(agyDir)) {
    return { installed: false, reason: "未检测到 agy CLI，已跳过（桌面端可继续手动填周剩%）" };
  }
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { installed: false, reason: "antigravity-cli/settings.json 根节点非对象，已跳过防覆盖" };
      }
      settings = parsed;
    } catch {
      return { installed: false, reason: "antigravity-cli/settings.json 解析失败，已跳过防覆盖" };
    }
  }
  if (!isOwnedStatusLineConfig(settings.statusLine, expectedCmd)) {
    return { installed: false, reason: "检测到已有自定义或未知格式的 statusLine 配置，未覆盖" };
  }

  settings.statusLine = {
    type: "command",
    command: expectedCmd,
    enabled: true,
    stack_with_default: true,
  };
  writeJsonAtomic(settingsPath, settings);
  return { installed: true, reason: `已接入 agy 官方 statusLine (${settingsPath})` };
}

/** 从 agy 官方 statusLine JSON 中提取各配额池的 7d 周剩余百分比与重置时刻 */
export function extractWeeklyQuotaPools(payload) {
  const quota = payload && typeof payload === "object" ? payload.quota : null;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;

  const pools = {};
  for (const [bucketId, entry] of Object.entries(quota)) {
    if (!entry || typeof entry !== "object") continue;
    const lower = bucketId.toLowerCase();
    const isWeekly = lower.includes("week") || lower.includes("7d");
    if (!isWeekly) continue;

    let poolKey = "";
    if (lower.includes("gemini")) poolKey = "pool:gemini";
    else if (
      /(^|[-_])3p([-_]|$)/.test(lower) ||
      lower.includes("claude") ||
      lower.includes("anthropic") ||
      lower.includes("gpt")
    ) {
      poolKey = "pool:claude";
    }
    if (!poolKey) continue;

    const rawFrac = entry.remaining_fraction;
    if (typeof rawFrac !== "number" || !Number.isFinite(rawFrac) || rawFrac < 0 || rawFrac > 1) {
      continue;
    }
    const remainingPct = Math.round(rawFrac * 1000) / 10;
    const resetTime = typeof entry.reset_time === "string" ? entry.reset_time : "";
    const resetInSeconds =
      typeof entry.reset_in_seconds === "number" && Number.isFinite(entry.reset_in_seconds)
        ? entry.reset_in_seconds
        : 0;
    pools[poolKey] = { remainingPct, resetTime, resetInSeconds, bucketId };
  }
  return Object.keys(pools).length > 0 ? pools : null;
}

/** 从 agy 官方 statusLine JSON 中提取当前登录邮箱（小写归一化，仅本地用于同账号多目录归并，不外传） */
export function extractAccountEmail(payload) {
  const raw = payload && typeof payload === "object" ? payload.email : "";
  if (typeof raw !== "string") return "";
  const cleaned = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : "";
}

/** 在跨进程文件锁保护下增量合并写入 live-quota.json */
export function mergeLiveQuotaFile(filePath, incomingPools, accountEmail = "") {
  return withFileLock(filePath, () => {
    let prevPools = {};
    let prevEmail = "";
    if (fs.existsSync(filePath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (prev && typeof prev.accountEmail === "string") {
          prevEmail = prev.accountEmail.trim().toLowerCase();
        }
        if (prev && typeof prev.pools === "object" && prev.pools && !Array.isArray(prev.pools)) {
          prevPools = prev.pools;
        }
      } catch {
        prevPools = {};
      }
    }
    const cleanEmail = typeof accountEmail === "string" ? accountEmail.trim().toLowerCase() : "";
    const resolvedEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) ? cleanEmail : prevEmail;
    // 若系统钥匙串切换了登录账号，清空旧账号残留配额池防止串号
    const basePools = resolvedEmail && prevEmail && resolvedEmail !== prevEmail ? {} : prevPools;
    const nowIso = new Date().toISOString();
    const merged = { ...basePools };
    for (const [k, v] of Object.entries(incomingPools)) {
      merged[k] = { ...v, updatedAt: nowIso };
    }
    const doc = {
      updatedAt: nowIso,
      ...(resolvedEmail ? { accountEmail: resolvedEmail } : {}),
      pools: merged,
    };
    writeJsonAtomic(filePath, doc);
    return doc;
  });
}

/** 读取 stdin JSON 并序列化合并写入 ~/.hamiji-sta/live-quota.json */
async function ingestFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const incomingPools = extractWeeklyQuotaPools(payload);
  if (!incomingPools) return;
  const accountEmail = extractAccountEmail(payload);
  mergeLiveQuotaFile(LIVE_QUOTA_PATH, incomingPools, accountEmail);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;

if (isDirectRun) {
  if (process.argv.includes("--install")) {
    const res = installAgyStatuslineHook();
    console.log(res.installed ? `✓ ${res.reason}` : `· ${res.reason}`);
  } else {
    ingestFromStdin().catch((err) => {
      console.error(`[statusline-bridge] 写入配额快照失败: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
  }
}
