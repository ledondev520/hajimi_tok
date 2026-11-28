/**
 * Input: node:os、node:path、./multiSource 的 createMultiSourceTelemetryService 与 ./app 的 createTelemetryHttpServer / resolveUpdateServiceAction。
 * Output: 启动本地只读 HTTP API 与生产态静态页面常驻托管服务（同时监听 IPv4/IPv6 loopback 4318 与备用 5173，自动兼容 T3 Code 多账号，含静默自更新与可选 agy 官方配额定时刷新）。
 * Pos: 服务端主进程启动入口（launchd 常驻服务 / npm start / npm run dev 后端子进程）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createMultiSourceTelemetryService } from "./multiSource";
import { createTelemetryHttpServer, resolveUpdateServiceAction } from "./app";
import { discoverLocalDataSources } from "./sources";

const PORT = Number(process.env.PORT || 4318); // 主 HTTP 监听端口
const COMPAT_DEV_PORT = 5173; // 兼容旧浏览器书签的本地端口（空闲时自动挂载）
const HOST = process.env.HOST || "127.0.0.1"; // 默认绑定本地回环保障隐私安全
const REPO_ROOT = path.resolve(import.meta.dirname, ".."); // 仓库根目录
const STATIC_DIR = path.resolve(REPO_ROOT, "dist"); // 生产构建前端产物目录
const UPDATE_SCRIPT = path.join(REPO_ROOT, "scripts", "update.mjs"); // 自更新脚本路径
const SERVICE_SCRIPT = path.join(REPO_ROOT, "scripts", "service.mjs"); // 常驻重启脚本路径
const AGY_SETTINGS_PATH = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"); // 官方 agy CLI 配置路径
const LIVE_QUOTA_SYNC_INTERVAL_MS = 10 * 60_000; // 检测到 agy CLI 桥接时后台静默刷新官方配额周期（10 分钟）
const rawIntervalMs = Number(process.env.AGY_AUTO_UPDATE_INTERVAL_MS);
const AUTO_UPDATE_INTERVAL_MS =
  Number.isFinite(rawIntervalMs) && rawIntervalMs >= 60_000 && rawIntervalMs <= 2_147_483_647
    ? Math.floor(rawIntervalMs)
    : 10 * 60_000; // 后台静默自动检查更新周期（默认 10 分钟，支持环境变量自定义）
const IS_CANONICAL_PROD_INSTANCE =
  process.env.AGY_DISABLE_AUTO_UPDATE !== "1" && HOST === "127.0.0.1" && PORT === 4318; // 正式常驻生产主实例判定（自更新循环与重启确认共享同一口径）

/**
 * 职责：在正式常驻生产主实例成功监听后，委托 update.mjs 在跨进程锁保护下确认已完成构建的重启生效；若锁短暂忙碌则短延迟重试。
 */
function confirmAppliedUpdateState(attempt = 0): void {
  if (!IS_CANONICAL_PROD_INSTANCE || !fs.existsSync(UPDATE_SCRIPT)) {
    return;
  }
  execFile(
    process.execPath,
    [UPDATE_SCRIPT, "--confirm-applied", "--json"],
    { cwd: REPO_ROOT, timeout: 10_000, maxBuffer: 256 * 1024 },
    (_err, stdout) => {
      try {
        const res = JSON.parse((stdout || "").trim()) as { busy?: boolean };
        if (res.busy && attempt < 5) {
          const t = setTimeout(() => confirmAppliedUpdateState(attempt + 1), 500);
          t.unref();
        }
      } catch {
        /* 静默忽略非 JSON 输出 */
      }
    }
  );
}

/**
 * 职责：启动后台静默自更新循环（启动 15 秒后首检，之后按周期检查，默认 10 分钟，可通过 AGY_AUTO_UPDATE_INTERVAL_MS 配置）。
 * 思路：仅在正式常驻生产主实例下运行；有未提交改动时 update.mjs 自动跳过，绝不覆盖本地开发改动。
 */
