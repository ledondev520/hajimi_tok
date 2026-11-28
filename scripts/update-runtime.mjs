/**
 * Input: node:child_process、node:fs、node:os、node:path，封装自更新所需的环境补全、Git 探测、dist 备份恢复、launchd 状态核验、日志裁剪与 macOS 通知原语。
 * Output: 导出 buildRunEnv、inspectTrackedWorktree、queryRemoteHeadSha、backupDist/restoreDistBackup、inspectPlistOwnership、getLaunchdServiceInfo、verifyRestartedService、trimDaemonLogs 与 sendNotification。
 * Pos: 哈吉米统计自更新底层运行时原语模块（scripts/update-runtime.mjs），供 scripts/update.mjs 复用。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_EXEC_BUFFER = 10 * 1024 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const KEEP_LOG_BYTES = 256 * 1024;
const GIT_DROP_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];

export const shortSha = (sha) => String(sha || "").slice(0, 7) || "unknown";
export const redactSecrets = (text) =>
  String(text)
    .replace(/:\/\/[^/@\s]+@/g, "://***@")
    .replace(/([?&](?:access_token|private_token|refresh_token|api_key|client_secret|token|key|secret|password)=)[^&\s]+/gi, "$1***");

export function formatExecError(err) {
  if (!err || typeof err !== "object") return redactSecrets(err);
  const out = (typeof err.stderr === "string" && err.stderr.trim()) || (typeof err.stdout === "string" && err.stdout.trim()) || "";
  const raw = out || err.message || String(err);
  return redactSecrets(raw).replace(/\r?\n+/g, " | ").slice(0, 300);
}

export function runText(cmd, args, timeoutMs = 15_000, cwd = process.cwd(), env = process.env) {
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_EXEC_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export const gitExec = (args, cwd, env, timeoutMs = 15_000) =>
  runText("git", ["-c", "core.quotepath=false", ...args], timeoutMs, cwd, env);

/** 构造干净子进程环境：补全当前 Node/Homebrew PATH、禁用交互提示、尊重既有 core.sshCommand 并默认 SSH BatchMode=yes。 */
export function buildRunEnv(repoRoot) {
  const env = { ...process.env };
  for (const key of GIT_DROP_ENV_KEYS) delete env[key];
  const nodeBinDir = path.dirname(process.execPath);
  const fallbacks = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const fallbackSet = new Set(fallbacks);
  const rawParts = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const parts = [];
  for (const p of rawParts) {
    if (!parts.includes(p)) parts.push(p);
  }
  const curNodeIdx = parts.indexOf(nodeBinDir);
  const firstSysIdx = parts.findIndex((p) => fallbackSet.has(p));
  if (curNodeIdx < 0) {
    if (firstSysIdx >= 0) parts.splice(firstSysIdx, 0, nodeBinDir);
    else parts.push(nodeBinDir);
  } else if (firstSysIdx >= 0 && curNodeIdx > firstSysIdx) {
    parts.splice(curNodeIdx, 1);
    parts.splice(firstSysIdx, 0, nodeBinDir);
  }
  for (const fallback of fallbacks) {
    if (!parts.includes(fallback)) parts.push(fallback);
  }
  env.PATH = parts.join(path.delimiter);
  if (!env.HOME) env.HOME = os.homedir();
  const prevNodeOpts = (env.NODE_OPTIONS || "").trim();
  env.NODE_OPTIONS = prevNodeOpts.includes("--no-warnings") ? prevNodeOpts : [prevNodeOpts, "--no-warnings"].filter(Boolean).join(" ");
  env.GIT_TERMINAL_PROMPT = "0";
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    let customSsh = "";
    try { customSsh = gitExec(["config", "--get", "core.sshCommand"], repoRoot, env, 5000); } catch { /* 未配置 */ }
    if (!customSsh) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=15";
  }
  return env;
}

