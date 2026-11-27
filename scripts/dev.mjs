/**
 * Input: node:child_process 子进程派生能力与当前项目脚本配置。
 * Output: 并行拉起本地 Telemetry API 服务（:4318）与 Vite 前端热更新服务（:5173），统一优雅退出。
 * Pos: 开发态一键联调启动器（npm run dev）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { spawn } from "node:child_process";

const children = []; // 保存所有受管子进程句柄以便统一回收

/**
 * 职责：启动单个命名子进程并转发标准输出与退出信号。
 * 参数：name — 进程标识；cmd — 可执行文件；args — 命令参数数组。
 * 返回值：ChildProcess 实例。
 */
function launchProcess(name, cmd, args) {
  // 0. 启动子进程并继承当前终端颜色与标准流
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1", COMPAT_PORT: "0", AGY_DISABLE_AUTO_UPDATE: "1" },
  });
  children.push(child);

  // 1.1. 任一核心进程异常退出时联动终止其余子进程
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[dev] ${name} exited with code ${code}, shutting down...`);
      shutdown(code);
    }
  });
  return child;
}

/**
 * 职责：向全部存活子进程发送终止信号并退出主控进程。
 * 参数：exitCode — 退出码。
 */
function shutdown(exitCode = 0) {
  // 0. 遍历已注册子进程发送 SIGTERM
  for (const proc of children) {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

launchProcess("api-server", "node", ["--no-warnings", "./node_modules/tsx/dist/cli.mjs", "watch", "server/index.ts"]);
launchProcess("vite-web", "node", ["./node_modules/vite/bin/vite.js"]);
