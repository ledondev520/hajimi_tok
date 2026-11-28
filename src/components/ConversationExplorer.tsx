/**
 * Input: React 状态与记忆化钩子、ConversationUsageSummary 类型、@/lib/format 工具、@/components/ModelCallChart 模型配色解析器与 @/components/ui 基础组件。
 * Output: 导出 ConversationExplorer 紧凑型主会话聚合列表组件（默认将 Subagent 消耗合并并折叠至所属主会话内）。
 * Pos: 主会话级 Token 汇总、子代理折叠展开与单步详情钻取核心表格组件（src/components/ConversationExplorer.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bot, ChevronDown, ChevronRight, Eye, RotateCcw, Search, X } from "lucide-react";
import type { ConversationUsageSummary } from "@/types/telemetry";
import {
  formatDateTime,
  formatExactNumber,
  formatPercent,
  formatRelativeTime,
  formatTokens,
  formatUsd,
  readStoredJson,
  resolveContextHealth,
  writeStoredJson,
} from "@/lib/format";
import { formatCompactGap, resolveLiveCacheWarmth } from "@/lib/cacheTtl";
import { resolveModelStyle } from "@/components/ModelCallChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** 精简表格主模型列显示名称（剥离冗长的 Gemini 4 前缀，窄屏一眼分辨具体子型号） */
const compactModelName = (name: string): string =>
  (name || "Unknown").replace(/^Gemini\s+4\s+/i, "").trim() || "Unknown";

/** 会话列表表头点击排序维度枚举 */
type SortByKey = "recent" | "tokens" | "cost" | "calls" | "cacheRate";

/** 合并了全部下属 Subagent 消耗后的顶层主会话聚合节点 */
export interface MainConversationGroup {
  root: ConversationUsageSummary; // 主会话自身原始记录
  children: ConversationUsageSummary[]; // 挂载在该主会话下的全部子代理（按时间倒序）
  rolledCallCount: number; // 主会话 + 子代理总调用轮数
  rolledInputTokens: number; // 合并未缓存新增输入 Token
  rolledCacheReadTokens: number; // 合并缓存读取 Token
  rolledOutputTokens: number; // 合并输出 Token
  rolledTotalTokens: number; // 合并总消耗 Token
  rolledCacheHitRate: number; // 合并缓存命中率
  rolledCostUsd: number; // 合并等效 API 成本
  rolledLastModifiedAt: string; // 主会话与子代理中的最新活跃时间
  allModels: string[]; // 主会话及子代理涉及的全部模型
}

/** ConversationExplorer 组件入参属性 */
export interface ConversationExplorerProps {
  conversations: ConversationUsageSummary[]; // 服务端返回的全量会话（含主会话与 Subagent）
  availableWorkspaces: string[]; // 可选项目列表
  selectedWorkspace: string; // 当前选中的项目过滤值
  onWorkspaceChange: (ws: string) => void; // 项目筛选变更回调
  selectedModel: string; // 当前选中的模型过滤值
  onModelChange: (model: string) => void; // 模型筛选变更回调
  onInspectConversation: (conv: ConversationUsageSummary) => void; // 打开单会话步骤明细回调
}

/**
 * 职责：将子代理（Subagent）递归归并到所属顶层主会话，生成主会话聚合列表。
 * 思路：1) 建立 ID 索引向上追溯根会话 ID；2) 将子代理挂载至根会话 children 并累加各项 Token 与成本；3) 无父节点在库中的孤儿记录兜底保留为独立行防止漏算。
 * 参数：conversations — 原始扁平会话列表。
 * 返回值：聚合后的主会话分组数组。
 */
