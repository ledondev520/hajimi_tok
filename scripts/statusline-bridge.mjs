/**
 * Input: Antigravity CLI (agy) 官方 statusLine 机制通过 stdin 推送的会话状态 JSON（含 quota.remaining_fraction 与 reset_time）。
 * Output: 将官方精确周剩余配额原子落盘至 ~/.hamiji-sta/live-quota.json 供本地看板自动读取；支持 --install 自动检测本机 agy 并无侵入配置。
 * Pos: 可选 agy CLI 官方 statusLine 桥接脚本，无 agy 时零侵入零运行（scripts/statusline-bridge.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
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

/**
 * 职责：将 JSON 对象通过同目录临时文件原子落盘，避免读写并发看到半截内容。
 * 参数：filePath — 目标文件路径；data — 待序列化对象。
 */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * 职责：检测本机是否安装了官方 agy CLI 或存在其配置目录。
 * 返回值：true 表示检测到 agy 环境，false 表示纯桌面端环境。
 */
function hasAgyCli() {
  if (fs.existsSync(AGY_CLI_DIR)) return true;
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

/**
 * 职责：在检测到本机存在 agy CLI 且未占用自定义 statusLine 时，无侵入注册官方 statusLine 桥接配置。
 * 思路：设置 stack_with_default: true 保留官方默认状态栏；若用户已有自定义命令则不覆盖。
 * 返回值：{ installed: boolean; reason: string }。
 */
export function installAgyStatuslineHook() {
  if (!hasAgyCli()) {
    return { installed: false, reason: "未检测到 agy CLI，已跳过（桌面端可继续手动填周剩%）" };
  }
  let settings = {};
  if (fs.existsSync(AGY_SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(AGY_SETTINGS_PATH, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed;
      }
    } catch {
      return { installed: false, reason: "antigravity-cli/settings.json 解析失败，已跳过防覆盖" };
    }
  }
  const existingCmd =
    settings.statusLine && typeof settings.statusLine === "object"
      ? String(settings.statusLine.command || "").trim()
      : "";
  if (existingCmd && !existingCmd.includes("statusline-bridge.mjs")) {
    return { installed: false, reason: "检测到已有自定义 statusLine，未覆盖" };
  }

  settings.statusLine = {
    type: "command",
    command: `"${process.execPath}" "${SCRIPT_PATH}"`,
    enabled: true,
    stack_with_default: true,
  };
  writeJsonAtomic(AGY_SETTINGS_PATH, settings);
  return { installed: true, reason: `已接入 agy 官方 statusLine (${AGY_SETTINGS_PATH})` };
}

/**
 * 职责：从 agy 官方 statusLine JSON 中提取各配额池的 7d 周剩余百分比与重置时刻。
 * 参数：payload — stdin 解析出的 JSON 对象。
 * 返回值：poolKey -> 配额快照的字典（无有效 quota 时返回 null）。
 */
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
    else if (lower.includes("claude") || lower.includes("anthropic") || lower.includes("gpt")) {
      poolKey = "pool:claude";
    }
    if (!poolKey) continue;

    const frac = Number(entry.remaining_fraction);
    if (!Number.isFinite(frac) || frac < 0 || frac > 1) continue;
    const remainingPct = Math.round(frac * 1000) / 10;
    const resetTime = typeof entry.reset_time === "string" ? entry.reset_time : "";
    const resetInSeconds = Number.isFinite(Number(entry.reset_in_seconds))
      ? Number(entry.reset_in_seconds)
      : 0;
    pools[poolKey] = { remainingPct, resetTime, resetInSeconds, bucketId };
  }
  return Object.keys(pools).length > 0 ? pools : null;
}

/**
 * 职责：读取 stdin JSON 并增量合并写入 ~/.hamiji-sta/live-quota.json。
 */
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

  let prevPools = {};
  if (fs.existsSync(LIVE_QUOTA_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(LIVE_QUOTA_PATH, "utf8"));
      if (prev && typeof prev.pools === "object" && prev.pools) prevPools = prev.pools;
    } catch {
      prevPools = {};
    }
  }
  const nowIso = new Date().toISOString();
  const merged = { ...prevPools };
  for (const [k, v] of Object.entries(incomingPools)) {
    merged[k] = { ...v, updatedAt: nowIso };
  }
  writeJsonAtomic(LIVE_QUOTA_PATH, { updatedAt: nowIso, pools: merged });
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;

if (isDirectRun) {
  if (process.argv.includes("--install")) {
    const res = installAgyStatuslineHook();
    console.log(res.installed ? `✓ ${res.reason}` : `· ${res.reason}`);
  } else {
    void ingestFromStdin().catch(() => undefined);
  }
}