function startSilentAutoUpdateLoop(): () => void {
  if (!IS_CANONICAL_PROD_INSTANCE || !fs.existsSync(UPDATE_SCRIPT)) {
    return () => undefined;
  }
  let running = false;
  const runOnce = () => {
    if (running) return;
    running = true;
    execFile(
      process.execPath,
      [UPDATE_SCRIPT, "--no-restart", "--no-notify", "--json"],
      { cwd: REPO_ROOT, timeout: 560_000, maxBuffer: 2 * 1024 * 1024 },
      (_err, stdout) => {
        running = false;
        const text = (stdout || "").trim();
        if (!text) return;
        try {
          const res = JSON.parse(text) as Record<string, unknown>;
          if (res.ok === true && res.updated === true) {
            console.log(`[AntiGravity Token Radar] Auto-update applied: ${String(res.message || "")}`);
            const action = resolveUpdateServiceAction(res);
            if (action && fs.existsSync(SERVICE_SCRIPT)) {
              const child = spawn(process.execPath, [SERVICE_SCRIPT, action], {
                cwd: REPO_ROOT,
                detached: true,
                stdio: "ignore",
              });
              child.unref();
            }
          } else if (res.ok === false && !res.busy && res.message) {
            console.warn(`[AntiGravity Token Radar] Auto-update skipped/failed: ${String(res.message)}`);
          }
        } catch {
          /* 静默忽略非 JSON 输出 */
        }
      }
    );
  };

  const initTimer = setTimeout(runOnce, 15_000);
  const pollTimer = setInterval(runOnce, AUTO_UPDATE_INTERVAL_MS);
  initTimer.unref();
  pollTimer.unref();
  return () => {
    clearTimeout(initTimer);
    clearInterval(pollTimer);
  };
}

/**
 * 职责：查找本机可用的官方 agy CLI 可执行文件路径（优先检查官方默认 ~/.local/bin/agy，再回退扫描 PATH）。
 */
function findAgyBinary(): string | null {
  const defaultBin = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
  const candidates = [
    defaultBin,
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, process.platform === "win32" ? "agy.exe" : "agy")),
  ];
  for (const bin of candidates) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      if (fs.statSync(bin).isFile()) return bin;
    } catch {
      /* 忽略不可执行路径 */
    }
  }
  return null;
}

/**
 * 职责：确认指定 settings.json 已启用本项目的 statusline-bridge 桥接配置，避免对未接入或自定义 statusLine 的用户静默调用 agy。
 */
function isAgyBridgeEnabled(settingsPath = AGY_SETTINGS_PATH): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      statusLine?: { enabled?: boolean; command?: unknown };
    };
    const sl = parsed?.statusLine;
    return Boolean(
      sl &&
        typeof sl === "object" &&
        sl.enabled !== false &&
        typeof sl.command === "string" &&
        sl.command.includes("statusline-bridge.mjs")
    );
  } catch {
    return false;
  }
}

/** 为隔离账号准备轻量虚拟 HOME（内含 .gemini -> T3 profileDir 符号链接），让 `agy models` 读取该账号独立 antigravity-cli 登录态 */
function ensureIsolatedAgyHome(stateDir: string, profileDir: string): string {
  const virtualHome = path.join(stateDir, "agy-home");
  const geminiLink = path.join(virtualHome, ".gemini");
  fs.mkdirSync(virtualHome, { recursive: true });
  try {
    if (fs.lstatSync(geminiLink).isSymbolicLink() && fs.readlinkSync(geminiLink) === profileDir) {
      return virtualHome;
    }
    fs.rmSync(geminiLink, { recursive: true, force: true });
  } catch {
    /* 链接尚未创建 */
  }
  fs.symlinkSync(profileDir, geminiLink, "dir");
  return virtualHome;
}

