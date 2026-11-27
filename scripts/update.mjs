/**
 * Input: node:child_process、node:crypto、node:fs、node:os、node:path、node:url 与本地 Git / npm / launchctl 命令。
 * Output: 一键安全检查与自更新脚本（npm run update / --check / --no-restart / --confirm-applied），带唯一归属锁、跨提交断点恢复与重启生效确认。
 * Pos: 哈吉米统计自动更新编排脚本，供命令行、后台静默循环与服务端 /api/update 路由共用（scripts/update.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // 默认仓库根目录
const LAUNCHD_LABEL = "com.hamiji.sta"; // macOS LaunchAgent 标识
const CORRUPT_LOCK_STALE_MS = 10 * 60_000; // 仅当锁文件内容损坏无有效 PID 时，超过 10 分钟视为陈旧锁
const REAP_STALE_MS = 30_000; // 清理僵尸锁二级互斥锁超期阈值

/** 解析更新锁与断点状态落盘目录 */
function resolveStateDir(customStateDir) {
  return customStateDir || process.env.AGY_STATE_DIR?.trim() || path.join(os.homedir(), ".hamiji-sta");
}

/** 在指定仓库目录同步执行子命令并返回标准输出文本 */
function runText(cmd, args, timeoutMs = 15_000, cwd = DEFAULT_ROOT) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** 判断指定 PID 进程是否仍存活（存活持有人绝不因锁龄被抢占） */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && typeof err === "object" && err.code === "EPERM");
  }
}

/** 读取文件稳定身份指纹（dev:ino:mtimeMs:size），供损坏/无 PID 锁二次校验避免误删新建锁 */
function getFileIdentity(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { id: `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** 读取锁文件归属元数据（非法/缺失 PID 统一归一化为 0，避免 NaN 自比不等） */
function readLockMeta(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rawPid = Number(parsed.pid);
      const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : 0;
      const token = typeof parsed.token === "string" ? parsed.token : "";
      return { pid, token, startedAt: Number(parsed.startedAt || 0), corrupt: pid === 0 };
    }
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return null;
  }
  return { pid: 0, token: "", startedAt: 0, corrupt: true };
}

/** 判定现有锁是否可安全回收：存活 PID 永不回收；仅死进程或超龄损坏锁可回收 */
function isLockReapable(lockPath, meta) {
  if (!meta) return false;
  if (!meta.corrupt && meta.pid > 0) {
    return !isPidAlive(meta.pid);
  }
  const ident = getFileIdentity(lockPath);
  return Boolean(ident && Date.now() - ident.mtimeMs > CORRUPT_LOCK_STALE_MS);
}

/** 释放带唯一 token 校验的锁文件 */
function releaseTokenFile(filePath, expectedToken) {
  const cur = readLockMeta(filePath);
  if (cur && cur.token === expectedToken) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 职责：使用带唯一归属令牌的 .reap 二级原子锁清理死亡或超龄损坏主锁，二次核验文件身份与可回收条件。
 */
function tryReapStaleLock(lockPath, expectedFileId) {
  const reapPath = `${lockPath}.reap`;
  const reapToken = `reap:${process.pid}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
  let acquiredReap = false;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(reapPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: reapToken, startedAt: Date.now() }), "utf8");
      fs.closeSync(fd);
      acquiredReap = true;
      break;
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "EEXIST") return false;
      if (i === 0) {
        const rIdent = getFileIdentity(reapPath);
        const rm = readLockMeta(reapPath);
        const reapDead =
          (rm && !rm.corrupt && rm.pid > 0 && !isPidAlive(rm.pid)) ||
          Boolean(rm && rm.corrupt && rIdent && Date.now() - rIdent.mtimeMs > REAP_STALE_MS);
        if (reapDead && rIdent && getFileIdentity(reapPath)?.id === rIdent.id) {
          try {
            fs.unlinkSync(reapPath);
            continue;
          } catch {
            return false;
          }
        }
      }
      return false;
    }
  }
  if (!acquiredReap) return false;

  try {
    const afterIdent = getFileIdentity(lockPath);
    if (!afterIdent || afterIdent.id !== expectedFileId) return false;
    const cur = readLockMeta(lockPath);
    if (!cur || !isLockReapable(lockPath, cur)) return false;
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    releaseTokenFile(reapPath, reapToken);
  }
}

/**
 * 职责：获取带唯一归属令牌的跨进程更新互斥锁（释放时严格核对 token）。
 */
export function acquireUpdateLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const myToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: myToken, startedAt: Date.now() }), "utf8");
      fs.closeSync(fd);
      return () => releaseTokenFile(lockPath, myToken);
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "EEXIST") throw err;
      const ident = getFileIdentity(lockPath);
      const cur = readLockMeta(lockPath);
      if (attempt === 0 && ident && cur && isLockReapable(lockPath, cur)) {
        if (tryReapStaleLock(lockPath, ident.id)) continue;
      }
      return null;
    }
  }
  return null;
}

