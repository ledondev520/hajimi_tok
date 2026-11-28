/**
 * Input: node:crypto、node:fs、node:os、node:path、node:url 与 ./update-runtime.mjs 运行时原语。
 * Output: 导出 acquireUpdateLock / checkForUpdate / confirmAppliedUpdate / performUpdate 与自更新 CLI（--check / --no-restart / --confirm-applied / --json / --no-notify），集唯一归属锁、断点续建、ls-remote 快路径、lockfile 漂移自愈、dist 备份恢复、服务归属校验与重启 PID+探活核验于一体。
 * Pos: 哈吉米统计自动更新编排脚本，供命令行、后台静默循环与服务端 /api/update 路由共用（scripts/update.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupDist,
  buildRunEnv,
  detectInProgressGitOp,
  formatExecError,
  getLaunchdServiceInfo,
  gitExec,
  inspectPlistOwnership,
  inspectTrackedWorktree,
  isAncestor,
  queryRemoteHeadSha,
  resolveUpstreamTarget,
  restoreDistBackup,
  restoreLockfileDriftIfOnlyDirty,
  runText,
  sendNotification,
  shortSha,
  trimDaemonLogs,
  verifyRestartedService,
} from "./update-runtime.mjs";

const DEFAULT_ROOT = path.resolve(process.env.HAJIMI_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")); // 默认仓库根目录
const LAUNCHD_LABEL = process.env.HAJIMI_SERVICE_LABEL || "com.hamiji.sta"; // macOS LaunchAgent 标识
const CORRUPT_LOCK_STALE_MS = 10 * 60_000; // 仅当锁文件内容损坏无有效 PID 时，超过 10 分钟视为陈旧锁
const REAP_STALE_MS = 30_000; // 清理僵尸锁二级互斥锁超期阈值

/** 解析更新锁与断点状态落盘目录 */
function resolveStateDir(customStateDir) {
  return customStateDir || process.env.AGY_STATE_DIR?.trim() || path.join(os.homedir(), ".hamiji-sta");
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
  if (!meta.corrupt && meta.pid > 0) return !isPidAlive(meta.pid);
  const ident = getFileIdentity(lockPath);
  return Boolean(ident && Date.now() - ident.mtimeMs > CORRUPT_LOCK_STALE_MS);
}

/** 释放带唯一 token 校验的锁文件 */
function releaseTokenFile(filePath, expectedToken) {
  const cur = readLockMeta(filePath);
  if (cur && cur.token === expectedToken) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

/** 使用带唯一归属令牌的 .reap 二级原子锁清理死亡或超龄损坏主锁，二次核验文件身份与可回收条件。 */
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
          try { fs.unlinkSync(reapPath); continue; } catch { return false; }
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
    try { fs.unlinkSync(lockPath); return true; } catch { return false; }
  } finally {
    releaseTokenFile(reapPath, reapToken);
  }
}

/** 获取带唯一归属令牌的跨进程更新互斥锁（释放时严格核对 token）。 */
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

function readUpdateState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

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
      state.appliedCommit !== state.targetCommit,
  );
}

/** 判断指定 HEAD 是否存在已到目标提交但尚未完成 install/build/restart 的断点 */
function isPostMergePending(state, headFull) {
  if (!headFull || !state || typeof state !== "object") return false;
  return Boolean(
    state.targetCommit === headFull &&
      state.appliedCommit !== headFull &&
      (state.pendingInstall || state.pendingBuild || state.pendingRestart || state.pendingReinstallService),
  );
}

function hasPendingStepsForHead(state, headFull) {
  return isPreMergeIntent(state, headFull) || isPostMergePending(state, headFull);
}

/**
 * 职责：探测当前仓库与远端上游分支的同步状态（含未完成断点识别、进行中 Git 操作拦截与 ls-remote 零写入快路径）。
 */
