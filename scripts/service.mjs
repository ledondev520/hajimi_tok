/**
 * Input: node:child_process、node:fs、node:os、node:path，管理 macOS launchd 用户级 LaunchAgent。
 * Output: 提供 install / restart / stop / status 子命令，使本地 4318 统计服务开机自启并崩溃自愈常驻（plist 内置完整 PATH/HOME 保障后台自更新可用，支持旧版 plist 自动迁移与启动失败回退）。
 * Pos: macOS 常驻守护进程编排脚本（scripts/service.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL = process.env.HAJIMI_SERVICE_LABEL || "com.hamiji.sta"; // launchd 服务唯一标识
const ROOT = path.resolve(process.env.HAJIMI_ROOT || path.resolve(import.meta.dirname, "..")); // 项目根目录绝对路径
const LAUNCH_AGENTS_DIR = path.resolve(process.env.HAJIMI_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library/LaunchAgents")); // LaunchAgents 目录
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`); // 用户级 LaunchAgent 路径
const LOG_DIR = path.join(ROOT, "logs"); // 常驻服务标准输出与错误日志目录
const HEALTH_URL = process.env.HAJIMI_HEALTH_URL || "http://127.0.0.1:4318/api/health"; // 本地健康探活地址
const UID = typeof process.getuid === "function" ? process.getuid() : 501; // 当前登录用户 UID
const DOMAIN_TARGET = `gui/${UID}`; // macOS GUI 会话 launchd 域
const SERVICE_TARGET = `${DOMAIN_TARGET}/${LABEL}`; // 完整 launchd 服务目标名

const escapeXml = (v) =>
  String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

const unescapeXml = (v) =>
  String(v).replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

function normalizeRealPath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** 在当前 PATH 中定位可执行命令所在目录（纯 Node 检测，不依赖外部 which）。 */
function findCmdDirInPath(cmdName) {
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    try {
      const full = path.join(dir, cmdName);
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return dir;
    } catch { /* 继续扫描下一个 PATH 目录 */ }
  }
  return "";
}

const SYSTEM_FALLBACK_DIRS = new Set(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/**
 * 职责：构造精简且自包含的 launchd PATH，确保 nvm/fnm/Homebrew 及旧 plist 自定义工具目录在后台自更新中均可解析。
 * 参数：prevPath — 旧 plist 中原有的 PATH 字符串（可选，保留其中的非系统自定义目录）。
 * 返回值：冒号拼接的 PATH 字符串。
 */
function buildLaunchdPath(prevPath = "") {
  const customToolDirs = [findCmdDirInPath("npm"), findCmdDirInPath("git")].filter((d) => d && !SYSTEM_FALLBACK_DIRS.has(d));
  const prevCustomDirs = String(prevPath || "")
    .split(path.delimiter)
    .filter((d) => d && !SYSTEM_FALLBACK_DIRS.has(d));
  const candidates = [
    path.dirname(process.execPath),
    ...customToolDirs,
    ...prevCustomDirs,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(candidates.filter(Boolean))].join(path.delimiter);
}

/** 提取旧 plist 中用户自定义的 EnvironmentVariables 键值（自动忽略 XML 注释），防止重装/自动迁移丢失配置。 */
function extractPlistEnvVars(xml) {
  const vars = {};
  if (!xml) return vars;
  const cleanXml = xml.replace(/<!--[\s\S]*?-->/g, "");
  const block = cleanXml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!block) return vars;
  const pairRe = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  let m;
  while ((m = pairRe.exec(block[1])) !== null) {
    vars[unescapeXml(m[1]).trim()] = unescapeXml(m[2]);
  }
  return vars;
}

