/**
 * Input: node:fs、node:path 与 ../src/types/telemetry 的 ConversationDetail 类型。
 * Output: 导出 TEMP_CHAT_WORKSPACE、parseWorkspaceUris、normalizeConversationWorkspaces 与 filterEmptyConversations。
 * Pos: 服务端工作区归一化与空壳会话治理模块，将 git/T3/Swarm 工作树归并至真实项目名、合并未绑定与临时目录为「临时对话」并过滤无调用空壳。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import fs from "node:fs";
import path from "node:path";
import type { ConversationDetail } from "../src/types/telemetry";

export const TEMP_CHAT_WORKSPACE = "临时对话"; // 未绑定工作区、临时测试目录、脑区 scratch 与孤儿 Swarm 的统一归并名

const GIT_WORKTREE_CACHE = new Map<string, string | null>(); // worktree 路径 -> 主仓库根路径缓存
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SWARM_PATH_RE = new RegExp(`[/\\\\]worktrees[/\\\\](${UUID_RE})[/\\\\](?:swarm-|[^/\\\\]+-[0-9a-f]{6,}$)`, "i");
const T3_WORKTREE_PATH_RE = /[/\\]\.t3[/\\]worktrees[/\\]([^/\\]+)[/\\][^/\\]+$/i;
const T3_HASH_NAME_RE = /^t3-[0-9a-f]{6,}-[0-9a-f]{6,}$/i;
const SWARM_HASH_NAME_RE = /^swarm-[a-z0-9_-]+-[0-9a-f]{6,}$/i;

/** 读取 git worktree 的 .git 指针文件并反查主仓库根路径（带缓存） */
function resolveGitWorktreeMainRepo(worktreePath: string): string | null {
  if (!worktreePath) return null;
  if (GIT_WORKTREE_CACHE.has(worktreePath)) return GIT_WORKTREE_CACHE.get(worktreePath) ?? null;
  let mainRepo: string | null = null;
  try {
    const dotGit = path.join(worktreePath, ".git");
    if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
      const raw = fs.readFileSync(dotGit, "utf8").slice(0, 512);
      const m = raw.match(/^\s*gitdir:\s*(.+?)\s*$/m);
      if (m) {
        const resolvedGitDir = path.isAbsolute(m[1]) ? m[1] : path.resolve(worktreePath, m[1]);
        const wtMatch = resolvedGitDir.match(/^(.+?)[/\\]\.git[/\\]worktrees[/\\][^/\\]+[/\\]?$/i);
        if (wtMatch && wtMatch[1]) {
          mainRepo = wtMatch[1].replace(/[/\\]+$/, "");
        }
      }
    }
  } catch { /* 忽略不可读 worktree */ }
  if (GIT_WORKTREE_CACHE.size >= 256) GIT_WORKTREE_CACHE.clear();
  GIT_WORKTREE_CACHE.set(worktreePath, mainRepo);
  return mainRepo;
}

/** 从已删除的 T3 worktree 路径中提取正式项目名（如 ~/.t3/worktrees/<project>/t3-xxx） */
function extractT3WorktreeProject(workspacePath: string): string | null {
  const m = workspacePath.match(T3_WORKTREE_PATH_RE);
  return m && m[1] ? m[1].trim() : null;
}

/** 从 Swarm / ACP 工作树路径提取父协调者会话 UUID */
export function extractSwarmCoordinatorId(workspacePath: string): string | null {
  const m = workspacePath.match(SWARM_PATH_RE);
  return m && m[1] ? m[1] : null;
}

/** 判定路径是否属于系统临时目录、安装探针或脑区 scratch 测试目录 */
function isTempOrScratchWorkspace(workspacePath: string): boolean {
  if (!workspacePath) return false;
  if (/^\/(?:private\/)?tmp$/i.test(workspacePath)) return true;
  if (/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/i.test(workspacePath)) return true;
  if (/[/\\](?:\.gemini[/\\]antigravity|antigravity-acp)[/\\]brain[/\\][^/\\]+[/\\]scratch(?:[/\\]|$)/i.test(workspacePath)) return true;
  if (/[/\\]antigravity-tmp[/\\]/i.test(workspacePath)) return true;
  if (/^\/(?:private\/)?tmp\/(?:t3-antigravity-setup-|agy-rule-check-|tmp[_-]?[a-z0-9]{5,})/i.test(workspacePath)) return true;
  return false;
}

/** 判定工作区是否为 Swarm 临时工作树 */
export function isEphemeralSwarmWorkspace(name: string, wsPath: string): boolean {
  return SWARM_HASH_NAME_RE.test(name) || extractSwarmCoordinatorId(wsPath) !== null;
}

/** 判定工作区是否为非正式项目占位名（空、临时对话、t3 哈希或 Swarm 工作树） */
export function isNonProjectWorkspace(name: string, wsPath: string): boolean {
  return (
    !name ||
    name === TEMP_CHAT_WORKSPACE ||
    T3_HASH_NAME_RE.test(name) ||
    isEphemeralSwarmWorkspace(name, wsPath)
  );
}