export function checkForUpdate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_ROOT);
  const statePath = path.join(resolveStateDir(options.stateDir), "update-state.json");
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return { ok: false, available: false, behindCount: 0, dirty: false, reason: "非 Git 仓库目录" };
  }

  const env = buildRunEnv(repoRoot);
  const activeOp = detectInProgressGitOp(repoRoot, env);
  if (activeOp) {
    return { ok: false, available: false, behindCount: 0, dirty: true, reason: `检测到未完成的 Git 操作 (${activeOp})` };
  }

  const target = resolveUpstreamTarget(repoRoot, env);
  let fallbackUpstream = "";
  if (!target) {
    try {
      fallbackUpstream = gitExec(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoRoot, env, 5000);
    } catch {
      return { ok: false, available: false, behindCount: 0, dirty: false, reason: "未配置上游跟踪分支" };
    }
  }

  const currentFullCommit = gitExec(["rev-parse", "--verify", "HEAD"], repoRoot, env, 5000);
  const currentCommit = shortSha(currentFullCommit);
  const wt = inspectTrackedWorktree(repoRoot, env);
  const dirty = wt.blockingFiles.length > 0;
  const state = readUpdateState(statePath);
  const pendingSteps = hasPendingStepsForHead(state, currentFullCommit);

  // 1. 常规远端优先走 ls-remote 零 fetch 快路径（远端已是本地祖先时免去 git fetch）
  if (target) {
    let remoteSha = null;
    try {
      remoteSha = queryRemoteHeadSha(target.remote, target.branch, repoRoot, env);
    } catch (err) {
      return {
        ok: false,
        available: pendingSteps,
        behindCount: 0,
        currentCommit,
        currentFullCommit,
        dirty,
        lockfileDriftOnly: wt.lockfileDriftOnly,
        pendingSteps,
        reason: `拉取远端失败：${formatExecError(err)}`,
      };
    }

    if (!remoteSha) {
      return {
        ok: false,
        available: pendingSteps,
        behindCount: 0,
        currentCommit,
        currentFullCommit,
        dirty,
        lockfileDriftOnly: wt.lockfileDriftOnly,
        pendingSteps,
        remoteReachable: true,
        reason: `远端 ${target.remote} 未找到分支 ${target.branch}`,
      };
    }

    if (remoteSha === currentFullCommit || isAncestor(remoteSha, currentFullCommit, repoRoot, env)) {
      const latestCommit = shortSha(remoteSha);
      const latestSubject = gitExec(["log", "-1", "--format=%s", remoteSha], repoRoot, env, 5000);
      return {
        ok: true,
        available: pendingSteps,
        behindCount: 0,
        pendingSteps,
        currentCommit,
        currentFullCommit,
        latestCommit,
        latestFullCommit: remoteSha,
        latestSubject,
        upstream: target.upstream,
        dirty,
        lockfileDriftOnly: wt.lockfileDriftOnly,
      };
    }

    try {
      gitExec(["fetch", "--no-tags", target.remote, `+refs/heads/${target.branch}:${target.trackingRef}`], repoRoot, env, 30_000);
    } catch (err) {
      return {
        ok: false,
        available: pendingSteps,
        behindCount: 0,
        currentCommit,
        currentFullCommit,
        dirty,
        lockfileDriftOnly: wt.lockfileDriftOnly,
        pendingSteps,
        reason: `拉取远端失败：${formatExecError(err)}`,
      };
    }

    const latestFullCommit = gitExec(["rev-parse", "--verify", `${target.trackingRef}^{commit}`], repoRoot, env, 5000);
    const behindCount = Number(gitExec(["rev-list", `${currentFullCommit}..${latestFullCommit}`, "--count"], repoRoot, env, 5000)) || 0;
    const latestCommit = shortSha(latestFullCommit);
    const latestSubject = gitExec(["log", "-1", "--format=%s", latestFullCommit], repoRoot, env, 5000);

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
      upstream: target.upstream,
      dirty,
      lockfileDriftOnly: wt.lockfileDriftOnly,
    };
  }

  // 2. 回退分支（例如本地 `.` 跟踪配置）：沿用 git fetch --quiet 与 @{u}
  try {
    gitExec(["fetch", "--quiet"], repoRoot, env, 15_000);
  } catch (err) {
    return {
      ok: false,
      available: pendingSteps,
      behindCount: 0,
      currentCommit,
      currentFullCommit,
      dirty,
      lockfileDriftOnly: wt.lockfileDriftOnly,
      pendingSteps,
      reason: `拉取远端失败：${formatExecError(err)}`,
    };
  }

  const behindCount = Number(gitExec(["rev-list", `HEAD..${fallbackUpstream}`, "--count"], repoRoot, env, 5000)) || 0;
  const latestFullCommit = gitExec(["rev-parse", fallbackUpstream], repoRoot, env, 5000);
  const latestCommit = shortSha(latestFullCommit);
  const latestSubject = gitExec(["log", "-1", "--format=%s", fallbackUpstream], repoRoot, env, 5000);

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
    upstream: fallbackUpstream,
    dirty,
    lockfileDriftOnly: wt.lockfileDriftOnly,
  };
}