/** 检测已有 plist 是否归属当前仓库且缺少 PATH/HOME（兼容从旧版常驻配置平滑迁移）。 */
function shouldMigrateLegacyPlist() {
  if (!fs.existsSync(PLIST_PATH)) return false;
  try {
    const xml = fs.readFileSync(PLIST_PATH, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const wdMatch = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
    const wd = wdMatch ? unescapeXml(wdMatch[1]).trim() : "";
    if (!wd || normalizeRealPath(wd) !== normalizeRealPath(ROOT)) return false;
    return !xml.includes("<key>PATH</key>") || !xml.includes("<key>HOME</key>");
  } catch {
    return false;
  }
}

/**
 * 职责：生成绑定当前 Node 运行时、项目路径与完整 PATH/HOME 的 LaunchAgent plist XML 文本（保留既有自定义环境变量）。
 * 参数：prevPlistXml — 原有 plist 文本（可选，用于迁移保留自定义 EnvironmentVariables）。
 * 返回值：标准 Apple PropertyList 1.0 XML 字符串。
 */
function buildPlistXml(prevPlistXml = null) {
  const nodeBin = process.execPath;
  const tsxCli = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
  const entryFile = path.join(ROOT, "server/index.ts");
  const outLog = path.join(LOG_DIR, "daemon.out.log");
  const errLog = path.join(LOG_DIR, "daemon.err.log");

  const prevEnv = extractPlistEnvVars(prevPlistXml);
  const prevNodeOpts = (prevEnv.NODE_OPTIONS || "").trim();
  const mergedNodeOpts = prevNodeOpts.includes("--no-warnings")
    ? prevNodeOpts
    : [prevNodeOpts, "--no-warnings"].filter(Boolean).join(" ");
  const mergedEnv = {
    ...prevEnv,
    NODE_OPTIONS: mergedNodeOpts,
    HOME: prevEnv.HOME || os.homedir(),
    PATH: buildLaunchdPath(prevEnv.PATH || ""),
  };
  const envEntries = Object.entries(mergedEnv)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>--no-warnings</string>
    <string>${escapeXml(tsxCli)}</string>
    <string>${escapeXml(entryFile)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
}

/**
 * 职责：查询指定 launchd 服务是否已加载（严格以 exit 113 判定未找到，其余非 0 一律按错误处理）。
 * 返回值：{ loaded: boolean, error: string | null }。
 */
function queryServiceLoaded() {
  try {
    execFileSync("launchctl", ["print", SERVICE_TARGET], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
    return { loaded: true, error: null };
  } catch (err) {
    const stderr = err && typeof err === "object" && typeof err.stderr === "string" ? err.stderr : "";
    const status = err && typeof err === "object" ? err.status : null;
    if (status === 113) return { loaded: false, error: null };
    return { loaded: false, error: stderr.trim() || (err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * 职责：卸载已有同名 LaunchAgent 并轮询复核确已卸载，避免卸载失败却误删 plist 或 bootstrap 竞态。
 * 返回值：Promise<{ unloaded: boolean, wasLoaded: boolean, error: string }>。
 */
async function bootoutAndVerify() {
  const initial = queryServiceLoaded();
  if (initial.error) return { unloaded: false, wasLoaded: false, error: initial.error };
  if (!initial.loaded) return { unloaded: true, wasLoaded: false, error: "" };
  let bootoutErr = "";
  try {
    execFileSync("launchctl", ["bootout", SERVICE_TARGET], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  } catch (err) {
    bootoutErr = (err && typeof err === "object" && typeof err.stderr === "string" && err.stderr.trim()) || (err instanceof Error ? err.message : String(err));
  }
  for (let i = 0; i < 15; i++) {
    const cur = queryServiceLoaded();
    if (cur.error) return { unloaded: false, wasLoaded: true, error: cur.error || bootoutErr };
    if (!cur.loaded) return { unloaded: true, wasLoaded: true, error: "" };
    await new Promise((r) => setTimeout(r, 150));
  }
  const final = queryServiceLoaded();
  if (final.error) return { unloaded: false, wasLoaded: true, error: final.error || bootoutErr };
  return { unloaded: !final.loaded, wasLoaded: true, error: bootoutErr };
}

/** 幂等自动注册 400K 压缩软提醒 Hook（尊重用户退订与 AGY_SKIP_COMPACT_HOOK=1，不阻塞服务启停） */
function ensureCompactReminderHook() {
  const compactHookScript = path.join(ROOT, "scripts", "compact-reminder-hook.mjs");
  if (
    process.env.AGY_SKIP_COMPACT_HOOK === "1" ||
    !fs.existsSync(compactHookScript) ||
    !fs.existsSync(path.join(os.homedir(), ".gemini"))
  ) {
    return;
  }
  try {
    execFileSync(process.execPath, [compactHookScript, "--auto-install"], {
      stdio: "inherit",
      timeout: 5000,
    });
  } catch {
    /* 压缩提醒 Hook 安装失败不影响常驻服务启动 */
  }
}

/**
 * 职责：根据命令行动作执行常驻服务安装、重启、停止或状态探活。
 * 参数：action — 子命令名称（install | restart | stop | status）。
 * 返回值：Promise<void>。
 */
async function main(action) {
  // 1.1. 安装或更新并立即启动常驻守护（先落盘临时 plist 再卸载旧服务；替换或 bootstrap 失败时按原状态尽力恢复）
  if (action === "install") {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    const prevPlist = fs.existsSync(PLIST_PATH) ? fs.readFileSync(PLIST_PATH, "utf8") : null;
    const prevMode = prevPlist !== null ? fs.statSync(PLIST_PATH).mode & 0o777 : 0o600;
    const tmpPlist = `${PLIST_PATH}.tmp.${process.pid}`;
    let wasLoaded = false;
    let plistReplaced = false;
    try {
      fs.writeFileSync(tmpPlist, buildPlistXml(prevPlist), { encoding: "utf8", mode: prevMode, flag: "wx" });
      fs.chmodSync(tmpPlist, prevMode);
      const unload = await bootoutAndVerify();
      wasLoaded = unload.wasLoaded;
      if (!unload.unloaded) {
        throw new Error(`重载前卸载旧常驻服务 ${LABEL} 失败${unload.error ? `: ${unload.error}` : ""}`);
      }
      fs.renameSync(tmpPlist, PLIST_PATH);
      plistReplaced = true;
      execFileSync("launchctl", ["bootstrap", DOMAIN_TARGET, PLIST_PATH], { stdio: "inherit", timeout: 15_000 });
      execFileSync("launchctl", ["kickstart", "-k", SERVICE_TARGET], { stdio: "inherit", timeout: 15_000 });
    } catch (err) {
      try { fs.rmSync(tmpPlist, { force: true }); } catch { /* 清理临时文件失败不阻塞回滚 */ }
      if (plistReplaced || wasLoaded) {
        try {
          const rbUnload = await bootoutAndVerify();
          if (rbUnload.unloaded) {
            if (plistReplaced) {
              if (prevPlist !== null) {
                fs.writeFileSync(PLIST_PATH, prevPlist, { encoding: "utf8", mode: prevMode });
                fs.chmodSync(PLIST_PATH, prevMode);
              } else {
                fs.rmSync(PLIST_PATH, { force: true });
              }
            }
            if (wasLoaded && fs.existsSync(PLIST_PATH)) {
              execFileSync("launchctl", ["bootstrap", DOMAIN_TARGET, PLIST_PATH], { stdio: "ignore", timeout: 10_000 });
              execFileSync("launchctl", ["kickstart", "-k", SERVICE_TARGET], { stdio: "ignore", timeout: 10_000 });
            }
          }
        } catch { /* 回退恢复失败时保留原始错误抛出 */ }
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, 600));
    console.log(`✓ 已注册并启动常驻服务 ${LABEL} (${PLIST_PATH})`);
    // 1.1.1. 若本机装有 agy CLI，顺手无侵入接入官方 statusLine 配额桥接（无 agy 时静默跳过）
    const bridgeScript = path.join(ROOT, "scripts", "statusline-bridge.mjs");
    if (fs.existsSync(bridgeScript)) {
      try {
        execFileSync(process.execPath, [bridgeScript, "--install"], {
          stdio: "inherit",
          timeout: 5000,
        });
      } catch {
        /* 桥接安装失败不影响常驻服务启动 */
      }
    }
    // 1.1.2. 若本机存在 ~/.gemini 目录且未退订，自动无侵入注册 400K 上下文压缩软提醒 Hook
    ensureCompactReminderHook();
    return;
  }

  // 1.2. 原地热重启常驻进程（若发现旧版 plist 缺少 PATH/HOME 则自动走一次 install 平滑迁移）
  if (action === "restart") {
    if (shouldMigrateLegacyPlist()) {
      console.log(`↻ 检测到旧版常驻 plist 缺少 PATH/HOME，自动升级并重启 ${LABEL}...`);
      return main("install");
    }
    execFileSync("launchctl", ["kickstart", "-k", SERVICE_TARGET], { stdio: "inherit" });
    await new Promise((r) => setTimeout(r, 600));
    ensureCompactReminderHook();
    console.log(`✓ 已重启常驻服务 ${LABEL}`);
    return;
  }

  // 1.3. 停止并移除开机常驻
  if (action === "stop") {
    const unload = await bootoutAndVerify();
    if (!unload.unloaded) {
      throw new Error(`卸载常驻服务 ${LABEL} 失败，任务仍在运行或状态不可确认，已保留 ${PLIST_PATH}${unload.error ? `: ${unload.error}` : ""}`);
    }
    if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
    console.log(`✓ 已停止并卸载常驻服务 ${LABEL}`);
    return;
  }

  // 1.4. 默认查询 launchd 存活状态与本地 4318 健康接口
  try {
    const out = execFileSync("launchctl", ["print", SERVICE_TARGET], { encoding: "utf8" });
    const pidLine = out.split("\n").find((l) => l.includes("pid ="))?.trim() ?? "pid = unknown";
    const stateLine = out.split("\n").find((l) => l.includes("state ="))?.trim() ?? "";
    const res = await fetch(HEALTH_URL);
    const health = await res.json();
    console.log(`✓ 常驻运行中: ${LABEL} (${stateLine}, ${pidLine})`);
    console.log(`✓ 健康探针: ${HEALTH_URL} -> status=${health.status ?? "ok"}, convs=${health.conversationDbCount}`);
  } catch (err) {
    console.error(`✗ 常驻服务未就绪 (${LABEL}):`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main(process.argv[2] || "status").catch((err) => {
  console.error(`✗ 常驻服务操作失败 (${LABEL}):`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