/** 对守护日志执行按尾部定长读取的体积裁剪，防长期常驻无界增长。 */
export function trimDaemonLogs(repoRoot) {
  const logDir = path.join(repoRoot, "logs");
  for (const name of ["daemon.out.log", "daemon.err.log"]) {
    const file = path.join(logDir, name);
    try {
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      if (size <= MAX_LOG_BYTES) continue;
      const readLen = Math.min(size, KEEP_LOG_BYTES);
      const buf = Buffer.allocUnsafe(readLen);
      const fd = fs.openSync(file, "r");
      let bytesRead = 0;
      try { bytesRead = fs.readSync(fd, buf, 0, readLen, size - readLen); } finally { fs.closeSync(fd); }
      let tail = buf.subarray(0, bytesRead);
      const nl = tail.indexOf(0x0a);
      if (nl >= 0 && nl + 1 < tail.length) tail = tail.subarray(nl + 1);
      fs.writeFileSync(file, tail);
    } catch { /* 单文件裁剪异常不阻塞更新 */ }
  }
}

export function detectInProgressGitOp(repoRoot, env) {
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
    try {
      const p = gitExec(["rev-parse", "--git-path", marker], repoRoot, env, 5000);
      if (fs.existsSync(path.isAbsolute(p) ? p : path.resolve(repoRoot, p))) return marker;
    } catch { /* 忽略探测异常 */ }
  }
  return null;
}