/** 由新启动的正式生产常驻进程在 update.lock 协调下调用，仅当 install 与 build 均已完成且运行 HEAD 匹配 targetCommit 时确认重启生效。 */
export function confirmAppliedUpdate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_ROOT);
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
    const env = buildRunEnv(repoRoot);
    const headFull = gitExec(["rev-parse", "HEAD"], repoRoot, env, 5000);
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
      pendingReinstallService: false,
    });
    return { confirmed: true, commit: headFull };
  } catch {
    return { confirmed: false };
  } finally {
    releaseLock();
  }
}

/**
 * 职责：在跨进程锁保护下执行安全自更新（同步契约）：
 * 1) 忽略未跟踪文件并自动还原未暂存 package-lock.json 漂移，合入前复核分支/HEAD/工作区洁净度；
 * 2) 保留跨提交断点状态机（fromCommit/targetCommit/pending*），构建前备份 dist 并在失败时原子恢复旧产物；
 * 3) 校验 launchd plist WorkingDirectory 归属与旧版迁移需求，准确输出 serviceAction（install | restart | null）。
 */
export function performUpdate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_ROOT);
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
    trimDaemonLogs(repoRoot);
    const env = buildRunEnv(repoRoot);
    let initialBranch = "";
    try { initialBranch = gitExec(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot, env, 5000); } catch { /* detached */ }

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
    let needReinstallService = Boolean(hasPending && prevState.pendingReinstallService);
    let pulled = false;
    const headBefore = status.currentFullCommit || gitExec(["rev-parse", "HEAD"], repoRoot, env, 5000);
    const isPreMergePending = isPreMergeIntent(prevState, headBefore);

    /** 合入前复核分支、HEAD 与工作区洁净度（关闭 fetch 窗口竞态）并按需还原未暂存 lockfile 漂移 */
    const prepareCleanMerge = () => {
      let branchNow = "";
      try { branchNow = gitExec(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot, env, 5000); } catch { /* detached */ }
      if (initialBranch && branchNow !== initialBranch) {
        return { ok: false, dirty: false, message: `检测到当前分支已切换 (${initialBranch} -> ${branchNow || "detached"})，已跳过更新` };
      }
      const headNow = gitExec(["rev-parse", "--verify", "HEAD"], repoRoot, env, 5000);
      if (headNow !== headBefore) {
        return { ok: false, dirty: false, message: `检测到本地 HEAD 已变化 (${shortSha(headBefore)} -> ${shortSha(headNow)})，已跳过本次更新` };
      }
      const wtNow = inspectTrackedWorktree(repoRoot, env);
      if (wtNow.blockingFiles.length > 0) {
        return { ok: false, dirty: true, message: "合入前检测到工作区新增未提交改动，已跳过自动更新" };
      }
      if (wtNow.lockfileDriftOnly) {
        gitExec(["checkout", "--", "package-lock.json"], repoRoot, env, 10_000);
      }
      return { ok: true };
    };

    // 1. 区分三种场景：在线有新提交 / 在线确认上游已回退至当前 HEAD / 离线恢复合并前固定目标
    if (status.ok && status.behindCount > 0 && status.latestFullCommit) {
      const preCheck = prepareCleanMerge();
      if (!preCheck.ok) {
        return { ...status, ok: false, updated: false, dirty: preCheck.dirty, message: preCheck.message };
      }

      const fromCommit = headBefore;
      const targetCommit = status.latestFullCommit;
      const diffRaw = gitExec(["diff", "--name-only", `${fromCommit}..${targetCommit}`], repoRoot, env, 5000);
      const changedFiles = diffRaw ? diffRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
      const diffInstall = changedFiles.some((f) => f === "package.json" || f === "package-lock.json");
      const diffBuild =
        diffInstall ||
        changedFiles.some((f) => f.startsWith("src/") || f === "index.html" || f === "vite.config.ts" || f === "tsconfig.json");
      const diffReinstallService = changedFiles.includes("scripts/service.mjs") || changedFiles.includes("scripts/compact-reminder-hook.mjs");
      const diffRestart = diffBuild || diffReinstallService || changedFiles.some((f) => f.startsWith("server/") || f.startsWith("scripts/"));

      const headItselfUnapplied = prevState.appliedCommit !== headBefore;
      needInstall = (headItselfUnapplied && needInstall) || diffInstall;
      needBuild = (headItselfUnapplied && needBuild) || diffBuild;
      needReinstallService = (headItselfUnapplied && needReinstallService) || diffReinstallService;
      needRestart = (headItselfUnapplied && needRestart) || diffRestart;

      writeUpdateState(statePath, {
        appliedCommit: prevState.appliedCommit || fromCommit,
        fromCommit,
        targetCommit,
        pendingInstall: needInstall,
        pendingBuild: needBuild,
        pendingRestart: needRestart,
        pendingReinstallService: needReinstallService,
      });

      try {
        gitExec(["merge", "--ff-only", targetCommit], repoRoot, env, 20_000);
        pulled = true;
      } catch (err) {
        writeUpdateState(statePath, prevState);
        return {
          ...status,
          ok: false,
          updated: false,
          message: `git merge --ff-only 失败（本地与远端可能分叉）：${formatExecError(err)}`,
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
          pendingReinstallService: false,
        });
        return { ...status, ok: true, updated: false, message: "已是最新版本" };
      }
    } else if (!status.ok && status.remoteReachable && isPreMergePending) {
      return { ...status, ok: false, updated: false, message: status.reason || "远端分支缺失，已跳过合并" };
    } else if (!status.ok && isPreMergePending) {
      // 1.2. 真正离线（拉取失败）且存在合并前意图：仅当本地已有固定 targetCommit 时续合并
      const pinnedTarget = prevState.targetCommit;
      let hasPinnedLocally = false;
      try {
        gitExec(["cat-file", "-e", `${pinnedTarget}^{commit}`], repoRoot, env, 3000);
        hasPinnedLocally = true;
      } catch {
        hasPinnedLocally = false;
      }
      if (!hasPinnedLocally) {
        return {
          ...status,
          ok: false,
          updated: false,
          message: `远端不可达且目标提交 ${shortSha(pinnedTarget)} 尚未拉取，已保留原更新意图等待重试`,
        };
      }
      const preCheck = prepareCleanMerge();
      if (!preCheck.ok) {
        return { ...status, ok: false, updated: false, dirty: preCheck.dirty, message: preCheck.message };
      }
      try {
        gitExec(["merge", "--ff-only", pinnedTarget], repoRoot, env, 20_000);
        pulled = true;
      } catch (err) {
        return {
          ...status,
          ok: false,
          updated: false,
          message: `续合并固定目标 ${shortSha(pinnedTarget)} 失败：${formatExecError(err)}`,
        };
      }
    }

    const headFull = gitExec(["rev-parse", "HEAD"], repoRoot, env, 5000);
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const curState = {
      appliedCommit: prevState.appliedCommit || headBefore,
      fromCommit: headFull,
      targetCommit: headFull,
      pendingInstall: needInstall,
      pendingBuild: needBuild,
      pendingRestart: needRestart,
      pendingReinstallService: needReinstallService,
    };

    if (needInstall) {
      runText(npmBin, ["install", "--no-audit", "--no-fund"], 300_000, repoRoot, env);
      restoreLockfileDriftIfOnlyDirty(repoRoot, env);
      curState.pendingInstall = false;
      writeUpdateState(statePath, curState);
    }

    if (needBuild) {
      const distBak = backupDist(repoRoot, stateDir);
      let keepBackup = false;
      try {
        runText(npmBin, ["run", "build"], 180_000, repoRoot, env);
      } catch (buildErr) {
        let restoreErrMsg = "";
        try {
          restoreDistBackup(distBak.distDir, distBak.backupDir, distBak.hadDistBefore);
        } catch (restoreErr) {
          keepBackup = true;
          restoreErrMsg = formatExecError(restoreErr);
        }
        if (restoreErrMsg) {
          throw new Error(`恢复 dist 失败: ${restoreErrMsg.slice(0, 120)} | 构建失败: ${formatExecError(buildErr).slice(0, 140)}`);
        }
        throw buildErr;
      } finally {
        if (!keepBackup && distBak.hadDistBefore && fs.existsSync(distBak.backupDir)) {
          try { fs.rmSync(distBak.backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
      curState.pendingBuild = false;
      writeUpdateState(statePath, curState);
    }

    // 2. 判定常驻服务动作：非 113 查询错误直接抛出（保留 pendingRestart 待重试）；归属不明或归属其他副本时跳过服务操作
    let svcInfo = { loaded: false, pid: null, error: null };
    let serviceAction = null;
    let ownsService = false;
    let shouldInstallService = false;
    if (needRestart) {
      svcInfo = getLaunchdServiceInfo(LAUNCHD_LABEL, env);
      if (svcInfo.error) {
        throw new Error(`查询常驻服务 ${LAUNCHD_LABEL} 状态失败: ${svcInfo.error}`);
      }
      if (svcInfo.loaded) {
        const plistInfo = inspectPlistOwnership(repoRoot, LAUNCHD_LABEL);
        if (!plistInfo.exists || plistInfo.ownedBySelf) {
          ownsService = true;
          shouldInstallService = needReinstallService || plistInfo.needsMigration;
          serviceAction = shouldInstallService ? "install" : "restart";
        }
      }
    }

    const awaitDaemonConfirm = Boolean(needRestart && (options.noRestart || ownsService));

    // 3. 在释放锁并触发重启前先落盘待重启状态，避免新进程启动确认被本进程持锁阻塞为 busy
    if (awaitDaemonConfirm) {
      writeUpdateState(statePath, {
        appliedCommit: curState.appliedCommit === headFull ? "" : curState.appliedCommit,
        fromCommit: headFull,
        targetCommit: headFull,
        pendingInstall: false,
        pendingBuild: false,
        pendingRestart: true,
        pendingReinstallService: shouldInstallService || needReinstallService,
      });
    } else {
      writeUpdateState(statePath, {
        appliedCommit: headFull,
        fromCommit: headFull,
        targetCommit: headFull,
        pendingInstall: false,
        pendingBuild: false,
        pendingRestart: false,
        pendingReinstallService: false,
      });
    }

    releaseOnce();

    let restarted = false;
    if (!options.noRestart && serviceAction && fs.existsSync(serviceScript)) {
      runText(process.execPath, [serviceScript, serviceAction], serviceAction === "install" ? 45_000 : 20_000, repoRoot, env);
      restarted = true;
    }

    const commit = shortSha(headFull);
    const subject = gitExec(["log", "-1", "--format=%s", "HEAD"], repoRoot, env, 5000);
    const steps = [];
    if (pulled) steps.push("git ff-only");
    else if (hasPending) steps.push("断点续建");
    if (needInstall) steps.push("npm install");
    if (needBuild) steps.push("npm run build");
    if (restarted) steps.push(serviceAction === "install" ? "已重装并重启服务" : "已派发服务重启");
    else if (awaitDaemonConfirm) steps.push("待重启生效");

    const didApplyWork = pulled || needInstall || needBuild || restarted || Boolean(options.noRestart && serviceAction);
    const message = didApplyWork
      ? `已更新至 ${commit}（${steps.join(" + ")}）`
      : `当前代码已是 ${commit}（待常驻服务重启确认生效）`;

    return {
      ok: true,
      updated: didApplyWork,
      commit,
      subject,
      behindCount: status.behindCount,
      needInstall,
      needBuild,
      needRestart,
      needReinstallService: shouldInstallService,
      serviceAction,
      prevPid: svcInfo.pid,
      restarted,
      pendingRestart: awaitDaemonConfirm,
      message,
    };
  } finally {
    releaseOnce();
  }
}

// 4. CLI 入口执行
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const argv = process.argv.slice(2);
  const allowed = new Set(["--json", "--check", "--confirm-applied", "--no-restart", "--no-notify", "--notify", "--help", "-h"]);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("用法: node scripts/update.mjs [--check] [--confirm-applied] [--json] [--no-restart] [--no-notify|--notify]");
    process.exit(0);
  }
  const unknown = argv.find((a) => !allowed.has(a));
  if (unknown) {
    console.error(`✗ 未知参数: ${unknown}`);
    process.exit(2);
  }

  const asJson = argv.includes("--json");
  const isCheckOnly = argv.includes("--check");
  const isConfirmApplied = argv.includes("--confirm-applied");
  const noRestart = argv.includes("--no-restart");
  const notifyEnabled = argv.includes("--no-notify")
    ? false
    : argv.includes("--notify")
      ? true
      : process.env.AGY_UPDATE_NOTIFY !== "0";

  (async () => {
    const env = buildRunEnv(DEFAULT_ROOT);
    let res = isConfirmApplied
      ? confirmAppliedUpdate()
      : isCheckOnly
        ? checkForUpdate()
        : performUpdate({ noRestart });

    // CLI 直接重启后核验 launchd 新 PID 切换与 /api/health 就绪
    if (!isConfirmApplied && !isCheckOnly && res.ok && res.updated && res.restarted && process.platform === "darwin") {
      const verify = await verifyRestartedService(res.prevPid ?? null, LAUNCHD_LABEL, env);
      if (!verify.ok) {
        res = { ...res, ok: false, verified: false, message: `服务重启后健康校验失败: ${verify.reason}` };
      } else {
        res = { ...res, verified: true, pid: verify.pid };
      }
    }

    const { prevPid: _p, ...output } = res;
    if (!isConfirmApplied && !isCheckOnly) {
      if (output.ok && output.updated) {
        sendNotification(notifyEnabled, "哈吉米统计已自动更新", `${output.commit} (${output.message})`, output.subject || "", env);
      } else if (!output.ok && !output.busy) {
        sendNotification(notifyEnabled, "哈吉米统计自动更新异常", "本次更新未完成，请检查日志或工作区", output.message || "", env);
      }
    }

    if (asJson) {
      console.log(JSON.stringify(output));
    } else if (isConfirmApplied) {
      console.log(output.confirmed ? `✓ 已确认生效 (${output.commit})` : "· 无需确认");
    } else if (isCheckOnly) {
      console.log(
        output.available
          ? output.pendingSteps && output.behindCount === 0
            ? `检测到上次更新有未完成构建或重启步骤 (${output.currentCommit})`
            : `发现 ${output.behindCount} 个新提交 (${output.currentCommit} -> ${output.latestCommit}: ${output.latestSubject})`
          : output.ok
            ? `✓ 已是最新版本 (${output.currentCommit})`
            : `✗ ${output.reason}`,
      );
    } else {
      console.log(output.ok ? `✓ ${output.message}` : `✗ ${output.message}`);
    }
    if (!isConfirmApplied && !output.ok && !isCheckOnly) process.exit(1);
  })().catch((err) => {
    const msg = formatExecError(err);
    if (!isConfirmApplied && !isCheckOnly) {
      sendNotification(notifyEnabled, "哈吉米统计自动更新异常", "更新执行异常，请检查日志", msg, buildRunEnv(DEFAULT_ROOT));
    }
    if (asJson) {
      console.log(JSON.stringify({ ok: false, updated: false, message: msg }));
    } else {
      console.error(`✗ 更新失败: ${msg}`);
    }
    process.exit(1);
  });
}
