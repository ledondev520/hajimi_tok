/**
 * Input: node:child_process、node:fs、node:os、node:path，编排本机一键手动更新。
 * Output: 提供精简安全的 npm run update 流程（检查工作区干净 -> git pull --ff-only -> 锁文件变化时 npm ci -> npm run build -> 若本仓注册了常驻服务则重启）。
 * Pos: 轻量手动更新脚本（scripts/update.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(process.env.HAJIMI_ROOT || path.resolve(import.meta.dirname, ".."));
const LABEL = process.env.HAJIMI_SERVICE_LABEL || "com.hamiji.sta";
const LAUNCH_AGENTS_DIR = path.resolve(
  process.env.HAJIMI_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library/LaunchAgents")
);
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const SERVICE_SCRIPT = path.join(ROOT, "scripts", "service.mjs");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function isOwnedPlist() {
  if (process.platform !== "darwin" || !fs.existsSync(PLIST_PATH)) return false;
  try {
    const xml = fs.readFileSync(PLIST_PATH, "utf8");
    const m = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
    if (!m) return false;
    return fs.realpathSync(m[1].trim()) === fs.realpathSync(ROOT);
  } catch {
    return false;
  }
}

export function main() {
  const dirty = run("git", ["status", "--porcelain", "-uno"], { capture: true }).trim();
  if (dirty) {
    console.error("工作区存在未提交改动，已跳过更新（请先 commit 或 stash）：\n" + dirty);
    process.exit(1);
  }

  const beforeHead = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
  run("git", ["pull", "--ff-only"]);
  const afterHead = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();

  if (beforeHead === afterHead) {
    console.log(`已是最新（${afterHead.slice(0, 7)}），无需更新。`);
    return;
  }

  const changed = run("git", ["diff", "--name-only", beforeHead, afterHead], { capture: true })
    .split(/\r?\n/)
    .filter(Boolean);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  if (changed.includes("package-lock.json") || changed.includes("package.json")) {
    run(npmCmd, ["ci"]);
  }
  run(npmCmd, ["run", "build"]);

  if (isOwnedPlist() && fs.existsSync(SERVICE_SCRIPT)) {
    run(process.execPath, [SERVICE_SCRIPT, "restart"]);
  }
  console.log(`已更新 ${beforeHead.slice(0, 7)} -> ${afterHead.slice(0, 7)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
