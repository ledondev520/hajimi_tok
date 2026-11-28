/**
 * Input: vitest、node:child_process、node:fs、node:os、node:path，调用 scripts/update.mjs 与 scripts/service.mjs。
 * Output: 验证轻量手动更新脚本（脏工作区拦截、ff-only 拉取、按需 npm ci + build + 重启）与 service.mjs（PATH/HOME 注入、旧 plist 迁移、bootstrap 回退与 stop 防误删）。
 * Pos: 更新与常驻服务脚本隔离沙箱测试套件（tests/update.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const UPDATE_SCRIPT = path.resolve(import.meta.dirname, "../scripts/update.mjs");
const SERVICE_SCRIPT = path.resolve(import.meta.dirname, "../scripts/service.mjs");
const tempDirs: string[] = [];
const activeChildren = new Set<ChildProcess>();

afterEach(() => {
  for (const child of activeChildren) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  activeChildren.clear();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface SandboxRepo {
  baseDir: string;
  workDir: string;
  seedDir: string;
  binDir: string;
  launchAgentsDir: string;
  callLogPath: string;
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

function createSandbox(): SandboxRepo {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "hajimi-update-lean-"));
  tempDirs.push(baseDir);

  const remoteDir = path.join(baseDir, "remote.git");
  const seedDir = path.join(baseDir, "seed");
  const workDir = path.join(baseDir, "local");
  const binDir = path.join(baseDir, "bin");
  const launchAgentsDir = path.join(baseDir, "LaunchAgents");
  const callLogPath = path.join(baseDir, "calls.jsonl");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(launchAgentsDir, { recursive: true });

  gitIn(baseDir, ["init", "--bare", "-b", "master", remoteDir]);
  gitIn(baseDir, ["clone", remoteDir, seedDir]);
  fs.mkdirSync(path.join(seedDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "app.txt"), "v1\n", "utf8");
  fs.writeFileSync(path.join(seedDir, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  fs.writeFileSync(path.join(seedDir, "package.json"), JSON.stringify({ name: "hamiji-sta", scripts: { build: "true" } }), "utf8");
  fs.writeFileSync(
    path.join(seedDir, "scripts/service.mjs"),
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify({ cmd: "service.mjs", args: process.argv.slice(2) }) + "\\n");`,
    "utf8"
  );
  gitIn(seedDir, ["add", "."]);
  gitIn(seedDir, ["commit", "-m", "init"]);
  gitIn(seedDir, ["push", "-u", "origin", "master"]);
  gitIn(baseDir, ["clone", remoteDir, workDir]);

  const nodeBin = process.execPath;
  writeExecutable(
    path.join(binDir, "launchctl"),
    `#!${nodeBin}
const fs = require("node:fs");
const args = process.argv.slice(2);
const loadedMarker = ${JSON.stringify(path.join(baseDir, "service.loaded"))};
fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify({ cmd: "launchctl", args }) + "\\n");
if (args[0] === "print") {
  if (process.env.TEST_PRINT_FAIL === "1") process.exit(1);
  if (fs.existsSync(loadedMarker)) { console.log("state = running\\n\\tpid = 2001"); process.exit(0); }
  process.exit(113);
}
if (args[0] === "bootstrap") {
  const failMarker = ${JSON.stringify(path.join(baseDir, "bootstrap.failed-once"))};
  if (process.env.TEST_BOOTSTRAP_FAIL_ONCE === "1" && !fs.existsSync(failMarker)) { fs.writeFileSync(failMarker, "1"); process.exit(5); }
  fs.writeFileSync(loadedMarker, "1");
  process.exit(0);
}
if (args[0] === "bootout") {
  if (process.env.TEST_BOOTOUT_FAIL === "1") process.exit(1);
  fs.rmSync(loadedMarker, { force: true });
  process.exit(0);
}
process.exit(0);
`
  );
  writeExecutable(
    path.join(binDir, "npm"),
    `#!${nodeBin}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify({ cmd: "npm", args: process.argv.slice(2) }) + "\\n");
process.exit(0);
`
  );

  return { baseDir, workDir, seedDir, binDir, launchAgentsDir, callLogPath };
}

function readCalls(callLogPath: string): Array<{ cmd: string; args: string[] }> {
  if (!fs.existsSync(callLogPath)) return [];
  return fs.readFileSync(callLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { cmd: string; args: string[] });
}

function runScript(
  scriptPath: string,
  sb: SandboxRepo,
  args: string[],
  extraEnv?: Record<string, string>
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", scriptPath, ...args], {
      cwd: sb.workDir,
      env: cleanGitEnv({
        PATH: `${sb.binDir}${path.delimiter}${process.env.PATH || ""}`,
        HAJIMI_ROOT: sb.workDir,
        HAJIMI_LAUNCH_AGENTS_DIR: sb.launchAgentsDir,
        HAJIMI_SERVICE_LABEL: "com.hamiji.sta.test",
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

describe("lean scripts/update.mjs & scripts/service.mjs", () => {
  it("refuses dirty worktree, pulls ff-only cleanly, runs npm ci on lock change, builds, and restarts owned service", async () => {
    const sb = createSandbox();
    fs.writeFileSync(path.join(sb.workDir, "app.txt"), "dirty\n", "utf8");
    const dirtyRes = await runScript(UPDATE_SCRIPT, sb, []);
    expect(dirtyRes.status).toBe(1);
    gitIn(sb.workDir, ["checkout", "--", "app.txt"]);

    // 远端更新代码与锁文件
    fs.writeFileSync(path.join(sb.seedDir, "app.txt"), "v2\n", "utf8");
    fs.writeFileSync(path.join(sb.seedDir, "package-lock.json"), '{"lockfileVersion":3,"v":2}\n', "utf8");
    gitIn(sb.seedDir, ["add", "."]);
    gitIn(sb.seedDir, ["commit", "-m", "v2"]);
    gitIn(sb.seedDir, ["push", "origin", "master"]);

    const plistPath = path.join(sb.launchAgentsDir, "com.hamiji.sta.test.plist");
    fs.writeFileSync(plistPath, `<plist><dict><key>WorkingDirectory</key><string>${sb.workDir}</string></dict></plist>`, "utf8");

    const okRes = await runScript(UPDATE_SCRIPT, sb, []);
    expect(okRes.status).toBe(0);
    expect(fs.readFileSync(path.join(sb.workDir, "app.txt"), "utf8")).toBe("v2\n");
    const calls = readCalls(sb.callLogPath);
    expect(calls.some((c) => c.cmd === "npm" && c.args[0] === "ci")).toBe(true);
    expect(calls.some((c) => c.cmd === "npm" && c.args[0] === "run" && c.args[1] === "build")).toBe(true);
    if (process.platform === "darwin") {
      expect(calls.some((c) => c.cmd === "service.mjs" && c.args[0] === "restart")).toBe(true);
    }

    // 已最新时直接跳过
    const noopRes = await runScript(UPDATE_SCRIPT, sb, []);
    expect(noopRes.status).toBe(0);
    expect(noopRes.stdout).toContain("已是最新");
  }, 20_000);

  it.skipIf(process.platform !== "darwin")(
    "manages com.hamiji.sta plist: injects PATH/HOME, migrates legacy plist, recovers on bootstrap failure, and guards stop",
    async () => {
      const sb = createSandbox();
      const plistPath = path.join(sb.launchAgentsDir, "com.hamiji.sta.test.plist");
      const legacyXml = `<plist><dict><key>WorkingDirectory</key><string>${sb.workDir}</string><key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string>--max-old-space-size=2048</string><key>AGY_DATA_DIR</key><string>/custom/data</string><key>PATH</key><string>/custom/tools/bin:/usr/bin</string></dict></dict></plist>`;
      fs.writeFileSync(plistPath, legacyXml, { encoding: "utf8", mode: 0o600 });

      expect((await runScript(SERVICE_SCRIPT, sb, ["restart"], { PATH: `${sb.binDir}:/usr/bin:/bin` })).status).toBe(0);
      const xml = fs.readFileSync(plistPath, "utf8");
      expect(xml).toContain("<key>PATH</key>");
      expect(xml).toContain("<key>HOME</key>");
      expect(xml).toContain("<string>/custom/data</string>");
      expect(xml).toContain("--max-old-space-size=2048 --no-warnings");

      // bootstrap 失败回滚旧 plist
      fs.writeFileSync(plistPath, legacyXml, "utf8");
      expect((await runScript(SERVICE_SCRIPT, sb, ["install"], { TEST_BOOTSTRAP_FAIL_ONCE: "1" })).status).toBe(1);
      expect(fs.readFileSync(plistPath, "utf8")).toBe(legacyXml);

      // stop 失败绝不误删 plist
      fs.rmSync(path.join(sb.baseDir, "bootstrap.failed-once"), { force: true });
      expect((await runScript(SERVICE_SCRIPT, sb, ["install"])).status).toBe(0);
      expect((await runScript(SERVICE_SCRIPT, sb, ["stop"], { TEST_BOOTOUT_FAIL: "1" })).status).toBe(1);
      expect(fs.existsSync(plistPath)).toBe(true);
      expect((await runScript(SERVICE_SCRIPT, sb, ["stop"])).status).toBe(0);
      expect(fs.existsSync(plistPath)).toBe(false);
    },
    20_000
  );
});