export function groupByMainConversation(
  conversations: ConversationUsageSummary[]
): MainConversationGroup[] {
  // 0. 构建会话字典用于向上追溯顶层父会话
  const byId = new Map<string, ConversationUsageSummary>();
  for (const c of conversations) {
    byId.set(c.conversationId, c);
  }

  // 1.1. 向上查找每个会话的顶层主会话 ID（带环路保护）
  const resolveRootId = (conv: ConversationUsageSummary): string => {
    let cur = conv;
    const seen = new Set<string>([cur.conversationId]);
    while (cur.parentConversationId && byId.has(cur.parentConversationId)) {
      if (seen.has(cur.parentConversationId)) break;
      seen.add(cur.parentConversationId);
      cur = byId.get(cur.parentConversationId)!;
    }
    return cur.conversationId;
  };

  // 1.2. 按 rootId 聚合主会话与全部后代 Subagent
  const bucketMap = new Map<
    string,
    { root: ConversationUsageSummary; children: ConversationUsageSummary[] }
  >();

  for (const c of conversations) {
    const rootId = resolveRootId(c);
    const rootConv = byId.get(rootId) ?? c;
    let bucket = bucketMap.get(rootId);
    if (!bucket) {
      bucket = { root: rootConv, children: [] };
      bucketMap.set(rootId, bucket);
    }
    if (c.conversationId !== rootId) {
      bucket.children.push(c);
    }
  }

  // 2. 计算合并后的总 Token、调用轮数、缓存率与等效成本
  const groups: MainConversationGroup[] = [];
  for (const { root, children } of bucketMap.values()) {
    children.sort(
      (a, b) =>
        new Date(b.lastModifiedAt).getTime() - new Date(a.lastModifiedAt).getTime()
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

/**
 * 职责：紧凑渲染主会话 Token 消耗明细表，默认折叠 Subagent 消耗并支持按需展开。
 * 思路：主表仅展示归并后的主会话行；若包含子代理则提供行内折叠按钮，展开后展示主代理自身与各子代理的拆分行。
 * 参数：props — 会话列表、筛选控制项及单步详情回调。
 * 返回值：高信息密度会话消耗表格卡片。
 */
const INITIAL_VISIBLE_ROWS = 30; // 首屏默认渲染条数，降低移动端与长列表 DOM 压力

export const ConversationExplorer = memo(function ConversationExplorer({
  conversations,
  selectedWorkspace,
  onWorkspaceChange,
  selectedModel,
  onModelChange,
  onInspectConversation,
}: ConversationExplorerProps) {
  // 0. 持久化表头排序、归档开关、缓存仍热开关，刷新页面自动恢复上次筛选态
  const initPrefs = useMemo(
    () =>
      readStoredJson<{ sortBy?: SortByKey; sortDir?: "desc" | "asc"; includeArchived?: boolean; onlyWarm?: boolean }>(
        "agy_conv_explorer_prefs_v1",
        {}
      ),
    []
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortByKey>(initPrefs.sortBy ?? "recent");
  const [sortDir, setSortDir] = useState<"desc" | "asc">(initPrefs.sortDir === "asc" ? "asc" : "desc");
  const [includeArchived, setIncludeArchived] = useState(initPrefs.includeArchived ?? true);
  const [onlyWarm, setOnlyWarm] = useState(initPrefs.onlyWarm ?? false);
  const [expandedRootIds, setExpandedRootIds] = useState<Set<string>>(() => new Set());
  const [showAllRows, setShowAllRows] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    writeStoredJson("agy_conv_explorer_prefs_v1", { sortBy, sortDir, includeArchived, onlyWarm });
  }, [sortBy, sortDir, includeArchived, onlyWarm]);

  const handleToggleSort = (key: SortByKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  // 0.1. 按 `/` 快捷键直达搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && el.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 1.1. 先归并子代理至主会话，再计算当前仍热会话数与筛选排序
  const allGroups = useMemo(() => groupByMainConversation(conversations), [conversations]);

  const warmGroupIds = useMemo(() => {
    const ids = new Set<string>();
    const now = Date.now();
    for (const g of allGroups) {
      if (g.root.archived) continue;
      const w = resolveLiveCacheWarmth(g.rolledLastModifiedAt, g.root.primaryModel, g.root.cacheTtl, now);
      if (w && (w.state === "warm" || w.state === "borderline")) {
        ids.add(g.root.conversationId);
      }
    }
    return ids;
  }, [allGroups]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = allGroups.filter((g) => {
      const c = g.root;
      if (!includeArchived && c.archived) return false;
      if (onlyWarm && !warmGroupIds.has(c.conversationId)) return false;
      if (selectedWorkspace && c.workspaceName !== selectedWorkspace) return false;
      if (!q) return true;
      const inRoot =
        c.title.toLowerCase().includes(q) ||
        c.firstPromptPreview.toLowerCase().includes(q) ||
        c.conversationId.toLowerCase().includes(q) ||
        c.workspaceName.toLowerCase().includes(q);
      const inChild = g.children.some(
        (ch) =>
          ch.title.toLowerCase().includes(q) ||
          ch.agentName.toLowerCase().includes(q) ||
          ch.conversationId.toLowerCase().includes(q)
      );
      return inRoot || inChild;
    });

    const dir = sortDir === "desc" ? 1 : -1;
    return list.sort((a, b) => {
      if (sortBy === "tokens") return (b.rolledTotalTokens - a.rolledTotalTokens) * dir;
      if (sortBy === "cost") return (b.rolledCostUsd - a.rolledCostUsd) * dir;
      if (sortBy === "calls") return (b.rolledCallCount - a.rolledCallCount) * dir;
      if (sortBy === "cacheRate") return (b.rolledCacheHitRate - a.rolledCacheHitRate) * dir;
      return (new Date(b.rolledLastModifiedAt).getTime() - new Date(a.rolledLastModifiedAt).getTime()) * dir;
    });
  }, [allGroups, includeArchived, onlyWarm, warmGroupIds, selectedWorkspace, searchQuery, sortBy, sortDir]);
  const visibleGroups = showAllRows ? filteredGroups : filteredGroups.slice(0, INITIAL_VISIBLE_ROWS);
  const hiddenRowCount = Math.max(0, filteredGroups.length - visibleGroups.length);

  const hasActiveFilter = Boolean(searchQuery.trim() || selectedWorkspace || selectedModel || !includeArchived || onlyWarm);

  /**
   * 职责：切换指定主会话下 Subagent 折叠行的展开/收起状态。
   * 参数：rootId — 顶层主会话 UUID。
   */
  const toggleExpand = (rootId: string) => {
    // 2.1. 复制集合并翻转目标 ID
    setExpandedRootIds((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  return (
    <Card className="gap-2.5 border-slate-200/80 bg-white py-3 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
      <CardHeader className="space-y-2 px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              主会话
            </CardTitle>
            <Badge variant="secondary" className="h-4 px-1.5 text-[11px] tabular-nums">
              {filteredGroups.length}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setOnlyWarm((v) => !v)}
              aria-pressed={onlyWarm}
              title="一键筛出缓存大概率仍热的会话，趁热续聊避免重烧"
              className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium tabular-nums transition-colors ${
                onlyWarm
                  ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              <span
                className={`inline-block size-1.5 rounded-full ${
                  warmGroupIds.size > 0 ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"
                }`}
              />
              <span>缓存仍热 {warmGroupIds.size}</span>
            </button>
            {hasActiveFilter && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setSearchQuery("");
                  onWorkspaceChange("");
                  onModelChange("");
                  setIncludeArchived(true);
                  setOnlyWarm(false);
                }}
                className="h-7 px-2 text-xs text-indigo-600 dark:text-indigo-400"
              >
                <RotateCcw className="size-3" />
                重置
              </Button>
            )}
          </div>
        </div>

        {/* 极简单行搜索栏（移除冗余项目与排序下拉，项目可点表格徽章直筛，排序直点表头） */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-slate-400" />
            <Input
              ref={searchInputRef}
              aria-label="搜索会话、项目或 Prompt"
              placeholder="搜索会话、项目或 Prompt (/)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchQuery("");
                  e.currentTarget.blur();
                }
              }}
              className="h-7 bg-white pl-8 text-xs text-slate-900 dark:bg-slate-950/70 dark:text-slate-100"
            />
          </div>

          {selectedWorkspace && (
            <button
              type="button"
              onClick={() => onWorkspaceChange("")}
              title="点击清除项目筛选"
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2 text-xs text-indigo-700 dark:text-indigo-300"
            >
              <span className="max-w-28 truncate">{selectedWorkspace}</span>
              <X className="size-3" />
            </button>
          )}

          <label className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[11px] text-slate-600 select-none dark:border-slate-800 dark:text-slate-300">
            <Switch
              size="sm"
              checked={includeArchived}
              onCheckedChange={setIncludeArchived}
              aria-label="显示已归档会话"
            />
            <span>归档</span>
          </label>
        </div>
      </CardHeader>

      <CardContent className="px-4">
        {filteredGroups.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 py-8 text-center text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            暂无匹配会话
          </div>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="border-slate-200/80 dark:border-slate-800">
                <TableHead className="h-8 w-9 px-1.5 py-1 text-center text-xs text-slate-500 dark:text-slate-400">
                  明细
                </TableHead>
                <TableHead className="h-8 max-w-44 py-1 text-xs text-slate-500 lg:max-w-64 dark:text-slate-400">
                  主会话
                </TableHead>
                <TableHead className="h-8 py-1 text-xs text-slate-500 dark:text-slate-400">
                  项目
                </TableHead>
                <TableHead className="h-8 py-1 text-xs text-slate-500 dark:text-slate-400">
                  主模型
                </TableHead>
                {(
                  [
                    { key: "calls", label: "轮数" },
                    { key: "cacheRate", label: "新增 / 缓存 / 输出" },
                    { key: "tokens", label: "总 Token" },
                    { key: "cost", label: "成本" },
                    { key: "recent", label: "活跃" },
                  ] as const
                ).map((col) => {
                  const active = sortBy === col.key;
                  const Icon = sortDir === "desc" ? ArrowDown : ArrowUp;
                  return (
                    <TableHead
                      key={col.key}
                      className="h-8 py-1 text-right text-xs text-slate-500 dark:text-slate-400"
                    >
                      <button
                        type="button"
                        onClick={() => handleToggleSort(col.key)}
                        className={`inline-flex cursor-pointer items-center gap-0.5 transition-colors hover:text-slate-900 dark:hover:text-slate-100 ${
                          active ? "font-semibold text-indigo-600 dark:text-indigo-400" : ""
                        }`}
                      >
                        <span>{col.label}</span>
                        {active && <Icon className="size-3" />}
                      </button>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleGroups.map((group) => {
                const { root, children } = group;
                const hasSub = children.length > 0;
                const isExpanded = expandedRootIds.has(root.conversationId);
                const ctxHealth = !root.archived
                  ? resolveContextHealth(
                      root.latestContextUsed ?? root.peakContextUsed,
                      root.contextLimit
                    )
                  : null;
                const rootTtl = root.cacheTtl;
                const liveWarmth = !root.archived
                  ? resolveLiveCacheWarmth(group.rolledLastModifiedAt, root.primaryModel, rootTtl)
                  : null;

                return (
                  <Fragment key={root.conversationId}>
                    {/* 顶层主会话单行高密度展示（包含全部下属 Subagent 汇总值） */}
                    <TableRow className="border-slate-200/60 dark:border-slate-800/70">
                      <TableCell className="w-9 px-1.5 py-1.5 text-center">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          aria-label="查看会话详情"
                          title="查看会话详情"
                          onClick={() => onInspectConversation(root)}
                          className="h-6 w-6 p-0"
                        >
                          <Eye className="size-3.5" />
                        </Button>
                      </TableCell>

                      <TableCell className="max-w-44 py-1.5 lg:max-w-64">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => onInspectConversation(root)}
                                className="min-w-0 cursor-pointer truncate text-left font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
                              >
                                {root.title || `会话 ${root.conversationId.slice(0, 8)}`}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">
                              {root.firstPromptPreview || "点击查看单步明细"}
                            </TooltipContent>
                          </Tooltip>
                          {hasSub && (
                            <button
                              type="button"
                              onClick={() => toggleExpand(root.conversationId)}
                              aria-expanded={isExpanded}
                              aria-label={isExpanded ? "收起子代理明细" : "展开子代理明细"}
                              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:bg-violet-500/15 dark:text-violet-300"
                            >
                              {isExpanded ? (
                                <ChevronDown className="size-3" />
                              ) : (
                                <ChevronRight className="size-3" />
                              )}
                              含 {children.length} 子代理
                            </button>
                          )}
                          {ctxHealth && ctxHealth.level !== "ok" && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className={`inline-flex shrink-0 cursor-default items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${
                                    ctxHealth.level === "high"
                                      ? "bg-rose-500/10 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                                      : "bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                                  }`}
                                >
                                  ctx {formatTokens(ctxHealth.used)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                当前上下文 {formatTokens(ctxHealth.used)}
                                {ctxHealth.limit > 0
                                  ? ` / ${formatTokens(ctxHealth.limit)} (${formatPercent(ctxHealth.ratio)})`
                                  : ""}
                                {ctxHealth.level === "high"
                                  ? "，会话已偏胖，空闲超 3–5 分钟或偶发驱逐重热代价很高，建议立即 /compact 或开新会话"
                                  : "，建议本阶段收尾后 /compact 或开新会话"}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {root.archived && (
                            <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px]">
                              归档
                            </Badge>
                          )}
                        </div>
                      </TableCell>

                      <TableCell className="py-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            root.workspaceName &&
                            onWorkspaceChange(
                              selectedWorkspace === root.workspaceName ? "" : root.workspaceName
                            )
                          }
                          title={root.workspaceName ? "点击按该项目筛选" : undefined}
                          className="inline-flex h-5 max-w-28 cursor-pointer items-center truncate rounded-md border border-slate-200 px-1.5 text-[11px] font-normal text-slate-700 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500 dark:hover:text-indigo-400"
                        >
                          {root.workspaceName || "未绑定"}
                        </button>
                      </TableCell>

                      <TableCell className="py-1.5 text-slate-700 dark:text-slate-300">
                        <span
                          title={root.primaryModel || "Unknown"}
                          className="inline-flex items-center gap-1.5 truncate"
                        >
                          <span
                            style={{
                              backgroundColor: resolveModelStyle(root.primaryModel || "Unknown", 0)
                                .color,
                            }}
                            className="inline-block size-2 shrink-0 rounded-full"
                          />
                          <span className="truncate">{compactModelName(root.primaryModel)}</span>
                          {group.allModels.length > 1 && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                  +{group.allModels.length - 1}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                涉及模型：{group.allModels.join("、")}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                      </TableCell>

                      <TableCell className="py-1.5 text-right text-slate-600 tabular-nums dark:text-slate-300">
                        {formatExactNumber(group.rolledCallCount)}
                      </TableCell>

                      <TableCell className="py-1.5 text-right text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
                        {formatTokens(group.rolledInputTokens)} /{" "}
                        {formatTokens(group.rolledCacheReadTokens)} /{" "}
                        {formatTokens(group.rolledOutputTokens)}
                        <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                          ({formatPercent(group.rolledCacheHitRate)})
                        </span>
                        {rootTtl &&
                          (rootTtl.lastEventGapMs !== null || rootTtl.maxKeptGapMs !== null) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className={`ml-1 inline-flex cursor-default items-center rounded px-1 py-0.2 font-mono text-[10px] font-medium ${
                                    rootTtl.lastEventKind === "expired"
                                      ? "bg-rose-500/10 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"
                                      : "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                                  }`}
                                >
                                  {rootTtl.lastEventKind === "expired" &&
                                  rootTtl.lastEventGapMs !== null
                                    ? `失效 ${formatCompactGap(rootTtl.lastEventGapMs)}`
                                    : `保活 ${formatCompactGap(rootTtl.lastEventGapMs ?? rootTtl.maxKeptGapMs)}`}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs space-y-0.5 text-[11px]">
                                <div>
                                  实测样本 {rootTtl.sampleCount} 笔 · 保活≤
                                  {formatCompactGap(rootTtl.maxKeptGapMs)} · 失效中位{" "}
                                  {formatCompactGap(
                                    rootTtl.medianExpiredGapMs ?? rootTtl.minExpiredGapMs
                                  )}
                                </div>
                                {rootTtl.lastEventKind && rootTtl.lastEventGapMs !== null && (
                                  <div className="opacity-85">
                                    上次事件：
                                    {rootTtl.lastEventKind === "expired"
                                      ? `空闲 ${formatCompactGap(rootTtl.lastEventGapMs)} 后缓存失效`
                                      : `空闲 ${formatCompactGap(rootTtl.lastEventGapMs)} 仍保活`}
                                    {rootTtl.lastEventAt
                                      ? `（${formatDateTime(rootTtl.lastEventAt)}）`
                                      : ""}
                                  </div>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          )}
                      </TableCell>

                      <TableCell className="py-1.5 text-right font-semibold text-slate-950 tabular-nums dark:text-slate-50">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default">
                              {formatTokens(group.rolledTotalTokens)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            精确总计: {formatExactNumber(group.rolledTotalTokens)} tokens
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>

                      <TableCell className="py-1.5 text-right font-medium text-slate-800 tabular-nums dark:text-slate-200">
                        {formatUsd(group.rolledCostUsd)}
                      </TableCell>

                      <TableCell className="py-1.5 text-right text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-default items-center gap-1">
                              {liveWarmth && liveWarmth.state !== "cold" && (
                                <span
                                  className={`rounded px-1 py-0.2 text-[10px] font-medium ${
                                    liveWarmth.state === "warm"
                                      ? "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                                      : "bg-amber-500/12 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                                  }`}
                                >
                                  {liveWarmth.state === "warm" ? "热" : "快冷"}
                                </span>
                              )}
                              <span>{formatRelativeTime(group.rolledLastModifiedAt)}</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="space-y-0.5 text-[11px]">
                            <div>最近活跃：{formatDateTime(group.rolledLastModifiedAt)}</div>
                            {liveWarmth && (
                              <div>
                                已空闲 {formatCompactGap(liveWarmth.idleMs)} · 参考 TTL ~
                                {formatCompactGap(liveWarmth.refTtlMs)}（
                                {liveWarmth.state === "warm"
                                  ? "预计缓存仍热"
                                  : liveWarmth.state === "borderline"
                                    ? "临近过期边界"
                                    : "大概率已冷"}
                                ）
                              </div>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>

                    {/* 展开后的主会话自身 + 各 Subagent 折叠子行 */}
                    {hasSub && isExpanded && (
                      <>
                        <TableRow className="border-slate-200/40 bg-slate-50/70 text-[11px] dark:border-slate-800/50 dark:bg-slate-900/40">
                          <TableCell className="w-9 px-1.5 py-1 text-center">
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              aria-label="查看主会话步骤详情"
                              title="查看步骤详情"
                              onClick={() => onInspectConversation(root)}
                              className="h-5 w-6 p-0"
                            >
                              <Eye className="size-3" />
                            </Button>
                          </TableCell>
                          <TableCell className="max-w-44 truncate py-1 pl-5 text-slate-600 lg:max-w-64 dark:text-slate-300">
                            ├─ 主会话自身消耗
                          </TableCell>
                          <TableCell className="py-1 text-slate-400">-</TableCell>
                          <TableCell
                            title={root.primaryModel}
                            className="py-1 text-slate-500 dark:text-slate-400"
                          >
                            {compactModelName(root.primaryModel)}
                          </TableCell>
                          <TableCell className="py-1 text-right text-slate-500 tabular-nums">
                            {root.callCount}
                          </TableCell>
                          <TableCell className="py-1 text-right text-slate-400 tabular-nums">
                            {formatTokens(root.inputTokens)} / {formatTokens(root.cacheReadTokens)} /{" "}
                            {formatTokens(root.outputTokens)}
                          </TableCell>
                          <TableCell className="py-1 text-right font-medium text-slate-700 tabular-nums dark:text-slate-200">
                            {formatTokens(root.totalTokens)}
                          </TableCell>
                          <TableCell className="py-1 text-right text-slate-600 tabular-nums dark:text-slate-300">
                            {formatUsd(root.estimatedCostUsd)}
                          </TableCell>
                          <TableCell className="py-1 text-right text-slate-400 tabular-nums">
                            {formatRelativeTime(root.lastModifiedAt)}
                          </TableCell>
                        </TableRow>

                        {children.map((sub, idx) => {
                          const branchChar = idx === children.length - 1 ? "└─" : "├─";
                          const subLabel =
                            sub.agentName || `子代理 ${sub.conversationId.slice(0, 6)}`;
                          return (
                            <TableRow
                              key={sub.conversationId}
                              className="border-slate-200/40 bg-slate-50/70 text-[11px] dark:border-slate-800/50 dark:bg-slate-900/40"
                            >
                              <TableCell className="w-9 px-1.5 py-1 text-center">
                                  <Button type="button" size="xs" variant="ghost" aria-label={`查看 ${subLabel} 步骤详情`} title="查看步骤详情" onClick={() => onInspectConversation(sub)} className="h-5 w-6 p-0">
                                    <Eye className="size-3" />
                                  </Button>
                                </TableCell>
                                <TableCell className="max-w-44 truncate py-1 pl-5 text-slate-600 lg:max-w-64 dark:text-slate-300">
                                  <span className="inline-flex min-w-0 items-center gap-1">
                                    <span className="shrink-0 text-slate-400">{branchChar}</span>
                                    <Bot className="size-3 shrink-0 text-violet-500" />
                                    <span className="truncate">{subLabel}</span>
                                    <span className="shrink-0 font-mono text-[10px] text-slate-400">({sub.conversationId.slice(0, 6)})</span>
                                  </span>
                                </TableCell>
                                <TableCell className="py-1 text-slate-400">-</TableCell>
                                <TableCell title={sub.primaryModel} className="py-1 text-slate-500 dark:text-slate-400">{compactModelName(sub.primaryModel)}</TableCell>
                                <TableCell className="py-1 text-right text-slate-500 tabular-nums">{sub.callCount}</TableCell>
                                <TableCell className="py-1 text-right text-slate-400 tabular-nums">{formatTokens(sub.inputTokens)} / {formatTokens(sub.cacheReadTokens)} / {formatTokens(sub.outputTokens)}</TableCell>
                                <TableCell className="py-1 text-right font-medium text-slate-700 tabular-nums dark:text-slate-200">{formatTokens(sub.totalTokens)}</TableCell>
                                <TableCell className="py-1 text-right text-slate-600 tabular-nums dark:text-slate-300">{formatUsd(sub.estimatedCostUsd)}</TableCell>
                                <TableCell className="py-1 text-right text-slate-400 tabular-nums">{formatRelativeTime(sub.lastModifiedAt)}</TableCell>
                              </TableRow>
                            );
                          })}
                        </>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
        )}
        {hiddenRowCount > 0 && (
          <div className="mt-2 flex justify-center">
            <Button type="button" variant="outline" size="xs" onClick={() => setShowAllRows(true)} className="h-7 px-3 text-xs">
              展开剩余 {hiddenRowCount} 条主会话（共 {filteredGroups.length} 条）
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
