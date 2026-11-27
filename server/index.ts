/**
 * Input: node:path、./aggregator 的 createTelemetryService 与 ./app 的 createTelemetryHttpServer。
 * Output: 启动本地只读 HTTP API 与生产态静态页面常驻托管服务（同时监听 IPv4/IPv6 loopback 4318 与备用 5173）。
 * Pos: 服务端主进程启动入口（launchd 常驻服务 / npm start / npm run dev 后端子进程）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createTelemetryService } from "./aggregator";
import { createTelemetryHttpServer } from "./app";

const PORT = Number(process.env.PORT || 4318); // 主 HTTP 监听端口
const COMPAT_DEV_PORT = 5173; // 兼容旧浏览器书签的本地端口（空闲时自动挂载）
const HOST = process.env.HOST || "127.0.0.1"; // 默认绑定本地回环保障隐私安全
const REPO_ROOT = path.resolve(import.meta.dirname, ".."); // 仓库根目录
const STATIC_DIR = path.resolve(REPO_ROOT, "dist"); // 生产构建前端产物目录
const UPDATE_SCRIPT = path.join(REPO_ROOT, "scripts", "update.mjs"); // 自更新脚本路径
const SERVICE_SCRIPT = path.join(REPO_ROOT, "scripts", "service.mjs"); // 常驻重启脚本路径
const AUTO_UPDATE_INTERVAL_MS = 10 * 60_000; // 后台静默自动检查更新周期（10 分钟）
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
 * 职责：启动后台静默自更新循环（启动 15 秒后首检，之后每 10 分钟检查一次，工作区干净且落后远端时自动拉取构建并重启）。
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
      [UPDATE_SCRIPT, "--no-restart", "--json"],
      { cwd: REPO_ROOT, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
      (_err, stdout) => {
        running = false;
        const text = (stdout || "").trim();
        if (!text) return;
        try {
          const res = JSON.parse(text) as {
            ok?: boolean;
            updated?: boolean;
            needRestart?: boolean;
            message?: string;
          };
          if (res.ok && res.updated) {
            console.log(`[AntiGravity Token Radar] Auto-update applied: ${res.message}`);
            if (res.needRestart && fs.existsSync(SERVICE_SCRIPT)) {
              const child = spawn(process.execPath, [SERVICE_SCRIPT, "restart"], {
                cwd: REPO_ROOT,
                detached: true,
                stdio: "ignore",
              });
              child.unref();
            }
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
  // 0. 组装聚合服务与 HTTP 路由实例工厂
  const provider = createTelemetryService(process.env.AGY_DATA_DIR);
  const makeServer = () => createTelemetryHttpServer(provider, { staticDir: STATIC_DIR });
  const servers: Server[] = [];

  // 1.1. 启动主监听端口，并挂载 IPv6 ::1 与 5173 兼容端口
  const primary = makeServer();
  servers.push(primary);
  primary.listen(PORT, HOST, () => {
    confirmAppliedUpdateState();
    const health = provider.getHealth();
    console.log(`[AntiGravity Token Radar] Local server listening at http://${HOST}:${PORT} (and http://localhost:${PORT})`);
    console.log(`[AntiGravity Token Radar] Data source: ${health.dataDir} (convs=${health.conversationDbCount}, transcripts=${health.transcriptCount})`);
  });

  if (HOST === "127.0.0.1") {
    servers.push(listenOptionalMirror(makeServer, PORT, "::1"));
    if (process.env.COMPAT_PORT !== "0" && !process.env.PORT && PORT !== COMPAT_DEV_PORT) {
      servers.push(listenOptionalMirror(makeServer, COMPAT_DEV_PORT, "127.0.0.1"));
      servers.push(listenOptionalMirror(makeServer, COMPAT_DEV_PORT, "::1"));
    }
  }

  const stopAutoUpdate = startSilentAutoUpdateLoop();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopAutoUpdate();
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
