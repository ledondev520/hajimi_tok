/**
 * Input: vitest、node:child_process、node:fs、node:http、node:os、node:path，调用 scripts/update.mjs 与 scripts/service.mjs。
 * Output: 验证 service.mjs 的 PATH/HOME 注入、旧 plist 自动迁移、bootstrap 失败恢复与 stop 防误删，以及 update.mjs 的 ls-remote 快路径、未跟踪/lockfile 漂移自愈、dist 备份恢复、多副本归属防护、CLI PID+探活核验、日志裁剪与安全通知。
 * Pos: 自更新与常驻服务脚本隔离沙箱测试套件（tests/update.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUpdateServiceAction } from "../server/app";

const UPDATE_SCRIPT = path.resolve(import.meta.dirname, "../scripts/update.mjs");
const SERVICE_SCRIPT = path.resolve(import.meta.dirname, "../scripts/service.mjs");
const tempDirs: string[] = [];
const activeServers: http.Server[] = [];
const activeChildren = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of activeChildren) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  activeChildren.clear();
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface SandboxRepo {
  baseDir: string;
  remoteDir: string;
  workDir: string;
  seedDir: string;
  stateDir: string;
  binDir: string;
  launchAgentsDir: string;
  callLogPath: string;
  servicePidPath: string;
}

function cleanGitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  };
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: cleanGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o755 });
}

function createSandbox(options?: { serviceLoaded?: boolean; simulateLockDriftOnInstall?: boolean }): SandboxRepo {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "hajimi-update-v2-"));
  tempDirs.push(baseDir);

  const remoteDir = path.join(baseDir, "remote.git");
  const seedDir = path.join(baseDir, "seed");
  const workDir = path.join(baseDir, "local");
  const stateDir = path.join(baseDir, "state");
  const binDir = path.join(baseDir, "bin");
  const launchAgentsDir = path.join(baseDir, "LaunchAgents");
  const callLogPath = path.join(baseDir, "calls.jsonl");
  const servicePidPath = path.join(baseDir, "service.pid");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(servicePidPath, "2001", "utf8");

  gitIn(baseDir, ["init", "--bare", "-b", "master", remoteDir]);
  gitIn(baseDir, ["clone", remoteDir, seedDir]);
  fs.writeFileSync(path.join(seedDir, ".gitignore"), "node_modules/\ndist/\nlogs/\n", "utf8");
  fs.mkdirSync(path.join(seedDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(seedDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "README.md"), "# doc v1\n", "utf8");
  fs.writeFileSync(path.join(seedDir, "src/app.txt"), "v1\n", "utf8");
  fs.writeFileSync(
    path.join(seedDir, "scripts/service.mjs"),
    `import fs from "node:fs";
const action = process.argv[2] || "status";
fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify({ cmd: "service.mjs", args: [action] }) + "\\n");
if (process.env.TEST_NO_PID_CHANGE !== "1") {
  const cur = Number(fs.readFileSync(${JSON.stringify(servicePidPath)}, "utf8").trim()) || 2000;
  fs.writeFileSync(${JSON.stringify(servicePidPath)}, String(cur + 1), "utf8");
}
`,
    "utf8",
  );
  fs.writeFileSync(path.join(seedDir, "package-lock.json"), '{"name":"old","lockfileVersion":3}\n', "utf8");
  fs.writeFileSync(
    path.join(seedDir, "package.json"),
    JSON.stringify({
      name: "hamiji-sta",
      version: "1.0.0",
      scripts: {
        build: 'node -e "const fs=require(\'node:fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/index.html\',fs.readFileSync(\'src/app.txt\',\'utf8\'));"',
      },
    }),
    "utf8",
  );
  gitIn(seedDir, ["add", "."]);
  gitIn(seedDir, ["commit", "-m", "chore: initial commit"]);
  gitIn(seedDir, ["push", "-u", "origin", "master"]);

  gitIn(baseDir, ["clone", remoteDir, workDir]);
  gitIn(workDir, ["config", "user.name", "Test User"]);
  gitIn(workDir, ["config", "user.email", "test@example.com"]);
  gitIn(workDir, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(workDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "dist/index.html"), "v1\n", "utf8");

  const serviceLoaded = options?.serviceLoaded ?? true;
  const simulateDrift = options?.simulateLockDriftOnInstall ?? false;
  const nodeBin = process.execPath;

  writeExecutable(
    path.join(binDir, "launchctl"),
    `#!${nodeBin}
const fs = require("node:fs");
const args = process.argv.slice(2);
const loadedMarker = ${JSON.stringify(path.join(baseDir, "service.loaded"))};
const bootedOutMarker = ${JSON.stringify(path.join(baseDir, "service.bootedout"))};
if (${serviceLoaded} && !fs.existsSync(loadedMarker) && !fs.existsSync(bootedOutMarker)) {
  fs.writeFileSync(loadedMarker, "1");
}
fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify({ cmd: "launchctl", args }) + "\\n");
if (args[0] === "print") {
  if (process.env.TEST_PRINT_FAIL === "1") {
    console.error("Operation not permitted");
    process.exit(1);
  }
  if (fs.existsSync(loadedMarker)) {
    const pid = fs.readFileSync(${JSON.stringify(servicePidPath)}, "utf8").trim();
    console.log("state = running\\n\\tpid = " + pid);
    process.exit(0);
  }
  console.error('Could not find service "com.hamiji.sta.test"');
  process.exit(113);
}
if (args[0] === "bootstrap") {
  const failMarker = ${JSON.stringify(path.join(baseDir, "bootstrap.failed-once"))};
  if (process.env.TEST_BOOTSTRAP_FAIL_ONCE === "1" && !fs.existsSync(failMarker)) {
    fs.writeFileSync(failMarker, "1");
    console.error("Bootstrap failed: 5: Input/output error");
    process.exit(5);
  }
  fs.rmSync(bootedOutMarker, { force: true });
  fs.writeFileSync(loadedMarker, "1");
  process.exit(0);
}
if (args[0] === "bootout") {
  if (process.env.TEST_BOOTOUT_FAIL === "1") {
    console.error("Boot-out failed: 1: Operation not permitted");
    process.exit(1);
  }
  fs.rmSync(loadedMarker, { force: true });
  fs.writeFileSync(bootedOutMarker, "1");
  process.exit(0);
}
process.exit(0);
`,
  );

  writeExecutable(
    path.join(binDir, "osascript"),
    `#!${nodeBin}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify({ cmd: "osascript", args: process.argv.slice(2) }) + "\\n");
process.exit(0);
`,
  );

  writeExecutable(
    path.join(binDir, "npm"),
    `#!${nodeBin}
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify({ cmd: "npm", args }) + "\\n");
if (args[0] === "install") {
  if (${simulateDrift}) fs.writeFileSync("package-lock.json", '{"name":"hamiji-sta","drift":true}\\n', "utf8");
  process.exit(0);
}
if (args[0] === "run" && args[1] === "build") {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (!pkg.scripts?.build) process.exit(1);
  execFileSync("/bin/sh", ["-c", pkg.scripts.build], { stdio: "inherit" });
  process.exit(0);
}
process.exit(1);
`,
  );

  return { baseDir, remoteDir, workDir, seedDir, stateDir, binDir, launchAgentsDir, callLogPath, servicePidPath };
}

function readCalls(callLogPath: string): Array<{ cmd: string; args: string[] }> {
  if (!fs.existsSync(callLogPath)) return [];
  return fs
    .readFileSync(callLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cmd: string; args: string[] });
}

async function startHealthServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  const srv = http.createServer(handler);
  activeServers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind health server");
  return `http://127.0.0.1:${addr.port}/api/health`;
}

function runScript(
  scriptPath: string,
  sb: SandboxRepo,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", scriptPath, ...args], {
      cwd: sb.workDir,
      env: cleanGitEnv({
        PATH: `${sb.binDir}${path.delimiter}${process.env.PATH || ""}`,
        HAJIMI_ROOT: sb.workDir,
        AGY_STATE_DIR: sb.stateDir,
        AGY_UPDATE_NOTIFY: "1",
        HAJIMI_LAUNCH_AGENTS_DIR: sb.launchAgentsDir,
        HAJIMI_SERVICE_LABEL: "com.hamiji.sta.test",
        HAJIMI_HEALTH_RETRIES: "3",
        HAJIMI_HEALTH_DELAY_MS: "50",
        HAJIMI_PID_WAIT_RETRIES: "4",
        ...extraEnv,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => { activeChildren.delete(child); reject(err); });
    child.on("close", (status) => { activeChildren.delete(child); resolve({ status, stdout, stderr }); });
  });
}

describe("hardened scripts/update.mjs & scripts/service.mjs", () => {
  it("validates CLI flags, ignores untracked files & lockfile drift, and reports remote HEAD on local-ahead fast path", async () => {
    const sb = createSandbox({ serviceLoaded: false });
    expect((await runScript(UPDATE_SCRIPT, sb, ["--help"])).status).toBe(0);
    expect((await runScript(UPDATE_SCRIPT, sb, ["--unknown"])).status).toBe(2);

    fs.writeFileSync(path.join(sb.workDir, "scratch.tmp"), "untracked\n", "utf8");
    fs.writeFileSync(path.join(sb.workDir, "package-lock.json"), '{"dirty":true}\n', "utf8");

    const check = await runScript(UPDATE_SCRIPT, sb, ["--check", "--json"]);
    expect(check.status).toBe(0);
    const parsed = JSON.parse(check.stdout.trim()) as {
      ok: boolean; available: boolean; dirty: boolean; lockfileDriftOnly: boolean; behindCount: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.available).toBe(false);
    expect(parsed.dirty).toBe(false);
    expect(parsed.lockfileDriftOnly).toBe(true);
    expect(parsed.behindCount).toBe(0);

    // 本地超前远端时，ls-remote 快路径必须返回远端提交 SHA 与标题而非本地 HEAD
    const remoteShort = gitIn(sb.workDir, ["rev-parse", "--short=7", "HEAD"]);
    fs.writeFileSync(path.join(sb.workDir, "local-ahead.txt"), "ahead\n", "utf8");
    gitIn(sb.workDir, ["add", "local-ahead.txt"]);
    gitIn(sb.workDir, ["commit", "-m", "feat: local ahead"]);
    const ahead = await runScript(UPDATE_SCRIPT, sb, ["--check", "--json"]);
    expect(ahead.status).toBe(0);
    const aheadJson = JSON.parse(ahead.stdout.trim()) as { available: boolean; latestCommit: string; latestSubject: string };
    expect(aheadJson.available).toBe(false);
    expect(aheadJson.latestCommit).toBe(remoteShort);
    expect(aheadJson.latestSubject).toBe("chore: initial commit");

    // 检测到未完成 rebase/merge 标记时必须安全中止
    fs.writeFileSync(path.join(sb.workDir, ".git/MERGE_HEAD"), `${gitIn(sb.workDir, ["rev-parse", "HEAD"])}\n`, "utf8");
    const opRes = await runScript(UPDATE_SCRIPT, sb, ["--check", "--json"]);
    expect((JSON.parse(opRes.stdout.trim()) as { ok: boolean; dirty: boolean }).ok).toBe(false);
  });

  it("auto-restores package-lock.json drift before pull & after npm install, and trims oversized daemon logs", async () => {
    const sb = createSandbox({ serviceLoaded: false, simulateLockDriftOnInstall: true });
    fs.writeFileSync(path.join(sb.workDir, "package-lock.json"), '{"drift":"pre"}\n', "utf8");
    fs.mkdirSync(path.join(sb.workDir, "logs"), { recursive: true });
    const bigLog = path.join(sb.workDir, "logs/daemon.out.log");
    fs.writeFileSync(bigLog, `${"log line\n".repeat(70_000)}TAIL_MARKER\n`, "utf8");

    const pkg = JSON.parse(fs.readFileSync(path.join(sb.seedDir, "package.json"), "utf8"));
    pkg.version = "1.2.0";
    fs.writeFileSync(path.join(sb.seedDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(sb.seedDir, "src/app.txt"), "v2-deps\n", "utf8");
    gitIn(sb.seedDir, ["add", "."]);
    gitIn(sb.seedDir, ["commit", "-m", "chore: bump deps"]);
    gitIn(sb.seedDir, ["push", "origin", "master"]);

    const res = await runScript(UPDATE_SCRIPT, sb, ["--json", "--no-notify"]);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(path.join(sb.workDir, "dist/index.html"), "utf8")).toBe("v2-deps\n");
    expect(gitIn(sb.workDir, ["status", "--porcelain"])).toBe("");
    expect(fs.statSync(bigLog).size).toBeLessThanOrEqual(256 * 1024);
    expect(fs.readFileSync(bigLog, "utf8")).toContain("TAIL_MARKER");
  });

  it("restores previous dist backup on build failure while preserving pendingBuild for resume", async () => {
    const sb = createSandbox({ serviceLoaded: false });
    const brokenPkg = {
      name: "hamiji-sta",
      version: "1.0.0",
      scripts: { build: 'node -e "const fs=require(\'node:fs\');fs.writeFileSync(\'dist/index.html\',\'BROKEN\');process.exit(1);"' },
    };
    fs.writeFileSync(path.join(sb.seedDir, "package.json"), JSON.stringify(brokenPkg), "utf8");
    gitIn(sb.seedDir, ["add", "."]);
    gitIn(sb.seedDir, ["commit", "-m", "feat: broken build"]);
    gitIn(sb.seedDir, ["push", "origin", "master"]);

    const res = await runScript(UPDATE_SCRIPT, sb, ["--json", "--no-notify"]);
    expect(res.status).toBe(1);
    expect(fs.readFileSync(path.join(sb.workDir, "dist/index.html"), "utf8")).toBe("v1\n");
    const savedState = JSON.parse(fs.readFileSync(path.join(sb.stateDir, "update-state.json"), "utf8")) as { pendingBuild: boolean };
    expect(savedState.pendingBuild).toBe(true);

    // 跨文件系统 EXDEV 场景下，restoreDistBackup 必须回退至同目录暂存拷贝+原子切换并清理备份
    const runtime = (await import(pathToFileURL(path.resolve(import.meta.dirname, "../scripts/update-runtime.mjs")).href)) as {
      restoreDistBackup: (distDir: string, backupDir: string, hadDistBefore: boolean) => void;
    };
    const distDir = path.join(sb.workDir, "dist");
    const backupDir = path.join(sb.stateDir, "exdev-backup");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "index.html"), "RECOVERED_EXDEV\n", "utf8");
    fs.writeFileSync(path.join(distDir, "index.html"), "CORRUPTED\n", "utf8");
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldP, newP) => {
      if (String(oldP) === backupDir && String(newP) === distDir) {
        const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return realRename(oldP, newP);
    });
    try {
      runtime.restoreDistBackup(distDir, backupDir, true);
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readFileSync(path.join(distDir, "index.html"), "utf8")).toBe("RECOVERED_EXDEV\n");
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it("normalizes update serviceAction, prioritizes current Node bin in buildRunEnv, and redacts sensitive URL params", async () => {
    expect(resolveUpdateServiceAction({ serviceAction: "install", needRestart: true })).toBe("install");
    expect(resolveUpdateServiceAction({ serviceAction: "restart", needRestart: true })).toBe("restart");
    expect(resolveUpdateServiceAction({ serviceAction: null, needRestart: true })).toBe(null);
    expect(resolveUpdateServiceAction({ needRestart: true })).toBe("restart");
    expect(resolveUpdateServiceAction({ needRestart: false })).toBe(null);

    const runtime = (await import(pathToFileURL(path.resolve(import.meta.dirname, "../scripts/update-runtime.mjs")).href)) as {
      buildRunEnv: (repoRoot: string) => NodeJS.ProcessEnv;
      redactSecrets: (text: string) => string;
    };
    const origPath = process.env.PATH;
    const origGitSsh = process.env.GIT_SSH;
    const origGitSshCmd = process.env.GIT_SSH_COMMAND;
    const nodeBinDir = path.dirname(process.execPath);
    const refSysDir = nodeBinDir === "/usr/local/bin" ? "/usr/bin" : "/usr/local/bin";
    try {
      process.env.PATH = `${refSysDir}${path.delimiter}${nodeBinDir}${path.delimiter}/bin`;
      process.env.GIT_SSH = "/custom/ssh-wrapper";
      delete process.env.GIT_SSH_COMMAND;
      const env = runtime.buildRunEnv(process.cwd());
      const parts = (env.PATH || "").split(path.delimiter);
      expect(parts.indexOf(nodeBinDir)).toBeGreaterThanOrEqual(0);
      expect(parts.indexOf(refSysDir)).toBeGreaterThanOrEqual(0);
      expect(parts.indexOf(nodeBinDir)).toBeLessThan(parts.indexOf(refSysDir));
      expect(env.GIT_SSH_COMMAND).toBeUndefined();
      expect(env.GIT_SSH).toBe("/custom/ssh-wrapper");

      // 已位于系统目录前的 nodeBinDir 必须保持原相对顺序，不可被后移到其他非系统目录之后
      process.env.PATH = `${nodeBinDir}${path.delimiter}/old-nvm/bin${path.delimiter}${refSysDir}`;
      const envKeepOrder = runtime.buildRunEnv(process.cwd());
      const keepParts = (envKeepOrder.PATH || "").split(path.delimiter);
      expect(keepParts.indexOf(nodeBinDir)).toBeLessThan(keepParts.indexOf("/old-nvm/bin"));
      expect(keepParts.indexOf("/old-nvm/bin")).toBeLessThan(keepParts.indexOf(refSysDir));
    } finally {
      process.env.PATH = origPath;
      if (origGitSsh === undefined) delete process.env.GIT_SSH; else process.env.GIT_SSH = origGitSsh;
      if (origGitSshCmd === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = origGitSshCmd;
    }

    expect(runtime.redactSecrets("https://user:pass@example.com/a?api_key=abc&refresh_token=xyz")).toBe(
      "https://***@example.com/a?api_key=***&refresh_token=***",
    );
  });

  it.skipIf(process.platform !== "darwin")("verifies PID switch + health probe, rejects stale PID, checks plist ownership, and sends safe osascript notification", async () => {
    const sb = createSandbox({ serviceLoaded: true });
    const always200Url = await startHealthServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    // 1) 归属其他仓库的 plist 不可被当前副本重启或重装，且连续第二次 --no-restart 轮询返回 updated:false 避免刷屏
    fs.appendFileSync(path.join(sb.seedDir, "scripts/service.mjs"), "// updated\n", "utf8");
    gitIn(sb.seedDir, ["add", "."]);
    gitIn(sb.seedDir, ["commit", "-m", "chore: service update"]);
    gitIn(sb.seedDir, ["push", "origin", "master"]);
    const plistPath = path.join(sb.launchAgentsDir, "com.hamiji.sta.test.plist");
    fs.writeFileSync(plistPath, "<plist><dict><key>WorkingDirectory</key><string>/tmp/other-checkout</string></dict></plist>", "utf8");
    const foreign = await runScript(UPDATE_SCRIPT, sb, ["--no-restart", "--json", "--no-notify"]);
    expect(foreign.status).toBe(0);
    const foreignBody = JSON.parse(foreign.stdout.trim()) as { updated: boolean; serviceAction: unknown; needReinstallService: boolean };
    expect(foreignBody.updated).toBe(true);
    expect(foreignBody.serviceAction).toBe(null);
    expect(foreignBody.needReinstallService).toBe(false);
    const foreignRepeat = await runScript(UPDATE_SCRIPT, sb, ["--no-restart", "--json", "--no-notify"]);
    expect(foreignRepeat.status).toBe(0);
    expect((JSON.parse(foreignRepeat.stdout.trim()) as { updated: boolean; serviceAction: unknown }).updated).toBe(false);

    // 1.1) 归属本仓的旧版 plist（缺 PATH/HOME）应自动输出 serviceAction="install"
    fs.writeFileSync(plistPath, `<plist><dict><key>WorkingDirectory</key><string>${sb.workDir}</string></dict></plist>`, "utf8");
    const legacyPlan = await runScript(UPDATE_SCRIPT, sb, ["--no-restart", "--json", "--no-notify"]);
    expect(legacyPlan.status).toBe(0);
    expect((JSON.parse(legacyPlan.stdout.trim()) as { serviceAction: unknown; updated: boolean }).serviceAction).toBe("install");

    // 2) launchctl print 非 113 报错时必须失败而非静默跳过
    fs.rmSync(plistPath, { force: true });
    fs.writeFileSync(path.join(sb.seedDir, "src/app.txt"), "v2-health\n", "utf8");
    gitIn(sb.seedDir, ["add", "."]);
    gitIn(sb.seedDir, ["commit", "-m", 'feat: handle "quotes" & $HOME safely']);
    gitIn(sb.seedDir, ["push", "origin", "master"]);
    const printErr = await runScript(UPDATE_SCRIPT, sb, ["--no-restart", "--json", "--no-notify"], { TEST_PRINT_FAIL: "1" });
    expect(printErr.status).toBe(1);

    // 3) 旧 PID 未切换时即使探针返回 200 也必须判定失败
    const stalePid = await runScript(UPDATE_SCRIPT, sb, ["--json", "--no-notify"], {
      HAJIMI_HEALTH_URL: always200Url,
      TEST_NO_PID_CHANGE: "1",
    });
    expect(stalePid.status).toBe(1);

    // 4) 正常重启：PID 切换 + 探活通过 + 安全 argv 通知
    const okRes = await runScript(UPDATE_SCRIPT, sb, ["--json"], { HAJIMI_HEALTH_URL: always200Url });
    expect(okRes.status).toBe(0);
    const body = JSON.parse(okRes.stdout.trim()) as { ok: boolean; verified?: boolean; restarted?: boolean };
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.restarted).toBe(true);
    const osa = readCalls(sb.callLogPath).find((c) => c.cmd === "osascript");
    expect(osa?.args).toContain("on run argv");
    expect(osa?.args.some((a) => a.includes('handle "quotes" & $HOME safely'))).toBe(true);
  }, 20_000);

  it.skipIf(process.platform !== "darwin")(
    "manages com.hamiji.sta plist: injects PATH/HOME, migrates legacy plist on restart, recovers on bootstrap failure, and guards stop",
    async () => {
      const sb = createSandbox({ serviceLoaded: false });
      const plistPath = path.join(sb.launchAgentsDir, "com.hamiji.sta.test.plist");

      // 1) 旧版 plist 缺少 PATH/HOME 且含自定义环境变量与 XML 注释时，restart 自动升级为 install：忽略注释、保留自定义 env/PATH 且 Homebrew 优先于 /usr/bin
      const legacyXml = `<plist><dict><key>WorkingDirectory</key><string>${sb.workDir}</string><key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string>--max-old-space-size=2048</string><key>AGY_DATA_DIR</key><string>/custom/data</string><key>AGY_STATE_DIR</key><string>/custom/state</string><key>PATH</key><string>/custom/tools/bin:/usr/bin</string><!-- <key>AGY_DATA_DIR</key><string>/commented/out</string> --></dict></dict></plist>`;
      fs.writeFileSync(plistPath, legacyXml, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(plistPath, 0o600);
      const migrated = await runScript(SERVICE_SCRIPT, sb, ["restart"], {
        PATH: `${sb.binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      });
      expect(migrated.status).toBe(0);
      expect(fs.statSync(plistPath).mode & 0o777).toBe(0o600);
      const xml = fs.readFileSync(plistPath, "utf8");
      expect(xml).toContain("<key>PATH</key>");
      expect(xml).toContain(path.dirname(process.execPath));
      expect(xml).toContain("<key>HOME</key>");
      expect(xml).toContain("<key>AGY_DATA_DIR</key>");
      expect(xml).toContain("<string>/custom/data</string>");
      expect(xml).not.toContain("/commented/out");
      expect(xml).toContain("<key>AGY_STATE_DIR</key>");
      expect(xml).toContain("<string>/custom/state</string>");
      expect(xml).toContain("--max-old-space-size=2048 --no-warnings");
      const pathParts = (xml.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "").split(path.delimiter);
      expect(pathParts).toContain("/custom/tools/bin");
      expect(pathParts.indexOf("/opt/homebrew/bin")).toBeGreaterThanOrEqual(0);
      expect(pathParts.indexOf("/usr/bin")).toBeGreaterThanOrEqual(0);
      expect(pathParts.indexOf("/opt/homebrew/bin")).toBeLessThan(pathParts.indexOf("/usr/bin"));

      // 2) 服务原本已加载时若 bootstrap 失败，恢复旧 plist 并重新拉起旧服务
      fs.writeFileSync(plistPath, legacyXml, "utf8");
      const loadedFailInst = await runScript(SERVICE_SCRIPT, sb, ["install"], { TEST_BOOTSTRAP_FAIL_ONCE: "1" });
      expect(loadedFailInst.status).toBe(1);
      expect(fs.readFileSync(plistPath, "utf8")).toBe(legacyXml);
      expect(readCalls(sb.callLogPath).filter((c) => c.cmd === "launchctl" && c.args[0] === "bootstrap").length).toBeGreaterThanOrEqual(3);

      // 3) 服务原本未加载且 bootstrap 失败时，仅恢复旧 plist 不误启动已停用服务
      expect((await runScript(SERVICE_SCRIPT, sb, ["stop"])).status).toBe(0);
      fs.rmSync(path.join(sb.baseDir, "bootstrap.failed-once"), { force: true });
      fs.writeFileSync(plistPath, legacyXml, "utf8");
      const beforeBootCount = readCalls(sb.callLogPath).filter((c) => c.cmd === "launchctl" && c.args[0] === "bootstrap").length;
      const failInst = await runScript(SERVICE_SCRIPT, sb, ["install"], { TEST_BOOTSTRAP_FAIL_ONCE: "1" });
      expect(failInst.status).toBe(1);
      expect(fs.readFileSync(plistPath, "utf8")).toBe(legacyXml);
      expect(readCalls(sb.callLogPath).filter((c) => c.cmd === "launchctl" && c.args[0] === "bootstrap").length).toBe(beforeBootCount + 1);

      // 4) 正常 install 后，bootout 或 print 非 113 故障均不可误删 plist
      expect((await runScript(SERVICE_SCRIPT, sb, ["install"])).status).toBe(0);
      expect((await runScript(SERVICE_SCRIPT, sb, ["stop"], { TEST_BOOTOUT_FAIL: "1" })).status).toBe(1);
      expect(fs.existsSync(plistPath)).toBe(true);
      expect((await runScript(SERVICE_SCRIPT, sb, ["stop"], { TEST_PRINT_FAIL: "1", TEST_BOOTOUT_FAIL: "1" })).status).toBe(1);
      expect(fs.existsSync(plistPath)).toBe(true);

      const okStop = await runScript(SERVICE_SCRIPT, sb, ["stop"]);
      expect(okStop.status).toBe(0);
      expect(fs.existsSync(plistPath)).toBe(false);
    },
    20_000,
  );
});
