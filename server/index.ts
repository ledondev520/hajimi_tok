/**
 * Input: node:child_process、node:fs、node:http、node:os、node:path、./multiSource、./app 与 ./sources。
 * Output: 启动本地只读 HTTP API 与生产态静态页面常驻托管服务（监听 IPv4/IPv6 loopback 4318，自动兼容 T3 Code 多账号与多账号 agy 官方周剩定时刷新）。
 * Pos: 服务端主进程启动入口（launchd 常驻服务 / npm start / npm run dev 后端子进程）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createTelemetryHttpServer } from "./app";
import { createMultiSourceTelemetryService } from "./multiSource";
import { discoverLocalDataSources } from "./sources";

const PORT = Number(process.env.PORT || 4318); // 主 HTTP 监听端口
const HOST = process.env.HOST || "127.0.0.1"; // 默认绑定本地回环保障隐私安全
const REPO_ROOT = path.resolve(import.meta.dirname, ".."); // 仓库根目录
const STATIC_DIR = path.resolve(REPO_ROOT, "dist"); // 生产构建前端产物目录
const AGY_SETTINGS_PATH = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
const LIVE_QUOTA_SYNC_INTERVAL_MS = 10 * 60_000; // 每 10 分钟零 Token 刷新已启用桥接账号的官方周剩配额
const IS_CANONICAL_PROD_INSTANCE = HOST === "127.0.0.1" && PORT === 4318;

/** 查找本机可用的官方 agy CLI 路径（优先 ~/.local/bin/agy，再扫 PATH）。 */
function findAgyBinary(): string | null {
  const binName = process.platform === "win32" ? "agy.exe" : "agy";
  const candidates = [
    path.join(os.homedir(), ".local", "bin", binName),
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, binName)),
  ];
  for (const bin of candidates) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      if (fs.statSync(bin).isFile()) return bin;
    } catch { /* ignore */ }
  }
  return null;
}

/** 确认指定 settings.json 已启用本项目的 statusline-bridge 桥接配置。 */
function isAgyBridgeEnabled(settingsPath = AGY_SETTINGS_PATH): boolean {
  try {
    const sl = (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { statusLine?: { enabled?: boolean; command?: unknown } })?.statusLine;
    return Boolean(sl && typeof sl === "object" && sl.enabled !== false && typeof sl.command === "string" && sl.command.includes("statusline-bridge.mjs"));
  } catch {
    return false;
  }
}

/** 为隔离账号准备轻量虚拟 HOME（.gemini -> T3 profileDir），让 `agy models` 读取独立登录态。 */
function ensureIsolatedAgyHome(stateDir: string, profileDir: string): string {
  const virtualHome = path.join(stateDir, "agy-home");
  const geminiLink = path.join(virtualHome, ".gemini");
  fs.mkdirSync(virtualHome, { recursive: true });
  try {
    if (fs.lstatSync(geminiLink).isSymbolicLink() && fs.readlinkSync(geminiLink) === profileDir) return virtualHome;
    fs.rmSync(geminiLink, { recursive: true, force: true });
  } catch { /* 链接尚未创建 */ }
  fs.symlinkSync(profileDir, geminiLink, "dir");
  return virtualHome;
}

/** 收集全部已启用 statusline-bridge 的同步目标（原生钥匙串 + 隔离 CLI 登录的 T3 账号）。 */
function resolveAgyQuotaSyncTargets(): Array<{ env: NodeJS.ProcessEnv }> {
  const targets: Array<{ env: NodeJS.ProcessEnv }> = [];
  if (isAgyBridgeEnabled(AGY_SETTINGS_PATH)) {
    const env: NodeJS.ProcessEnv = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
    delete env.GEMINI_HOME;
    delete env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE;
    delete env.AGY_ACP_FORCE_FILE_STORAGE;
    targets.push({ env });
  }
  for (const src of discoverLocalDataSources({ customDataDir: process.env.AGY_DATA_DIR })) {
    if (src.kind !== "t3" || !src.profileDir || !src.stateDir) continue;
    if (!isAgyBridgeEnabled(path.join(src.profileDir, "antigravity-cli", "settings.json"))) continue;
    let isolatedHome: string;
    try { isolatedHome = ensureIsolatedAgyHome(src.stateDir, src.profileDir); } catch { continue; }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: isolatedHome,
      AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      AGY_LIVE_QUOTA_FILE: path.join(src.stateDir, "live-quota.json"),
    };
    delete env.GEMINI_HOME;
    delete env.SSH_CONNECTION;
    delete env.AGY_ACP_FORCE_FILE_STORAGE;
    targets.push({ env });
  }
  return targets;
}

