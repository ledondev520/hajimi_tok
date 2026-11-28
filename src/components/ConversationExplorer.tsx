/**
 * Input: React 状态与记忆化钩子、ConversationUsageSummary 类型、@/lib/format 工具、@/lib/conversationGroups 分组器、@/components/ModelCallChart 模型配色解析器与 @/components/ui 基础组件。
 * Output: 导出 ConversationExplorer 紧凑型主会话聚合列表组件及 groupByMainConversation（默认折叠同 T3 线程多次运行与全部 Subagent）。
 * Pos: 主会话级 Token 汇总、同线程运行与子代理折叠展开及单步详情钻取核心表格组件（src/components/ConversationExplorer.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bot, ChevronDown, ChevronRight, Eye, History, RotateCcw, Search, X } from "lucide-react";
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
import { groupByMainConversation, type MainConversationGroup } from "@/lib/conversationGroups";
import { formatCompactGap, resolveLiveCacheWarmth } from "@/lib/cacheTtl";
import { resolveModelStyle, stripModelBrandPrefix } from "@/lib/models";
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

export { groupByMainConversation, type MainConversationGroup };

const compactModelName = stripModelBrandPrefix;

/** 会话列表表头点击排序维度枚举 */
type SortByKey = "recent" | "tokens" | "cost" | "calls" | "cacheRate";

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
          (ch.runTitle || "").toLowerCase().includes(q) ||
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
    <Card className="gap-3 py-4">
      <CardHeader className="space-y-3 px-5 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[13px] font-semibold tracking-tight text-[var(--theme-text)]">
              主会话
            </CardTitle>
            <Badge
              variant="secondary"
              className="theme-accent-pill h-5 rounded-full border px-2 font-mono text-[11px] font-medium tabular-nums"
            >
              {filteredGroups.length}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOnlyWarm((v) => !v)}
              aria-pressed={onlyWarm}
              title="一键筛出缓存大概率仍热的会话，趁热续聊避免重烧"
              className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium tabular-nums transition-colors ${
                onlyWarm
                  ? "border-emerald-500/45 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                  : "border-[var(--theme-border)] bg-[var(--theme-surface-solid)] text-[var(--theme-text-secondary)] hover:border-[var(--theme-border-strong)] hover:bg-[var(--theme-surface-elevated)]"
              }`}
            >
              <span
                className={`inline-block size-1.5 rounded-full ${
                  warmGroupIds.size > 0
                    ? "bg-emerald-500"
                    : "bg-[var(--theme-text-muted)]/40"
                }`}
              />
              <span>缓存仍热</span>
              <span className="font-mono text-[11px] opacity-80">{warmGroupIds.size}</span>
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
                className="theme-accent-text h-8 rounded-lg px-2.5 text-xs"
              >
                <RotateCcw className="size-3" />
                重置
              </Button>
            )}
          </div>
        </div>

        {/* 极简单行搜索栏（搜索框内置 `/` 快捷键提示；项目直点徽章筛选；排序直点表头） */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--theme-text-muted)]" />
            <Input
              ref={searchInputRef}
              aria-label="搜索会话、项目或 Prompt"
              placeholder="搜索会话标题、项目或 Prompt..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchQuery("");
                  e.currentTarget.blur();
                }
              }}
              className="h-8 rounded-lg border-[var(--theme-border)] bg-[var(--theme-surface-solid)] pr-8 pl-8 text-xs text-[var(--theme-text)] placeholder:text-[var(--theme-text-muted)]"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="清空搜索"
                className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-[var(--theme-text-muted)] transition-colors hover:text-[var(--theme-text)]"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-[var(--theme-border)] bg-[var(--theme-surface-elevated)] px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--theme-text-muted)] sm:inline-block">
                /
              </kbd>
            )}
          </div>

          {selectedWorkspace && (
            <button
              type="button"
              onClick={() => onWorkspaceChange("")}
              title="点击清除项目筛选"
              className="theme-accent-pill inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium"
            >
              <span className="max-w-32 truncate">{selectedWorkspace}</span>
              <X className="size-3" />
            </button>
          )}

          <label className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-surface-solid)] px-2.5 text-xs text-[var(--theme-text-secondary)] select-none transition-colors hover:border-[var(--theme-border-strong)]">
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

      <CardContent className="px-5">
        {filteredGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--theme-border)] py-10 text-center text-xs text-[var(--theme-text-muted)]">
            暂无匹配会话
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--theme-border)]">
            <Table className="text-xs">
              <TableHeader>
                <TableRow className="border-b border-[var(--theme-border)] bg-[var(--theme-surface-muted)]/55 hover:bg-[var(--theme-surface-muted)]/55">
                  <TableHead className="h-9 w-9 px-2 py-1 text-center text-[11px] font-medium text-[var(--theme-text-muted)]">
                    明细
                  </TableHead>
                  <TableHead className="h-9 max-w-48 py-1 text-[11px] font-medium text-[var(--theme-text-muted)] lg:max-w-72">
                    主会话
                  </TableHead>
                  <TableHead className="h-9 py-1 text-[11px] font-medium text-[var(--theme-text-muted)]">
                    项目
                  </TableHead>
                  <TableHead className="h-9 py-1 text-[11px] font-medium text-[var(--theme-text-muted)]">
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
                        className="h-9 py-1 text-right text-[11px] font-medium text-[var(--theme-text-muted)]"
                      >
                        <button
                          type="button"
                          onClick={() => handleToggleSort(col.key)}
                          className={`inline-flex cursor-pointer items-center gap-0.5 transition-colors hover:text-[var(--theme-text)] ${
                            active ? "theme-accent-text font-semibold" : ""
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
                      {/* 顶层主会话行（宽松呼吸感，包含全部下属 Subagent 汇总值） */}
                      <TableRow className="group border-[var(--theme-border)] transition-colors hover:bg-[var(--theme-row-hover)]">
                        <TableCell className="w-9 px-2 py-2.5 text-center">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label="查看会话详情"
                            title="查看会话详情"
                            onClick={() => onInspectConversation(root)}
                            className="h-6 w-6 rounded-md p-0 text-[var(--theme-text-muted)] transition-colors group-hover:bg-[var(--theme-surface-elevated)] group-hover:text-[var(--theme-text)]"
                          >
                            <Eye className="size-3.5" />
                          </Button>
                        </TableCell>

                        <TableCell className="max-w-48 py-2.5 lg:max-w-72">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => onInspectConversation(root)}
                                  className="min-w-0 cursor-pointer truncate text-left font-medium text-[var(--theme-text)] transition-colors hover:text-[var(--theme-accent-ink)]"
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
                                aria-label={isExpanded ? "收起明细" : "展开明细"}
                                className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md border border-[var(--theme-border)] bg-[var(--theme-surface-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--theme-text-secondary)] transition-colors hover:border-[var(--theme-border-strong)] hover:text-[var(--theme-text)]"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="size-3" />
                                ) : (
                                  <ChevronRight className="size-3" />
                                )}
                                {group.siblingRunCount > 1 && group.subagentChildCount > 0
                                  ? `含 ${group.siblingRunCount} 次运行 · ${group.subagentChildCount} 子代理`
                                  : group.siblingRunCount > 1
                                    ? `含 ${group.siblingRunCount} 次运行`
                                    : `含 ${children.length} 子代理`}
                              </button>
                            )}
                            {ctxHealth && ctxHealth.level !== "ok" && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className={`inline-flex shrink-0 cursor-default items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${
                                      ctxHealth.level === "high"
                                        ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                                        : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
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
                              <Badge
                                variant="secondary"
                                className="h-4 shrink-0 rounded px-1.5 text-[10px] text-[var(--theme-text-muted)]"
                              >
                                归档
                              </Badge>
                            )}
                          </div>
                        </TableCell>

                        <TableCell className="py-2.5">
                          <button
                            type="button"
                            onClick={() =>
                              root.workspaceName &&
                              onWorkspaceChange(
                                selectedWorkspace === root.workspaceName ? "" : root.workspaceName
                              )
                            }
                            title={root.workspaceName ? "点击按该项目筛选" : undefined}
                            className="inline-flex h-5.5 max-w-28 cursor-pointer items-center truncate rounded-md border border-[var(--theme-border)] bg-[var(--theme-surface-elevated)]/60 px-2 text-[11px] font-normal text-[var(--theme-text-secondary)] transition-colors hover:border-[var(--theme-border-strong)] hover:text-[var(--theme-text)]"
                          >
                            {root.workspaceName || "临时对话"}
                          </button>
                        </TableCell>

                        <TableCell className="py-2.5 text-[var(--theme-text-secondary)]">
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
                                  <span className="cursor-default rounded bg-[var(--theme-surface-elevated)] px-1 font-mono text-[10px] text-[var(--theme-text-muted)]">
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

                        <TableCell className="py-2.5 text-right font-mono text-[var(--theme-text-secondary)] tabular-nums">
                          {formatExactNumber(group.rolledCallCount)}
                        </TableCell>

                        <TableCell className="py-2.5 text-right font-mono text-[11px] text-[var(--theme-text-muted)] tabular-nums">
                          {formatTokens(group.rolledInputTokens)} /{" "}
                          {formatTokens(group.rolledCacheReadTokens)} /{" "}
                          {formatTokens(group.rolledOutputTokens)}
                          <span className="ml-1 font-medium text-emerald-600 dark:text-emerald-400">
                            ({formatPercent(group.rolledCacheHitRate)})
                          </span>
                          {rootTtl &&
                            (rootTtl.lastEventGapMs !== null || rootTtl.maxKeptGapMs !== null) && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className={`ml-1 inline-flex cursor-default items-center rounded px-1 py-0.5 font-mono text-[10px] font-medium ${
                                      rootTtl.lastEventKind === "expired"
                                        ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                                        : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
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

                        <TableCell className="py-2.5 text-right font-mono font-semibold text-[var(--theme-text)] tabular-nums">
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

                        <TableCell className="py-2.5 text-right font-mono font-medium text-[var(--theme-text-secondary)] tabular-nums">
                          {formatUsd(group.rolledCostUsd)}
                        </TableCell>

                        <TableCell className="py-2.5 text-right text-[11px] text-[var(--theme-text-muted)] tabular-nums">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex cursor-default items-center gap-1.5">
                                {liveWarmth && liveWarmth.state !== "cold" && (
                                  <span
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                      liveWarmth.state === "warm"
                                        ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                        : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
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
                          <TableRow className="border-[var(--theme-border)]/70 bg-[var(--theme-surface-muted)]/35 text-[11px] hover:bg-[var(--theme-row-hover)]">
                            <TableCell className="w-9 px-2 py-1.5 text-center">
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                aria-label="查看主会话步骤详情"
                                title="查看步骤详情"
                                onClick={() => onInspectConversation(root)}
                                className="h-5 w-6 p-0 text-[var(--theme-text-muted)] hover:text-[var(--theme-text)]"
                              >
                                <Eye className="size-3" />
                              </Button>
                            </TableCell>
                            <TableCell className="max-w-48 truncate py-1.5 pl-5 text-[var(--theme-text-secondary)] lg:max-w-72">
                              {group.siblingRunCount > 1
                                ? `├─ 最近运行${root.runTitle ? ` · ${root.runTitle}` : ""}`
                                : "├─ 主会话自身消耗"}
                            </TableCell>
                            <TableCell className="py-1.5 text-[var(--theme-text-muted)]">-</TableCell>
                            <TableCell
                              title={root.primaryModel}
                              className="py-1.5 text-[var(--theme-text-muted)]"
                            >
                              {compactModelName(root.primaryModel)}
                            </TableCell>
                            <TableCell className="py-1.5 text-right font-mono text-[var(--theme-text-muted)] tabular-nums">
                              {root.callCount}
                            </TableCell>
                            <TableCell className="py-1.5 text-right font-mono text-[var(--theme-text-muted)] tabular-nums">
                              {formatTokens(root.inputTokens)} / {formatTokens(root.cacheReadTokens)} /{" "}
                              {formatTokens(root.outputTokens)}
                            </TableCell>
                            <TableCell className="py-1.5 text-right font-mono font-medium text-[var(--theme-text-secondary)] tabular-nums">
                              {formatTokens(root.totalTokens)}
                            </TableCell>
                            <TableCell className="py-1.5 text-right font-mono text-[var(--theme-text-muted)] tabular-nums">
                              {formatUsd(root.estimatedCostUsd)}
                            </TableCell>
                            <TableCell className="py-1.5 text-right text-[var(--theme-text-muted)] tabular-nums">
                              {formatRelativeTime(root.lastModifiedAt)}
                            </TableCell>
                          </TableRow>

                          {children.map((sub, idx) => {
                            const branchChar = idx === children.length - 1 ? "└─" : "├─";
                            const isSubagent = Boolean(sub.parentConversationId);
                            const subLabel = isSubagent
                              ? sub.agentName || `子代理 ${sub.conversationId.slice(0, 6)}`
                              : sub.runTitle || `历史运行 ${formatDateTime(sub.lastModifiedAt).slice(5, 16)}`;
                            return (
                              <TableRow
                                key={sub.conversationId}
                                className="border-[var(--theme-border)]/70 bg-[var(--theme-surface-muted)]/35 text-[11px] hover:bg-[var(--theme-row-hover)]"
                              >
                                <TableCell className="w-9 px-2 py-1.5 text-center">
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="ghost"
                                    aria-label={`查看 ${subLabel} 步骤详情`}
                                    title="查看步骤详情"
                                    onClick={() => onInspectConversation(sub)}
                                    className="h-5 w-6 p-0 text-[var(--theme-text-muted)] hover:text-[var(--theme-text)]"
                                  >
                                    <Eye className="size-3" />
                                  </Button>
                                </TableCell>
                                <TableCell className="max-w-48 truncate py-1.5 pl-5 text-[var(--theme-text-secondary)] lg:max-w-72">
                                  <span className="inline-flex min-w-0 items-center gap-1.5">
                                    <span className="shrink-0 font-mono text-[var(--theme-text-muted)]">
                                      {branchChar}
                                    </span>
                                    {isSubagent ? (
                                      <Bot className="size-3 shrink-0 text-violet-500" />
                                    ) : (
                                      <History className="size-3 shrink-0 text-sky-500" />
                                    )}
                                    <span className="truncate">{subLabel}</span>
                                    <span className="shrink-0 font-mono text-[10px] text-[var(--theme-text-muted)]">
                                      ({sub.conversationId.slice(0, 6)})
                                    </span>
                                  </span>
                                </TableCell>
                                <TableCell className="py-1.5 text-[var(--theme-text-muted)]">-</TableCell>
                                <TableCell
                                  title={sub.primaryModel}
                                  className="py-1.5 text-[var(--theme-text-muted)]"
                                >
                                  {compactModelName(sub.primaryModel)}
                                </TableCell>
                                <TableCell className="py-1.5 text-right font-mono text-[var(--theme-text-muted)] tabular-nums">
                                  {sub.callCount}
                                </TableCell>
                                <TableCell className="py-1.5 text-right font-mono text-[var(--theme-text-muted)] tabular-nums">
                                  {formatTokens(sub.inputTokens)} / {formatTokens(sub.cacheReadTokens)} /{" "}
                                  {formatTokens(sub.outputTokens)}
                                </TableCell>
                                <TableCell className="py-1.5 text-right font-mono font-medium text-[var(--theme-text-secondary)] tabular-nums">
                                  {formatTokens(sub.totalTokens)}
                                </TableCell>
                                <TableCell className="py-1.5 text-right font-mono text-[var(--theme-text-muted)] tabular-nums">
                                  {formatUsd(sub.estimatedCostUsd)}
                                </TableCell>
                                <TableCell className="py-1.5 text-right text-[var(--theme-text-muted)] tabular-nums">
                                  {formatRelativeTime(sub.lastModifiedAt)}
                                </TableCell>
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
          </div>
        )}
        {hiddenRowCount > 0 && (
          <div className="mt-3 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setShowAllRows(true)}
              className="h-8 rounded-lg px-3.5 text-xs"
            >
              展开剩余 {hiddenRowCount} 条主会话（共 {filteredGroups.length} 条）
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
