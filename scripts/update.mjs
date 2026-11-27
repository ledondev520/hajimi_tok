/**
 * Input: node:child_process、node:fs、node:path、node:url 与本地 Git / npm / launchctl 命令。
 * Output: 一键安全检查与自更新脚本（npm run update / --check --json / --no-restart），按需执行 pull + install + build + 服务重启。
 * Pos: 哈吉米统计自动更新编排脚本，供命令行与服务端 /api/update 路由复用（scripts/update.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // 仓库根目录
const SERVICE_SCRIPT = path.join(ROOT, "scripts", "service.mjs"); // 常驻服务管理脚本
const LAUNCHD_LABEL = "com.hamiji.sta"; // macOS LaunchAgent 标识

/**
 * 职责：在仓库根目录同步执行子命令并返回标准输出文本（自动去除首尾空白）。
 * 参数：cmd — 可执行文件名；args — 参数列表；timeoutMs — 超时毫秒数。
 * 返回值：stdout 文本。
 */
function runText(cmd, args, timeoutMs = 15_000) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * 职责：探测当前仓库与远端上游分支的同步状态（不改动工作区）。
 * 思路：1) 校验 Git 仓库与上游分支；2) 执行 git fetch 拉取远端引用；3) 统计落后提交数、工作区脏状态与最新提交摘要。
 * 参数：无。
 * 返回值：结构化状态对象。
 */
export function checkForUpdate() {
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    return { ok: false, available: false, behindCount: 0, dirty: false, reason: "非 Git 仓库目录" };
  }

  let upstream = "";
  try {
    upstream = runText("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 5000);
  } catch {
    return { ok: false, available: false, behindCount: 0, dirty: false, reason: "未配置上游跟踪分支" };
  }

  const currentCommit = runText("git", ["rev-parse", "--short", "HEAD"], 5000);
  const dirty = Boolean(runText("git", ["status", "--porcelain"], 5000));

  try {
    runText("git", ["fetch", "--quiet"], 12_000);
  } catch (err) {
    return {
      ok: false,
      available: false,
      behindCount: 0,
      currentCommit,
      dirty,
      reason: `拉取远端失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  }

  const behindCount = Number(runText("git", ["rev-list", `HEAD..${upstream}`, "--count"], 5000)) || 0;
  const latestCommit = runText("git", ["rev-parse", "--short", upstream], 5000);
  const latestSubject = runText("git", ["log", "-1", "--format=%s", upstream], 5000);

  return {
    ok: true,
    available: behindCount > 0,
    behindCount,
    currentCommit,
    latestCommit,
    latestSubject,
    upstream,
    dirty,
  };
}

/**
 * 职责：检测 macOS LaunchAgent 常驻服务是否已注册运行。
 * 返回值：true 表示已加载需重启，false 表示未安装或非 macOS。
 */
function isLaunchdServiceLoaded() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return false;
  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid()}/${LAUNCHD_LABEL}`], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 职责：执行安全一键更新（仅工作区干净且可 fast-forward 时拉取，按实际变更文件按需执行 install / build / restart）。
 * 参数：options — { noRestart?: boolean }。
 * 返回值：结构化更新结果对象。
 */
export function performUpdate(options = {}) {
  const status = checkForUpdate();
  if (!status.ok) {
    return { ok: false, updated: false, message: status.reason || "检查更新失败", ...status };
  }
  if (!status.available) {
    return { ok: true, updated: false, message: "已是最新版本", ...status };
  }
  if (status.dirty) {
    return {
      ok: false,
      updated: false,
      message: "工作区有未提交改动，已跳过自动更新（请先提交或暂存本地修改）",
      ...status,
    };
  }

  // 1. 拉取前盘点差异文件，按需决定是否需要 npm install / vite build / 服务重启
  const diffRaw = runText("git", ["diff", "--name-only", `HEAD..${status.upstream}`], 5000);
  const changedFiles = diffRaw ? diffRaw.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const needInstall = changedFiles.some((f) => f === "package.json" || f === "package-lock.json");
  const needBuild =
    needInstall ||
    changedFiles.some(
      (f) => f.startsWith("src/") || f === "index.html" || f === "vite.config.ts" || f === "tsconfig.json"
    );
  const needRestart =
    needBuild || changedFiles.some((f) => f.startsWith("server/") || f.startsWith("scripts/"));

  // 2. 严格 fast-forward 拉取，杜绝自动合并冲突污染
  try {
    runText("git", ["pull", "--ff-only"], 20_000);
  } catch (err) {
    return {
      ok: false,
      updated: false,
      message: `git pull --ff-only 失败（本地与远端可能分叉）：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  }

  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  if (needInstall) {
    runText(npmBin, ["install", "--no-audit", "--no-fund"], 120_000);
  }
  if (needBuild) {
    runText(npmBin, ["run", "build"], 120_000);
  }

  let restarted = false;
  if (!options.noRestart && needRestart && isLaunchdServiceLoaded()) {
    runText(process.execPath, [SERVICE_SCRIPT, "restart"], 15_000);
    restarted = true;
  }

  const commit = runText("git", ["rev-parse", "--short", "HEAD"], 5000);
  const subject = runText("git", ["log", "-1", "--format=%s", "HEAD"], 5000);
  const steps = ["git pull"];
  if (needInstall) steps.push("npm install");
  if (needBuild) steps.push("npm run build");
  if (restarted) steps.push("服务重启");

  return {
    ok: true,
    updated: true,
    commit,
    subject,
    behindCount: status.behindCount,
    needInstall,
    needBuild,
    needRestart,
    restarted,
    message: `已更新至 ${commit}（${steps.join(" + ")}）`,
  };
}

// 3. CLI 入口执行
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has("--json");
  const isCheckOnly = args.has("--check");
  const noRestart = args.has("--no-restart");

  try {
    const res = isCheckOnly ? checkForUpdate() : performUpdate({ noRestart });
    if (asJson) {
      console.log(JSON.stringify(res));
    } else if (isCheckOnly) {
      console.log(
        res.available
          ? `发现 ${res.behindCount} 个新提交 (${res.currentCommit} -> ${res.latestCommit}: ${res.latestSubject})`
          : res.ok
            ? `✓ 已是最新版本 (${res.currentCommit})`
            : `✗ ${res.reason}`
      );
    } else {
      console.log(res.ok ? `✓ ${res.message}` : `✗ ${res.message}`);
    }
    if (!res.ok && !isCheckOnly) process.exit(1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (asJson) {
      console.log(JSON.stringify({ ok: false, updated: false, message: msg }));
    } else {
      console.error(`✗ 更新失败: ${msg}`);
    }
    process.exit(1);
  }
}
