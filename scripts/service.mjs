/**
 * Input: node:child_process、node:fs、node:os、node:path，管理 macOS launchd 用户级 LaunchAgent。
 * Output: 提供 install / restart / stop / status 子命令，使本地 4318 统计服务开机自启、崩溃自愈，并在 install 时无侵入自动接入 agy statusLine 与 400K 压缩软提醒 Hook。
 * Pos: macOS 常驻守护进程编排脚本（scripts/service.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL = "com.hamiji.sta"; // launchd 服务唯一标识
const ROOT = path.resolve(import.meta.dirname, ".."); // 项目根目录绝对路径
const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`); // 用户级 LaunchAgent 路径
const LOG_DIR = path.join(ROOT, "logs"); // 常驻服务标准输出与错误日志目录
const UID = typeof process.getuid === "function" ? process.getuid() : 501; // 当前登录用户 UID
const DOMAIN_TARGET = `gui/${UID}`; // macOS GUI 会话 launchd 域
const SERVICE_TARGET = `${DOMAIN_TARGET}/${LABEL}`; // 完整 launchd 服务目标名

/**
 * 职责：生成绑定当前 Node 运行时与项目路径的 LaunchAgent plist XML 文本。
 * 参数：无。
 * 返回值：标准 Apple PropertyList 1.0 XML 字符串。
 */
function buildPlistXml() {
  // 0. 直接使用当前 Node 可执行文件调用本地 tsx CLI，避免额外 shell 包装层
  const nodeBin = process.execPath;
  const tsxCli = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
  const entryFile = path.join(ROOT, "server/index.ts");
  const outLog = path.join(LOG_DIR, "daemon.out.log");
  const errLog = path.join(LOG_DIR, "daemon.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>--no-warnings</string>
    <string>${tsxCli}</string>
    <string>${entryFile}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_OPTIONS</key>
    <string>--no-warnings</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
</dict>
</plist>
`;
}

/**
 * 职责：忽略未加载异常地卸载已有同名 LaunchAgent，并等待 launchd 完成句柄回收。
 * 参数：无。
 * 返回值：Promise<void>。
 */
async function bootoutQuietly() {
  // 0. 若旧实例存在则先行卸载，并轮询等待卸载完成防 bootstrap I/O 竞态
  try {
    execFileSync("launchctl", ["bootout", SERVICE_TARGET], { stdio: "ignore" });
  } catch {
    // 尚未注册时忽略退出码
  }
  for (let i = 0; i < 15; i++) {
    try {
      execFileSync("launchctl", ["print", SERVICE_TARGET], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      break;
    }
  }
}

/**
 * 职责：根据命令行动作执行常驻服务安装、重启、停止或状态探活。
 * 参数：action — 子命令名称（install | restart | stop | status）。
 * 返回值：Promise<void>。
 */
async function main(action) {
  // 1.1. 安装或更新并立即启动常驻守护
  if (action === "install") {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, buildPlistXml(), "utf8");
    await bootoutQuietly();
    execFileSync("launchctl", ["bootstrap", DOMAIN_TARGET, PLIST_PATH], { stdio: "inherit" });
    execFileSync("launchctl", ["kickstart", "-k", SERVICE_TARGET], { stdio: "inherit" });
    await new Promise((r) => setTimeout(r, 600));
    console.log(`✓ 已注册并启动常驻服务 ${LABEL} (${PLIST_PATH})`);
    // 1.1.1. 若本机装有 agy CLI，顺手无侵入接入官方 statusLine 配额桥接（无 agy 时静默跳过）
    try {
      execFileSync(process.execPath, [path.join(ROOT, "scripts", "statusline-bridge.mjs"), "--install"], {
        stdio: "inherit",
        timeout: 5000,
      });
    } catch {
      /* 桥接安装失败不影响常驻服务启动 */
    }
    // 1.1.2. 若本机存在 ~/.gemini 配置目录且未显式跳过，自动无侵入注册 400K 上下文压缩软提醒 Hook（保留已有 Hook，可随时 hook:compact:uninstall 卸载）
    if (process.env.AGY_SKIP_COMPACT_HOOK !== "1" && fs.existsSync(path.join(os.homedir(), ".gemini"))) {
      try {
        execFileSync(process.execPath, [path.join(ROOT, "scripts", "compact-reminder-hook.mjs"), "--install"], {
          stdio: "inherit",
          timeout: 5000,
        });
      } catch {
        /* 压缩提醒 Hook 安装失败不影响常驻服务启动 */
      }
    }
    return;
  }

  // 1.2. 原地热重启常驻进程
  if (action === "restart") {
    execFileSync("launchctl", ["kickstart", "-k", SERVICE_TARGET], { stdio: "inherit" });
    await new Promise((r) => setTimeout(r, 600));
    console.log(`✓ 已重启常驻服务 ${LABEL}`);
    return;
  }

  // 1.3. 停止并移除开机常驻
  if (action === "stop") {
    await bootoutQuietly();
    if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
    console.log(`✓ 已停止并卸载常驻服务 ${LABEL}`);
    return;
  }

  // 1.4. 默认查询 launchd 存活状态与本地 4318 健康接口
  try {
    const out = execFileSync("launchctl", ["print", SERVICE_TARGET], { encoding: "utf8" });
    const pidLine = out.split("\n").find((l) => l.includes("pid ="))?.trim() ?? "pid = unknown";
    const stateLine = out.split("\n").find((l) => l.includes("state ="))?.trim() ?? "";
    const res = await fetch("http://127.0.0.1:4318/api/health");
    const health = await res.json();
    console.log(`✓ 常驻运行中: ${LABEL} (${stateLine}, ${pidLine})`);
    console.log(`✓ 健康探针: http://127.0.0.1:4318/api/health -> status=${health.status ?? "ok"}, convs=${health.conversationDbCount}`);
  } catch (err) {
    console.error(`✗ 常驻服务未就绪 (${LABEL}):`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

await main(process.argv[2] || "status");
