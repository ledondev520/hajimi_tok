/**
 * Input: @/types/telemetry 的 ConversationUsageSummary 类型契约。
 * Output: 导出 MainConversationGroup 接口与 groupByMainConversation 纯聚合函数（合并子代理与同一 T3 线程的多次运行会话）。
 * Pos: 主会话表格前端分组聚合层，被 ConversationExplorer 与单元测试共享。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import type { ConversationUsageSummary } from "@/types/telemetry";

/** 合并了同线程多次运行与全部下属 Subagent 消耗后的顶层主会话聚合节点 */
export interface MainConversationGroup {
  root: ConversationUsageSummary; // 主会话代表记录（多轮同线程时取最近活跃的一次）
  children: ConversationUsageSummary[]; // 挂载在该主会话下的历史同线程运行与全部子代理（按时间倒序）
  siblingRunCount: number; // 合并进本组的同 T3 线程主运行次数（普通单会话为 1，定时/续跑合并为 >=2）
  subagentChildCount: number; // 本组内真正的子代理会话数
  rolledCallCount: number; // 主会话 + 全部折叠子项总调用轮数
  rolledInputTokens: number; // 合并未缓存新增输入 Token
  rolledCacheReadTokens: number; // 合并缓存读取 Token
  rolledOutputTokens: number; // 合并输出 Token
  rolledTotalTokens: number; // 合并总消耗 Token
  rolledCacheHitRate: number; // 合并缓存命中率
  rolledCostUsd: number; // 合并等效 API 成本
  rolledLastModifiedAt: string; // 本组内最新活跃时间
  allModels: string[]; // 本组涉及的全部模型
}

/**
 * 职责：将子代理（Subagent）递归归并到顶层主会话，并将共享同一 T3 线程 ID（如 fresh_session 定时任务轮转）的多次运行合并为单条可展开主会话。
 * 思路：1) 沿 parentConversationId 追溯每个会话的直接顶层会话；2) 按 t3ThreadId（若存在）二次归并同线程顶层会话，取最近活跃项为 root；3) 累加全组 Token、成本与模型集合。
 * 参数：conversations — 原始扁平会话列表。
 * 返回值：聚合后的主会话分组数组。
 */
export function groupByMainConversation(
  conversations: ConversationUsageSummary[]
): MainConversationGroup[] {
  const byId = new Map<string, ConversationUsageSummary>();
  for (const c of conversations) {
    byId.set(c.conversationId, c);
  }

  // 1.1. 沿 parentConversationId 向上追溯顶层会话 ID（带环路保护）
  const resolveTopConv = (conv: ConversationUsageSummary): ConversationUsageSummary => {
    let cur = conv;
    const seen = new Set<string>([cur.conversationId]);
    while (cur.parentConversationId && byId.has(cur.parentConversationId)) {
      if (seen.has(cur.parentConversationId)) break;
      seen.add(cur.parentConversationId);
      cur = byId.get(cur.parentConversationId)!;
    }
    return cur;
  };

  // 1.2. 以顶层会话的 t3ThreadId（存在时）或 conversationId 为分组键，归并同线程多次运行与全部子代理
  const bucketMap = new Map<
    string,
    { topRuns: ConversationUsageSummary[]; subagents: ConversationUsageSummary[] }
  >();

  for (const c of conversations) {
    const topConv = resolveTopConv(c);
    const groupKey = topConv.t3ThreadId ? `t3:${topConv.t3ThreadId}` : `conv:${topConv.conversationId}`;
    let bucket = bucketMap.get(groupKey);
    if (!bucket) {
      bucket = { topRuns: [], subagents: [] };
      bucketMap.set(groupKey, bucket);
    }
    if (c.conversationId === topConv.conversationId) {
      if (!bucket.topRuns.some((x) => x.conversationId === c.conversationId)) {
        bucket.topRuns.push(c);
      }
    } else {
      bucket.subagents.push(c);
    }
  }

  // 2. 选出每组代表 root（同线程多次运行取最新活跃项），汇总全组 Token、调用数与成本
  const groups: MainConversationGroup[] = [];
  for (const { topRuns, subagents } of bucketMap.values()) {
    topRuns.sort((a, b) => Date.parse(b.lastModifiedAt) - Date.parse(a.lastModifiedAt));
    const root = topRuns[0] ?? subagents[0];
    if (!root) continue;

    const siblingRuns = topRuns.slice(1);
    const children = [...siblingRuns, ...subagents].sort(
      (a, b) => Date.parse(b.lastModifiedAt) - Date.parse(a.lastModifiedAt)
    );
    const members = [root, ...children];
    let rolledCallCount = 0;
    let rolledInputTokens = 0;
    let rolledCacheReadTokens = 0;
    let rolledOutputTokens = 0;
    let rolledTotalTokens = 0;
    let rolledCostUsd = 0;
    let rolledLastModifiedAt = root.lastModifiedAt;
    const modelSet = new Set<string>(root.models);
    if (root.primaryModel) modelSet.add(root.primaryModel);

    for (const m of members) {
      rolledCallCount += m.callCount;
      rolledInputTokens += m.inputTokens;
      rolledCacheReadTokens += m.cacheReadTokens;
      rolledOutputTokens += m.outputTokens;
      rolledTotalTokens += m.totalTokens;
      rolledCostUsd += m.estimatedCostUsd;
      if (m.lastModifiedAt > rolledLastModifiedAt) {
        rolledLastModifiedAt = m.lastModifiedAt;
      }
      for (const mod of m.models) if (mod) modelSet.add(mod);
      if (m.primaryModel) modelSet.add(m.primaryModel);
    }

    const promptSum = rolledInputTokens + rolledCacheReadTokens;
    groups.push({
      root,
      children,
      siblingRunCount: topRuns.length,
      subagentChildCount: subagents.length,
      rolledCallCount,
      rolledInputTokens,
      rolledCacheReadTokens,
      rolledOutputTokens,
      rolledTotalTokens,
      rolledCacheHitRate: promptSum > 0 ? rolledCacheReadTokens / promptSum : 0,
      rolledCostUsd,
      rolledLastModifiedAt,
      allModels: [...modelSet],
    });
  }

  return groups;
}