/** 每 10 分钟串行运行 `agy models` 触发官方 statusLine 刷新各账号周剩配额（零 Token 消耗）。 */
function startAgyQuotaSyncLoop(): () => void {
  if (!IS_CANONICAL_PROD_INSTANCE) return () => undefined;
  let running = false;
  const runOnce = () => {
    if (running) return;
    const agyBin = findAgyBinary();
    if (!agyBin) return;
    const targets = resolveAgyQuotaSyncTargets();
    if (targets.length === 0) return;
    running = true;
    const step = (idx: number) => {
      if (idx >= targets.length) { running = false; return; }
      execFile(agyBin, ["models"], { cwd: os.tmpdir(), env: targets[idx].env, timeout: 25_000, maxBuffer: 512 * 1024 }, () => step(idx + 1));
    };
    step(0);
  };
  const initTimer = setTimeout(runOnce, 20_000);
  const pollTimer = setInterval(runOnce, LIVE_QUOTA_SYNC_INTERVAL_MS);
  initTimer.unref();
  pollTimer.unref();
  return () => { clearTimeout(initTimer); clearInterval(pollTimer); };
}

/** 生产常驻启动时幂等补装 400K 压缩提醒 Hook（尊重用户卸载退订与 AGY_SKIP_COMPACT_HOOK=1） */
function ensureCompactReminderHookOnBoot(): void {
  if (!IS_CANONICAL_PROD_INSTANCE || process.env.AGY_SKIP_COMPACT_HOOK === "1") return;
  const hookScript = path.join(REPO_ROOT, "scripts", "compact-reminder-hook.mjs");
  if (!fs.existsSync(hookScript) || !fs.existsSync(path.join(os.homedir(), ".gemini"))) return;
  execFile(process.execPath, [hookScript, "--auto-install"], { timeout: 5000 }, () => undefined);
}

function listenOptionalMirror(factory: () => Server, port: number, host: string): Server {
  const mirror = factory();
  mirror.on("error", () => { /* 无 IPv6 或被占用时静默忽略 */ });
  mirror.listen(port, host);
  return mirror;
}

function bootstrapServer(): void {
  const provider = createMultiSourceTelemetryService(process.env.AGY_DATA_DIR);
  const makeServer = () => createTelemetryHttpServer(provider, { staticDir: STATIC_DIR });
  const servers: Server[] = [];

  const primary = makeServer();
  servers.push(primary);
  primary.listen(PORT, HOST, () => {
    const health = provider.getHealth();
    const sources = provider.getSources?.() ?? [];
    console.log(`[AntiGravity Token Radar] Local server listening at http://${HOST}:${PORT} (and http://localhost:${PORT})`);
    console.log(`[AntiGravity Token Radar] Data source: ${health.dataDir} (convs=${health.conversationDbCount}, transcripts=${health.transcriptCount})`);
    if (sources.length > 1) {
      console.log(`[AntiGravity Token Radar] Sources: ${sources.map((s) => `${s.label}(${s.id})`).join(", ")}`);
    }
  });

  if (HOST === "127.0.0.1") {
    servers.push(listenOptionalMirror(makeServer, PORT, "::1"));
  }

  ensureCompactReminderHookOnBoot();
  const stopQuotaSync = startAgyQuotaSyncLoop();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopQuotaSync();
      for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
      process.exit(0);
    });
  }
}

bootstrapServer();