/** 读取上次更新断点状态 */
function readUpdateState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 原子落盘更新断点状态 */
function writeUpdateState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, statePath);
}

/** 判断指定 HEAD 是否存在尚未合并的跨提交意图（HEAD === fromCommit 且 targetCommit !== fromCommit 且目标尚未生效） */
function isPreMergeIntent(state, headFull) {
  if (!headFull || !state || typeof state !== "object") return false;
  return Boolean(
    state.fromCommit === headFull &&
      state.targetCommit &&
      state.targetCommit !== headFull &&
      state.appliedCommit !== state.targetCommit
  );
}

/** 判断指定 HEAD 是否存在已到目标提交但尚未完成 install/build/restart 的断点 */
function isPostMergePending(state, headFull) {
  if (!headFull || !state || typeof state !== "object") return false;
  return Boolean(
    state.targetCommit === headFull &&
      state.appliedCommit !== headFull &&
      (state.pendingInstall || state.pendingBuild || state.pendingRestart)
  );
}

/** 判断指定 HEAD 是否存在未完成的合并前意图或合并后断点 */
function hasPendingStepsForHead(state, headFull) {
  return isPreMergeIntent(state, headFull) || isPostMergePending(state, headFull);
}

/**
 * 职责：探测当前仓库与远端上游分支的同步状态（含未完成 install/build/restart 断点识别）。
 */