/**
 * 职责：解析 workspace_uris JSON 字段，解码 file:// URI 并自动归一化 git/T3 worktree 及临时/未绑定目录。
 * 思路：1) 解码首个 URI 为本地路径，空路径归入「临时对话」；2) 优先通过 .git worktree 指针反查主仓库；3) 回退解析 ~/.t3/worktrees/<项目名>/...；4) 将系统临时/scratch 目录收拢至「临时对话」。
 * 参数：rawUris — conversation_summaries.workspace_uris 原始值。
 * 返回值：{ workspaceUri, workspacePath, workspaceName }。
 */
export function parseWorkspaceUris(rawUris: unknown): {
  workspaceUri: string;
  workspacePath: string;
  workspaceName: string;
} {
  let workspaceUri = "";
  if (typeof rawUris === "string" && rawUris.trim()) {
    try {
      const arr = JSON.parse(rawUris);
      if (Array.isArray(arr) && typeof arr[0] === "string") workspaceUri = arr[0].trim();
    } catch {
      if (rawUris.trim().startsWith("file://")) workspaceUri = rawUris.trim();
    }
  }
  let workspacePath = "";
  if (workspaceUri.startsWith("file://")) {
    try { workspacePath = decodeURIComponent(new URL(workspaceUri).pathname); }
    catch { workspacePath = decodeURIComponent(workspaceUri.replace(/^file:\/\//, "")); }
  } else if (workspaceUri) {
    workspacePath = workspaceUri;
  }
  if (workspacePath.length > 1) workspacePath = workspacePath.replace(/\/+$/, "");
  if (!workspacePath) return { workspaceUri, workspacePath: "", workspaceName: TEMP_CHAT_WORKSPACE };

  // 1.1. 存在 .git worktree 指针文件时直接归并到主仓库真实项目名与路径
  const gitMainRepo = resolveGitWorktreeMainRepo(workspacePath);
  if (gitMainRepo) {
    return { workspaceUri, workspacePath: gitMainRepo, workspaceName: path.basename(gitMainRepo) || gitMainRepo };
  }
  // 1.2. worktree 已被清理时，从 ~/.t3/worktrees/<项目名>/t3-xxx 路径还原正式项目名
  const t3Project = extractT3WorktreeProject(workspacePath);
  if (t3Project) {
    return { workspaceUri, workspacePath, workspaceName: t3Project };
  }
  // 1.3. 系统临时目录、t3 安装探针与 brain scratch 统一收拢至「临时对话」
  if (isTempOrScratchWorkspace(workspacePath)) {
    return { workspaceUri, workspacePath, workspaceName: TEMP_CHAT_WORKSPACE };
  }
  return { workspaceUri, workspacePath, workspaceName: path.basename(workspacePath) || workspacePath };
}

/**
 * 职责：为 Swarm 成员与非正式项目子代理沿父会话链继承正式项目名，孤儿 Swarm 收拢至「临时对话」。
 * 参数：conversations — 已扫描的全量会话列表；byId — 会话 ID 索引。
 */
export function normalizeConversationWorkspaces(
  conversations: ConversationDetail[],
  byId: Map<string, ConversationDetail>
): void {
  const resolveAncestorProject = (conv: ConversationDetail): { workspaceName: string; workspacePath: string } | null => {
    const seen = new Set<string>([conv.conversationId]);
    let nextId = conv.parentConversationId || extractSwarmCoordinatorId(conv.workspacePath) || "";
    while (nextId && !seen.has(nextId)) {
      seen.add(nextId);
      const anc = byId.get(nextId);
      if (!anc) break;
      if (!isNonProjectWorkspace(anc.workspaceName, anc.workspacePath)) {
        return { workspaceName: anc.workspaceName, workspacePath: anc.workspacePath };
      }
      nextId = anc.parentConversationId || extractSwarmCoordinatorId(anc.workspacePath) || "";
    }
    return null;
  };

  for (const c of conversations) {
    if (!isNonProjectWorkspace(c.workspaceName, c.workspacePath)) continue;
    const parentWs = resolveAncestorProject(c);
    if (parentWs) {
      c.workspaceName = parentWs.workspaceName;
      c.workspacePath = parentWs.workspacePath;
    } else if (isEphemeralSwarmWorkspace(c.workspaceName, c.workspacePath) || !c.workspaceName) {
      c.workspaceName = TEMP_CHAT_WORKSPACE;
    }
  }
}

/**
 * 职责：过滤无任何推理调用与 Token 消耗且无活跃后代子代理的空壳会话（如 0 步初始化探针与老旧无明细 .pb 索引）。
 * 参数：conversations — 已完成父项目继承的会话列表；byId — 会话 ID 索引。
 * 返回值：过滤后的有效会话列表。
 */
export function filterEmptyConversations(
  conversations: ConversationDetail[],
  byId: Map<string, ConversationDetail>
): ConversationDetail[] {
  const keepIds = new Set<string>();
  for (const c of conversations) {
    if (c.callCount > 0 || c.totalTokens > 0) {
      keepIds.add(c.conversationId);
      // 向上保留有活跃子代理的祖先父会话，防止子代理失去父级归属
      let curParent = c.parentConversationId;
      const seen = new Set<string>([c.conversationId]);
      while (curParent && !seen.has(curParent) && byId.has(curParent)) {
        seen.add(curParent);
        keepIds.add(curParent);
        curParent = byId.get(curParent)?.parentConversationId || "";
      }
    }
  }
  return conversations.filter((c) => keepIds.has(c.conversationId));
}