function assertSafeGitName(label, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.startsWith("-") || /[\s\x00-\x1f\x7f~^:?*[\]\\]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`非法${label}: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** 解析当前分支与配置的上游远端/分支名（兼容含斜杠分支；本地 `.` 追踪或未配置返回 null）。 */
export function resolveUpstreamTarget(repoRoot, env) {
  let currentBranch = "";
  try { currentBranch = gitExec(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot, env, 5000); } catch { return null; }
  if (!currentBranch) return null;

  let remote = "";
  let branch = "";
  try { remote = gitExec(["config", "--get", `branch.${currentBranch}.remote`], repoRoot, env, 5000); } catch { return null; }
  if (!remote || remote === ".") return null;
  try {
    const mergeRef = gitExec(["config", "--get", `branch.${currentBranch}.merge`], repoRoot, env, 5000);
    if (mergeRef.startsWith("refs/heads/")) branch = mergeRef.slice("refs/heads/".length);
  } catch {
    return null;
  }
  if (!branch) return null;

  try {
    const safeRemote = assertSafeGitName("远程名", remote);
    const safeBranch = assertSafeGitName("上游分支名", branch);
    return {
      currentBranch,
      remote: safeRemote,
      branch: safeBranch,
      upstream: `${safeRemote}/${safeBranch}`,
      trackingRef: `refs/remotes/${safeRemote}/${safeBranch}`,
    };
  } catch {
    return null;
  }
}

/** 仅检查已追踪文件改动（不误拦截未跟踪临时文件），并区分未暂存 package-lock.json 漂移。 */
export function inspectTrackedWorktree(repoRoot, env) {
  const raw = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=no", "-z"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: MAX_EXEC_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!raw) return { blockingFiles: [], lockfileDriftOnly: false };
  const tokens = raw.split("\0");
  const blockingFiles = [];
  let hasUnstagedLockfile = false;

  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (status.includes("R") || status.includes("C")) i++;
    if (status === " M" && filePath === "package-lock.json") hasUnstagedLockfile = true;
    else blockingFiles.push(`${status.trim() || "?"}:${filePath}`);
  }
  return { blockingFiles, lockfileDriftOnly: hasUnstagedLockfile && blockingFiles.length === 0 };
}

export function restoreLockfileDriftIfOnlyDirty(repoRoot, env) {
  if (!inspectTrackedWorktree(repoRoot, env).lockfileDriftOnly) return false;
  gitExec(["checkout", "--", "package-lock.json"], repoRoot, env, 10_000);
  return true;
}

export function isAncestor(commitA, commitB, repoRoot, env) {
  try {
    gitExec(["merge-base", "--is-ancestor", commitA, commitB], repoRoot, env, 10_000);
    return true;
  } catch {
    return false;
  }
}

export function queryRemoteHeadSha(remote, branch, repoRoot, env) {
  const fullRef = `refs/heads/${branch}`;
  const out = gitExec(["ls-remote", "--heads", "--", remote, fullRef], repoRoot, env, 15_000);
  for (const line of out.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === fullRef && /^[0-9a-f]{40}$/i.test(sha || "")) return sha;
  }
  return null;
}

const unescapeXml = (v) =>
  String(v).replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

function normalizeRealPath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** 核验 launchd plist 归属当前仓库目录，防止多副本越权接管他人常驻服务，并识别旧版缺少 PATH/HOME 的 plist。 */
export function inspectPlistOwnership(repoRoot, label) {
  const launchAgentsDir = path.resolve(process.env.HAJIMI_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library/LaunchAgents"));
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  if (!fs.existsSync(plistPath)) {
    return { exists: false, ownedBySelf: false, ownedByOther: false, needsMigration: false };
  }
  try {
    const xml = fs.readFileSync(plistPath, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const wdMatch = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
    const wd = wdMatch ? unescapeXml(wdMatch[1]).trim() : "";
    const ownedBySelf = Boolean(wd) && normalizeRealPath(wd) === normalizeRealPath(repoRoot);
    const ownedByOther = Boolean(wd) && !ownedBySelf;
    const needsMigration = ownedBySelf && (!xml.includes("<key>PATH</key>") || !xml.includes("<key>HOME</key>"));
    return { exists: true, ownedBySelf, ownedByOther, needsMigration };
  } catch {
    return { exists: true, ownedBySelf: false, ownedByOther: false, needsMigration: false };
  }
}

/** 查询 launchd 服务加载状态与正整数 PID（严格以 exit 113 判定未找到，其余非 0 按错误处理）。 */
export function getLaunchdServiceInfo(label, env) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return { loaded: false, pid: null, error: null };
  }
  const target = `gui/${process.getuid()}/${label}`;
  try {
    const out = execFileSync("launchctl", ["print", target], { env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    const match = out.match(/^\s*pid\s*=\s*([1-9]\d*)\s*$/m);
    return { loaded: true, pid: match ? Number(match[1]) : null, error: null };
  } catch (err) {
    const status = err && typeof err === "object" ? err.status : null;
    if (status === 113) return { loaded: false, pid: null, error: null };
    return { loaded: false, pid: null, error: formatExecError(err) };
  }
}

/** 备份现有 dist 目录（失败抛出错误，保障构建失败后可原子恢复旧页面产物）。 */
export function backupDist(repoRoot, stateDir) {
  const distDir = path.join(repoRoot, "dist");
  const backupDir = path.join(stateDir, `.dist-backup-${process.pid}`);
  const hadDistBefore = fs.existsSync(distDir);
  if (hadDistBefore) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
    try {
      fs.cpSync(distDir, backupDir, { recursive: true });
    } catch (err) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* 清理半成品备份失败忽略 */ }
      throw err;
    }
  }
  return { distDir, backupDir, hadDistBefore };
}

/** 安全还原 dist 备份：优先同卷原子 rename，遇跨挂载点 EXDEV 时先复原在线 dist 并在同目录暂存拷贝完成后原子切换。 */
export function restoreDistBackup(distDir, backupDir, hadDistBefore) {
  if (!hadDistBefore) {
    fs.rmSync(distDir, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(backupDir)) throw new Error(`缺少 dist 备份目录: ${backupDir}`);
  const brokenDir = `${distDir}.broken.${process.pid}`;
  const stageDir = `${distDir}.restore.${process.pid}`;
  let movedBroken = false;
  try {
    fs.rmSync(brokenDir, { recursive: true, force: true });
    if (fs.existsSync(distDir)) {
      fs.renameSync(distDir, brokenDir);
      movedBroken = true;
    }
    try {
      fs.renameSync(backupDir, distDir);
    } catch (renameErr) {
      if (!renameErr || typeof renameErr !== "object" || renameErr.code !== "EXDEV") throw renameErr;
      if (movedBroken && !fs.existsSync(distDir)) {
        fs.renameSync(brokenDir, distDir);
        movedBroken = false;
      }
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.cpSync(backupDir, stageDir, { recursive: true });
      if (fs.existsSync(distDir)) {
        fs.renameSync(distDir, brokenDir);
        movedBroken = true;
      }
      fs.renameSync(stageDir, distDir);
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* 清理跨卷原备份失败不影响已恢复 dist */ }
    }
  } catch (err) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (movedBroken && !fs.existsSync(distDir)) {
      try { fs.renameSync(brokenDir, distDir); } catch { /* 保留现场 */ }
    }
    throw err;
  }
  if (movedBroken) fs.rmSync(brokenDir, { recursive: true, force: true });
}

/** 重启后异步核验 launchd 新 PID 切换与本地 /api/health 就绪，杜绝旧进程 HTTP 200 假阳性。 */
export async function verifyRestartedService(oldPid, label, env) {
  if (process.platform !== "darwin") return { ok: true, pid: null };
  const healthUrl = process.env.HAJIMI_HEALTH_URL || "http://127.0.0.1:4318/api/health";
  const pidRetries = Math.max(1, Number.parseInt(process.env.HAJIMI_PID_WAIT_RETRIES || "25", 10) || 25);
  const healthRetries = Math.max(1, Number.parseInt(process.env.HAJIMI_HEALTH_RETRIES || "15", 10) || 15);
  const delayMs = Math.max(50, Number.parseInt(process.env.HAJIMI_HEALTH_DELAY_MS || "400", 10) || 400);
  const timeoutMs = Math.max(500, Number.parseInt(process.env.HAJIMI_HEALTH_TIMEOUT_MS || "4000", 10) || 4000);

  let newPid = null;
  for (let i = 0; i < pidRetries; i++) {
    const info = getLaunchdServiceInfo(label, env);
    if (info.error) return { ok: false, pid: null, reason: `探查服务 PID 失败: ${info.error}` };
    if (info.loaded && info.pid !== null && (oldPid === null || info.pid !== oldPid)) {
      newPid = info.pid;
      break;
    }
    if (i + 1 < pidRetries) await new Promise((r) => setTimeout(r, Math.min(delayMs, 200)));
  }
  if (newPid === null) return { ok: false, pid: null, reason: `重启后未观测到新进程 PID（旧 PID=${oldPid ?? "none"}）` };

  let healthy = false;
  for (let i = 0; i < healthRetries; i++) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const body = await res.json();
        if (body && typeof body === "object") { healthy = true; break; }
      }
    } catch { /* 重试 */ }
    if (i + 1 < healthRetries) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!healthy) return { ok: false, pid: newPid, reason: `健康探针 ${redactSecrets(healthUrl)} 在重启后未就绪（新 PID=${newPid}）` };

  const after = getLaunchdServiceInfo(label, env);
  if (after.error || !after.loaded || after.pid !== newPid) {
    return { ok: false, pid: newPid, reason: `探活通过后新进程 PID=${newPid} 未保持存活（当前=${after.pid ?? "none"}）` };
  }
  return { ok: true, pid: newPid };
}

/** 通过 osascript argv 安全发送 macOS 桌面通知（严禁脚本字符串拼接）。 */
export function sendNotification(enabled, title, subtitle, body, env) {
  if (!enabled || process.platform !== "darwin") return;
  const safeBody = String(body || "").replace(/\r?\n+/g, " ").trim().slice(0, 200);
  try {
    execFileSync(
      "osascript",
      [
        "-e", "on run argv",
        "-e", "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
        "-e", "end run",
        "--", safeBody, String(title), String(subtitle),
      ],
      { env, timeout: 5000, stdio: "ignore" },
    );
  } catch { /* 无图形会话或通知权限受限时静默忽略 */ }
}