export function checkForUpdate(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_ROOT;
  const statePath = path.join(resolveStateDir(options.stateDir), "update-state.json");
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return { ok: false, available: false, behindCount: 0, dirty: false, reason: "非 Git 仓库目录" };
  }

  let upstream = "";
  try {
    upstream = runText("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 5000, repoRoot);
  } catch {
    return { ok: false, available: false, behindCount: 0, dirty: false, reason: "未配置上游跟踪分支" };
  }

  const currentCommit = runText("git", ["rev-parse", "--short", "HEAD"], 5000, repoRoot);
  const currentFullCommit = runText("git", ["rev-parse", "HEAD"], 5000, repoRoot);
  const dirty = Boolean(runText("git", ["status", "--porcelain"], 5000, repoRoot));
  const state = readUpdateState(statePath);
  const pendingSteps = hasPendingStepsForHead(state, currentFullCommit);

  try {
    runText("git", ["fetch", "--quiet"], 12_000, repoRoot);
  } catch (err) {
    return {
      ok: false,
      available: pendingSteps,
      behindCount: 0,
      currentCommit,
      currentFullCommit,
      dirty,
      pendingSteps,
      reason: `拉取远端失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  }

  const behindCount = Number(runText("git", ["rev-list", `HEAD..${upstream}`, "--count"], 5000, repoRoot)) || 0;
  const latestCommit = runText("git", ["rev-parse", "--short", upstream], 5000, repoRoot);
  const latestFullCommit = runText("git", ["rev-parse", upstream], 5000, repoRoot);
  const latestSubject = runText("git", ["log", "-1", "--format=%s", upstream], 5000, repoRoot);

  return {
    ok: true,
    available: behindCount > 0 || pendingSteps,
    behindCount,
    pendingSteps,
    currentCommit,
    currentFullCommit,
    latestCommit,
    latestFullCommit,
    latestSubject,
    upstream,
    dirty,
  };
}

/** 检测 macOS LaunchAgent 常驻服务是否已注册运行 */
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
 * 职责：由新启动的正式生产常驻进程在 update.lock 协调下调用，仅当 install 与 build 均已完成且运行 HEAD 匹配 targetCommit 时确认重启生效。
 */
export function confirmAppliedUpdate(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_ROOT;
  const stateDir = resolveStateDir(options.stateDir);
  const lockPath = path.join(stateDir, "update.lock");
  const statePath = path.join(stateDir, "update-state.json");
  if (!fs.existsSync(statePath)) return { confirmed: false };

  const releaseLock = acquireUpdateLock(lockPath);
  if (!releaseLock) return { confirmed: false, busy: true };

  try {
    const state = readUpdateState(statePath);
    if (!state.pendingRestart || state.pendingInstall || state.pendingBuild) {
      return { confirmed: false };
    }
    const headFull = runText("git", ["rev-parse", "HEAD"], 5000, repoRoot);
    if (!headFull || state.targetCommit !== headFull) {
      return { confirmed: false };
    }
    writeUpdateState(statePath, {
      appliedCommit: headFull,
      fromCommit: headFull,
      targetCommit: headFull,
      pendingInstall: false,
      pendingBuild: false,
      pendingRestart: false,
    });
    return { confirmed: true, commit: headFull };
  } catch {
    return { confirmed: false };
  } finally {
    releaseLock();
  }
}

/**
 * 职责：在跨进程锁保护下执行安全一键更新：
 * 1) 拉取或断点续建均校验工作区干净；
 * 2) 合并前同时落盘 fromCommit 与 targetCommit 保留跨目标待建意图；
 * 3) 需要重启且由调用方或 launchd 接手时保留 pendingRestart=true，待新版本正式服务监听后确认生效。
 */
export function performUpdate(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_ROOT;
  const serviceScript = path.join(repoRoot, "scripts", "service.mjs");
  const stateDir = resolveStateDir(options.stateDir);
  const lockPath = path.join(stateDir, "update.lock");
  const statePath = path.join(stateDir, "update-state.json");

  const releaseLock = acquireUpdateLock(lockPath);
  if (!releaseLock) {
    return { ok: false, updated: false, busy: true, message: "已有更新任务正在执行，请稍候" };
  }
  let lockReleased = false;
  const releaseOnce = () => {
    if (!lockReleased) {
      lockReleased = true;
      releaseLock();
    }
  };

  try {
    const status = checkForUpdate({ repoRoot, stateDir });
    const prevState = readUpdateState(statePath);
    const hasPending = Boolean(status.pendingSteps);

    if (!status.ok && !hasPending) {
      return { ...status, ok: false, updated: false, message: status.reason || "检查更新失败" };
    }
    if (!status.available && !hasPending) {
      return { ...status, ok: true, updated: false, message: "已是最新版本" };
    }
    if (status.dirty) {
      return {
        ...status,
        ok: false,
        updated: false,
        message: "工作区有未提交改动，已跳过自动更新与续建（请先提交或暂存本地修改）",
      };
    }

    let needInstall = Boolean(hasPending && prevState.pendingInstall);
    let needBuild = Boolean(hasPending && prevState.pendingBuild);
    let needRestart = Boolean(hasPending && prevState.pendingRestart);
    let pulled = false;
    const headBefore = status.currentFullCommit || runText("git", ["rev-parse", "HEAD"], 5000, repoRoot);
    const isPreMergePending = isPreMergeIntent(prevState, headBefore);

    // 1. 区分三种场景：在线有新提交 / 在线确认上游已回退至当前 HEAD / 离线恢复合并前固定目标
    if (status.ok && status.behindCount > 0 && status.latestFullCommit) {
      const fromCommit = headBefore;
      const targetCommit = status.latestFullCommit;
      const diffRaw = runText("git", ["diff", "--name-only", `HEAD..${targetCommit}`], 5000, repoRoot);
      const changedFiles = diffRaw ? diffRaw.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      const diffInstall = changedFiles.some((f) => f === "package.json" || f === "package-lock.json");
      const diffBuild =
        diffInstall ||
        changedFiles.some(
          (f) => f.startsWith("src/") || f === "index.html" || f === "vite.config.ts" || f === "tsconfig.json"
        );
      const diffRestart =
        diffBuild || changedFiles.some((f) => f.startsWith("server/") || f.startsWith("scripts/"));

      const headItselfUnapplied = prevState.appliedCommit !== headBefore;
      needInstall = (headItselfUnapplied && needInstall) || diffInstall;
      needBuild = (headItselfUnapplied && needBuild) || diffBuild;
      needRestart = (headItselfUnapplied && needRestart) || diffRestart;

      writeUpdateState(statePath, {
        appliedCommit: prevState.appliedCommit || fromCommit,
        fromCommit,
        targetCommit,
        pendingInstall: needInstall,
        pendingBuild: needBuild,
        pendingRestart: needRestart,
      });

      try {
        runText("git", ["merge", "--ff-only", targetCommit], 20_000, repoRoot);
        pulled = true;
      } catch (err) {
        writeUpdateState(statePath, prevState);
        return {
          ...status,
          ok: false,
          updated: false,
          message: `git merge --ff-only 失败（本地与远端可能分叉）：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        };
      }
    } else if (status.ok && status.behindCount === 0 && isPreMergePending) {
      // 1.1. 在线已确认上游权威位置即当前 HEAD（旧目标 C 已被上游撤回），绝不合并已撤回的 C
      if (prevState.appliedCommit === headBefore) {
        writeUpdateState(statePath, {
          appliedCommit: headBefore,
          fromCommit: headBefore,
          targetCommit: headBefore,
          pendingInstall: false,
          pendingBuild: false,
          pendingRestart: false,
        });
        return { ...status, ok: true, updated: false, message: "已是最新版本" };
      }
      // 当前 HEAD 自身尚有待建步骤时，继续仅在当前 HEAD 上完成续建，不再合并旧 C
    } else if (!status.ok && isPreMergePending) {
      // 1.2. 真正离线（fetch 失败）且存在合并前意图：仅当本地已有固定 targetCommit 时续合并，否则保留原意图待重试
      const pinnedTarget = prevState.targetCommit;
      let hasPinnedLocally = false;
      try {
        runText("git", ["cat-file", "-e", `${pinnedTarget}^{commit}`], 3000, repoRoot);
        hasPinnedLocally = true;
      } catch {
        hasPinnedLocally = false;
      }
      if (!hasPinnedLocally) {
        return {
          ...status,
          ok: false,
          updated: false,
          message: `远端不可达且目标提交 ${pinnedTarget.slice(0, 7)} 尚未拉取，已保留原更新意图等待重试`,
        };
      }
      try {
        runText("git", ["merge", "--ff-only", pinnedTarget], 20_000, repoRoot);
        pulled = true;
      } catch (err) {
        return {
          ...status,
          ok: false,
          updated: false,
          message: `续合并固定目标 ${pinnedTarget.slice(0, 7)} 失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        };
      }
    }

    const headFull = runText("git", ["rev-parse", "HEAD"], 5000, repoRoot);
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const curState = {
      appliedCommit: prevState.appliedCommit || headBefore,
      fromCommit: headFull,
      targetCommit: headFull,
      pendingInstall: needInstall,
      pendingBuild: needBuild,
      pendingRestart: needRestart,
    };

    if (needInstall) {
      runText(npmBin, ["install", "--no-audit", "--no-fund"], 120_000, repoRoot);
      curState.pendingInstall = false;
      writeUpdateState(statePath, curState);
    }
    if (needBuild) {
      runText(npmBin, ["run", "build"], 120_000, repoRoot);
      curState.pendingBuild = false;
      writeUpdateState(statePath, curState);
    }

    const serviceLoaded = isLaunchdServiceLoaded();
    const awaitDaemonConfirm = Boolean(needRestart && (options.noRestart || serviceLoaded));

    // 2. 在释放锁并触发重启前先将待重启状态落盘，释放锁后再派发重启脚本，避免新进程启动确认被本进程持锁阻塞为 busy
    if (awaitDaemonConfirm) {
      writeUpdateState(statePath, {
        appliedCommit: curState.appliedCommit === headFull ? "" : curState.appliedCommit,
        fromCommit: headFull,
        targetCommit: headFull,
        pendingInstall: false,
        pendingBuild: false,
        pendingRestart: true,
      });
    } else {
      writeUpdateState(statePath, {
        appliedCommit: headFull,
        fromCommit: headFull,
        targetCommit: headFull,
        pendingInstall: false,
        pendingBuild: false,
        pendingRestart: false,
      });
    }

    releaseOnce();

    let restarted = false;
    if (!options.noRestart && needRestart && serviceLoaded && fs.existsSync(serviceScript)) {
      runText(process.execPath, [serviceScript, "restart"], 15_000, repoRoot);
      restarted = true;
    }

    const commit = runText("git", ["rev-parse", "--short", "HEAD"], 5000, repoRoot);
    const subject = runText("git", ["log", "-1", "--format=%s", "HEAD"], 5000, repoRoot);
    const steps = [];
    if (pulled) steps.push("git ff-only");
    else if (hasPending) steps.push("断点续建");
    if (needInstall) steps.push("npm install");
    if (needBuild) steps.push("npm run build");
    if (restarted) steps.push("已派发服务重启");
    else if (awaitDaemonConfirm) steps.push("待重启生效");

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
      pendingRestart: awaitDaemonConfirm,
      message: `已更新至 ${commit}（${steps.join(" + ")}）`,
    };
  } finally {
    releaseOnce();
  }
}

// 3. CLI 入口执行
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has("--json");
  const isCheckOnly = args.has("--check");
  const isConfirmApplied = args.has("--confirm-applied");
  const noRestart = args.has("--no-restart");

  try {
    const res = isConfirmApplied
      ? confirmAppliedUpdate()
      : isCheckOnly
        ? checkForUpdate()
        : performUpdate({ noRestart });
    if (asJson) {
      console.log(JSON.stringify(res));
    } else if (isConfirmApplied) {
      console.log(res.confirmed ? `✓ 已确认生效 (${res.commit})` : "· 无需确认");
    } else if (isCheckOnly) {
      console.log(
        res.available
          ? res.pendingSteps && res.behindCount === 0
            ? `检测到上次更新有未完成构建或重启步骤 (${res.currentCommit})`
            : `发现 ${res.behindCount} 个新提交 (${res.currentCommit} -> ${res.latestCommit}: ${res.latestSubject})`
          : res.ok
            ? `✓ 已是最新版本 (${res.currentCommit})`
            : `✗ ${res.reason}`
      );
    } else {
      console.log(res.ok ? `✓ ${res.message}` : `✗ ${res.message}`);
    }
    if (!isConfirmApplied && !res.ok && !isCheckOnly) process.exit(1);
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