/** 收集全部已启用 statusline-bridge 桥接的同步目标（原生钥匙串 + 已单独登录隔离 CLI 的 T3 账号） */
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
    const cliSettings = path.join(src.profileDir, "antigravity-cli", "settings.json");
    if (!isAgyBridgeEnabled(cliSettings)) continue;
    let isolatedHome: string;
    try {
      isolatedHome = ensureIsolatedAgyHome(src.stateDir, src.profileDir);
    } catch {
      continue;
    }
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

/**
 * 职责：当本机装有 agy CLI 且存在已启用本桥接的账号时，每 10 分钟零 Token 串行静默运行 `agy models` 触发官方 statusLine 刷新各账号周剩配额。
 */
function startAgyQuotaSyncLoop(): () => void {
  if (!IS_CANONICAL_PROD_INSTANCE) {
    return () => undefined;
  }
  let running = false;
  const runOnce = () => {
    if (running) return;
    const agyBin = findAgyBinary();
    if (!agyBin) return;
    const targets = resolveAgyQuotaSyncTargets();
    if (targets.length === 0) return;
    running = true;
    const step = (idx: number) => {
      if (idx >= targets.length) {
        running = false;
        return;
      }
      execFile(
        agyBin,
        ["models"],
        { cwd: os.tmpdir(), env: targets[idx].env, timeout: 25_000, maxBuffer: 512 * 1024 },
        () => step(idx + 1)
      );
    };
    step(0);
  };
  const initTimer = setTimeout(runOnce, 20_000);
  const pollTimer = setInterval(runOnce, LIVE_QUOTA_SYNC_INTERVAL_MS);
  initTimer.unref();
  pollTimer.unref();
  return () => {
    clearTimeout(initTimer);
    clearInterval(pollTimer);
  };
}

/**
 * 职责：尝试在指定回环地址与端口挂载镜像 HTTP 实例，端口或协议不可用时静默跳过。
 * 参数：factory — 创建 Server 的工厂函数；port — 端口号；host — 监听地址。
 * 返回值：已启动的 Server 实例。
 */
function listenOptionalMirror(factory: () => Server, port: number, host: string): Server {
  // 0. 捕获 EADDRINUSE / EADDRNOTAVAIL，确保不影响主端口常驻
  const mirror = factory();
  mirror.on("error", () => {
    /* 端口已被其他开发进程占用或无 IPv6 时静默忽略 */
  });
  mirror.listen(port, host);
  return mirror;
}

/**
 * 职责：初始化遥测服务并监听本地 HTTP 端口（同时覆盖 127.0.0.1 与 ::1 localhost）。
 * 参数：无（读取环境变量 PORT、HOST、AGY_DATA_DIR）。
 */
function bootstrapServer(): void {
  // 0. 组装多数据源聚合服务与 HTTP 路由实例工厂（自动发现原生 + T3 Code 隔离账号目录）
  const provider = createMultiSourceTelemetryService(process.env.AGY_DATA_DIR);
  const makeServer = () => createTelemetryHttpServer(provider, { staticDir: STATIC_DIR });
  const servers: Server[] = [];

  // 1.1. 启动主监听端口，并挂载 IPv6 ::1 与 5173 兼容端口
  const primary = makeServer();
  servers.push(primary);
  primary.listen(PORT, HOST, () => {
    confirmAppliedUpdateState();
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
    if (process.env.COMPAT_PORT !== "0" && !process.env.PORT && PORT !== COMPAT_DEV_PORT) {
      servers.push(listenOptionalMirror(makeServer, COMPAT_DEV_PORT, "127.0.0.1"));
      servers.push(listenOptionalMirror(makeServer, COMPAT_DEV_PORT, "::1"));
    }
  }

  const stopAutoUpdate = startSilentAutoUpdateLoop();
  const stopQuotaSync = startAgyQuotaSyncLoop();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopAutoUpdate();
      stopQuotaSync();
      for (const s of servers) {
        try {
          s.close();
        } catch {
          /* 忽略关闭异常 */
        }
      }
      process.exit(0);
    });
  }
}

bootstrapServer();
