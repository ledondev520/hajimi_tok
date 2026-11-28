/**
 * Input: GlobalKpiTotals、ModelUsageBreakdown、UsageTimeBucket 与 CallNodePoint 类型、@/lib/format 格式化工具、@/lib/chartPath 曲线生成器、@/lib/modelStyle 配色解析器、@/lib/useWeeklyCalibration 周校准钩子与 @/components/ui 基础组件。
 * Output: 导出 KpiCards 顶部一体化四列建筑级核心指标条组件（含真实内联迷你趋势 Sparkline、3px 发丝占比条、按模型拆解等效成本与官方周剩余%反算周满额）。
 * Pos: 看板首屏统一 KPI 指标条层，对标 Vercel / OpenRouter / Stripe 单容器发丝分隔四列概览（src/components/KpiCards.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, useId, useMemo } from "react";
import { Info } from "lucide-react";
import type {
  CallNodePoint,
  GlobalKpiTotals,
  LivePoolQuotaSnapshot,
  ModelUsageBreakdown,
  QuotaCycleInfo,
  UsageTimeBucket,
} from "@/types/telemetry";
import {
  formatDateTime,
  formatDurationMs,
  formatExactNumber,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@/lib/format";
import { buildSmoothAreaPath, buildSmoothLinePath } from "@/lib/chartPath";
import { ensureDistinctColors, resolveModelStyle } from "@/lib/modelStyle";
import { useWeeklyCalibration } from "@/lib/useWeeklyCalibration";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** KpiCards 组件入参属性 */
export interface KpiCardsProps {
  totals: GlobalKpiTotals; // 全局聚合核心指标
  byModel?: ModelUsageBreakdown[]; // 按模型拆解的 Token 与等效 API 成本列表
  dailyTrend?: UsageTimeBucket[]; // 可选：按日趋势桶（用于渲染真实内联迷你 Sparkline）
  callTimeline?: CallNodePoint[]; // 可选：单次调用节点（用于渲染速率迷你 Sparkline）
  mainConversationCount: number; // 合并子代理后的顶层主会话数量
  activeModelLabel?: string; // 当前快捷选中的模型名称（为空表示全部模型）
  activePoolKey?: string; // 当前快捷选中的模型/配额池键（用于独立持久化周配额校准）
  quotaWindow?: QuotaCycleInfo; // 当前配额池的 5h/7d 周期窗口摘要
  liveQuota?: LivePoolQuotaSnapshot; // 可选：由 agy 官方 statusLine 桥接同步的实时官方周剩余
  isWorkspaceFiltered?: boolean; // 是否处于单一工作区筛选视图（禁止写回整池周校准）
  activeSource?: string; // 当前激活的数据源 ID（多账号场景下用于隔离周校准存储）
}

/** 迷你内联 SVG 趋势 Sparkline（>=2 个真实点时绘制平滑折线与淡渐变填充） */
function MiniSparkline({
  values,
  color,
  label,
}: {
  values: number[];
  color: string;
  label: string;
}) {
  const gradId = useId();
  if (values.length < 2) return null;

  const w = 74;
  const h = 28;
  const padX = 2.5;
  const padY = 3.5;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = maxV - minV;

  const pts = values.map((v, i) => ({
    x: padX + (i / (values.length - 1)) * innerW,
    y: span <= 1e-9 ? padY + innerH * 0.5 : padY + innerH - ((v - minV) / span) * innerH,
  }));

  const lineD = buildSmoothLinePath(pts, padY, h - padY);
  const areaD = buildSmoothAreaPath(pts, h - 1, padY, h - padY);
  const lastPt = pts[pts.length - 1];

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label}
      className="shrink-0 overflow-visible opacity-90"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaD && <path d={areaD} fill={`url(#${gradId})`} />}
      {lineD && (
        <path
          d={lineD}
          fill="none"
          stroke={color}
          strokeWidth={1.65}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {lastPt && (
        <circle
          cx={lastPt.x}
          cy={lastPt.y}
          r={2.2}
          fill={color}
          stroke="var(--theme-surface)"
          strokeWidth={1.2}
        />
      )}
    </svg>
  );
}

/**
 * 职责：以建筑级单容器四列 Metric Strip 呈现顶部核心指标（总消耗 Token、缓存命中率、输出与速率、等效成本与分模型拆解）。
 * 思路：1) 舍弃四张割裂卡片与四色高饱和胶囊徽章，改用单外框 + 1px 发丝分隔线四列布局；2) 每列主数字右侧嵌入基于真实遥测序列的平滑迷你 Sparkline；3) 底部采用 3px 精密占比条与极简等宽拆解文案。
 * 参数：props — totals、byModel、dailyTrend、callTimeline、mainConversationCount 及可选配额窗口/数据源参数。
 * 返回值：响应式一体化四列 KPI 指标条节点。
 */
export const KpiCards = memo(function KpiCards({
  totals,
  byModel = [],
  dailyTrend = [],
  callTimeline = [],
  mainConversationCount,
  activeModelLabel,
  activePoolKey = "",
  quotaWindow,
  liveQuota,
  isWorkspaceFiltered = false,
  activeSource = "",
}: KpiCardsProps) {
  const {
    isWeeklyPoolView,
    canWriteWeeklyCalibration,
    calibrationSyncError,
    activeCalibration,
    draftPct,
    weeklyProjection,
    handleRemainingPctChange,
    onDraftBlur,
  } = useWeeklyCalibration({
    activeSource,
    activePoolKey,
    isWorkspaceFiltered,
    quotaWindow,
    liveQuota,
    totals,
  });

  // 1. 提取四组真实 Sparkline 序列（避免装饰性假线，点数 < 2 自动留白）
  const { tokenSpark, cacheSpark, tpsSpark, costSpark } = useMemo(() => {
    const sortedDays = [...dailyTrend]
      .filter((b) => b.totalTokens > 0 || b.callCount > 0)
      .sort((a, b) => a.bucketKey.localeCompare(b.bucketKey))
      .slice(-14);

    const tpsSamples = callTimeline
      .filter((n) => n.outputTps > 0 && n.outputTokens > 0)
      .slice(-16)
      .map((n) => n.outputTps);

    return {
      tokenSpark: sortedDays.map((d) => d.totalTokens),
      cacheSpark: sortedDays.map((d) => {
        const promptSum = d.inputTokens + d.cacheReadTokens;
        return promptSum > 0 ? (d.cacheReadTokens / promptSum) * 100 : 0;
      }),
      tpsSpark:
        tpsSamples.length >= 2
          ? tpsSamples
          : sortedDays.map((d) => d.outputTokens),
      costSpark: sortedDays.map((d) => d.estimatedCostUsd),
    };
  }, [dailyTrend, callTimeline]);

  // 2. 计算输入/缓存/输出占比与思考占比，防止除零
  const safeTotal = Math.max(1, totals.totalTokens);
  const inputPct = (totals.inputTokens / safeTotal) * 100;
  const cachePct = (totals.cacheReadTokens / safeTotal) * 100;
  const outputPct = (totals.outputTokens / safeTotal) * 100;

  const safeOut = Math.max(1, totals.outputTokens);
  const thinkingPct = (totals.thinkingTokens / safeOut) * 100;
  const responsePct = Math.max(0, 100 - thinkingPct);

  // 3. 按模型归并等效 API 成本并保证所有模型色值互不撞色
  const { displayCostItems, rawModelSlicesWithColor } = useMemo(() => {
    const familyCostMap = new Map<
      string,
      { familyKey: string; label: string; color: string; costUsd: number }
    >();
    const rawSorted = [...byModel].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
    const rawDecorated = ensureDistinctColors(
      rawSorted.map((m, idx) => {
        const st = resolveModelStyle(m.modelName, idx);
        return { model: m, color: st.color, shortLabel: st.shortLabel, familyKey: st.familyKey };
      })
    );

    for (const item of rawDecorated) {
      const cur = familyCostMap.get(item.familyKey);
      if (cur) {
        cur.costUsd += item.model.estimatedCostUsd;
      } else {
        familyCostMap.set(item.familyKey, {
          familyKey: item.familyKey,
          label: item.shortLabel,
          color: item.color,
          costUsd: item.model.estimatedCostUsd,
        });
      }
    }
    const familySlices = ensureDistinctColors(
      [...familyCostMap.values()].sort((a, b) => b.costUsd - a.costUsd)
    );
    const display =
      familySlices.length === 1 && rawDecorated.length > 1
        ? rawDecorated.map((item) => ({
            key: item.model.modelName,
            label: item.shortLabel,
            color: item.color,
            costUsd: item.model.estimatedCostUsd,
          }))
        : familySlices.map((f) => ({
            key: f.familyKey,
            label: f.label,
            color: f.color,
            costUsd: f.costUsd,
          }));
    return { displayCostItems: display, rawModelSlicesWithColor: rawDecorated };
  }, [byModel]);
  const safeCostTotal = Math.max(0.000001, totals.estimatedCostUsd);

  return (
    <section
      aria-label="核心 Token 消耗指标概览"
      className="theme-kpi-strip overflow-hidden border border-[var(--theme-border)] bg-[var(--theme-border)] shadow-[var(--theme-shadow-card)]"
    >
      <div className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-4">
        {/* Cell 1: 总消耗 Token */}
        <div className="flex min-w-0 flex-col justify-between gap-3 bg-[var(--theme-surface)] px-5 py-4.5 transition-colors hover:bg-[var(--theme-surface-elevated)]/45">
          <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-[var(--theme-text-muted)]">
            <span className="truncate">
              {activeModelLabel ? `${activeModelLabel}消耗` : "总消耗 Token"}
            </span>
            {quotaWindow ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default font-mono text-[11px] text-[var(--theme-accent-ink)] tabular-nums">
                    {quotaWindow.mode === "5h" || quotaWindow.mode === "prev-5h"
                      ? `7d ${formatTokens(quotaWindow.active7dTokens)}`
                      : `5h ${formatTokens(quotaWindow.active5hTokens)}`}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {quotaWindow.mode === "5h" || quotaWindow.mode === "prev-5h"
                    ? `当前 7d 周周期累计 ${formatTokens(quotaWindow.active7dTokens)}${
                        quotaWindow.active7dResetsAt
                          ? `（预计 ${formatDateTime(quotaWindow.active7dResetsAt).slice(0, 11)} 重置）`
                          : "（待触发）"
                      }`
                    : `当前 5h 周期累计 ${formatTokens(quotaWindow.active5hTokens)}${
                        quotaWindow.active5hResetsAt
                          ? `（预计 ${formatDateTime(quotaWindow.active5hResetsAt).slice(0, 11)} 重置）`
                          : "（已满血重置待触发）"
                      }`}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="font-mono text-[11px] text-[var(--theme-accent-ink)] tabular-nums">
                今日 {formatTokens(totals.todayTotalTokens)}
              </span>
            )}
          </div>

          <div className="flex items-end justify-between gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-[28px] leading-none font-semibold tracking-[-0.035em] text-[var(--theme-text)] tabular-nums sm:text-[30px]">
                  {formatTokens(totals.totalTokens)}
                </span>
              </TooltipTrigger>
              <TooltipContent>精确总计: {formatExactNumber(totals.totalTokens)} tokens</TooltipContent>
            </Tooltip>
            <MiniSparkline values={tokenSpark} color="var(--theme-chart-1)" label="每日总 Token 走势" />
          </div>

          <div className="space-y-1.5">
            <div className="flex h-[3px] w-full gap-[1.5px] overflow-hidden rounded-full bg-[var(--theme-surface-muted)]">
              <div style={{ width: `${cachePct}%`, backgroundColor: "var(--theme-chart-2)" }} className="transition-all duration-300" />
              <div style={{ width: `${inputPct}%`, backgroundColor: "var(--theme-chart-1)" }} className="transition-all duration-300" />
              <div style={{ width: `${outputPct}%`, backgroundColor: "var(--theme-chart-4)" }} className="transition-all duration-300" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
              <span className="inline-flex items-center gap-1">
                <i className="size-1.5 rounded-full" style={{ backgroundColor: "var(--theme-chart-2)" }} />缓 {formatTokens(totals.cacheReadTokens)}
              </span>
              <span className="inline-flex items-center gap-1">
                <i className="size-1.5 rounded-full" style={{ backgroundColor: "var(--theme-chart-1)" }} />新 {formatTokens(totals.inputTokens)}
              </span>
              <span className="inline-flex items-center gap-1">
                <i className="size-1.5 rounded-full" style={{ backgroundColor: "var(--theme-chart-4)" }} />出 {formatTokens(totals.outputTokens)}
              </span>
            </div>
          </div>
        </div>

        {/* Cell 2: Prompt 缓存命中率 */}
        <div className="flex min-w-0 flex-col justify-between gap-3 bg-[var(--theme-surface)] px-5 py-4.5 transition-colors hover:bg-[var(--theme-surface-elevated)]/45">
          <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-[var(--theme-text-muted)]">
            <span className="truncate">缓存命中率</span>
            <span className="font-mono text-[11px] font-medium tabular-nums" style={{ color: "var(--theme-chart-2)" }}>
              省 {formatUsd(totals.cacheSavedUsd)}
            </span>
          </div>

          <div className="flex items-end justify-between gap-3">
            <span className="text-[28px] leading-none font-semibold tracking-[-0.035em] text-[var(--theme-text)] tabular-nums sm:text-[30px]">
              {formatPercent(totals.cacheHitRate)}
            </span>
            <MiniSparkline values={cacheSpark} color="var(--theme-chart-2)" label="每日缓存命中率走势" />
          </div>

          <div className="space-y-1.5">
            <div className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--theme-surface-muted)]">
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, totals.cacheHitRate * 100))}%`,
                  backgroundColor: "var(--theme-chart-2)",
                }}
                className="h-full rounded-full transition-all duration-300"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
              <span>命中 {formatTokens(totals.cacheReadTokens)}</span>
              <span>新增 {formatTokens(totals.inputTokens)}</span>
            </div>
          </div>
        </div>

        {/* Cell 3: 输出与速率 */}
        <div className="flex min-w-0 flex-col justify-between gap-3 bg-[var(--theme-surface)] px-5 py-4.5 transition-colors hover:bg-[var(--theme-surface-elevated)]/45">
          <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-[var(--theme-text-muted)]">
            <span className="truncate">输出与速率</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default font-mono text-[11px] font-medium tabular-nums" style={{ color: "var(--theme-chart-3)" }}>
                  {totals.avgOutputTps > 0
                    ? `${totals.avgOutputTps.toFixed(1)} tok/s`
                    : `思考 ${totals.outputTokens > 0 ? `${thinkingPct.toFixed(0)}%` : "0%"}`}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {totals.avgOutputTps > 0
                  ? `端到端有效 TPS：${totals.avgOutputTps.toFixed(1)} tok/s（含均首包等待 ${formatDurationMs(totals.avgTtftMs)}${totals.avgStreamingTps > 0 ? ` · 扣首包纯吞字 ${totals.avgStreamingTps.toFixed(1)} tok/s` : ""}）`
                  : "暂无已完成耗时记录，待模型落盘 gen_metadata 后自动计算 TPS"}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-end justify-between gap-3">
            <span className="text-[28px] leading-none font-semibold tracking-[-0.035em] text-[var(--theme-text)] tabular-nums sm:text-[30px]">
              {formatTokens(totals.outputTokens)}
            </span>
            <MiniSparkline values={tpsSpark} color="var(--theme-chart-3)" label="近期输出速率走势" />
          </div>

          <div className="space-y-1.5">
            <div className="flex h-[3px] w-full gap-[1.5px] overflow-hidden rounded-full bg-[var(--theme-surface-muted)]">
              <div
                style={{ width: `${totals.outputTokens > 0 ? thinkingPct : 0}%`, backgroundColor: "var(--theme-chart-3)" }}
                className="transition-all duration-300"
              />
              <div
                style={{ width: `${totals.outputTokens > 0 ? responsePct : 0}%`, backgroundColor: "var(--theme-chart-4)" }}
                className="transition-all duration-300"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
              <span className="inline-flex items-center gap-1">
                <i className="size-1.5 rounded-full" style={{ backgroundColor: "var(--theme-chart-3)" }} />
                思考 {formatTokens(totals.thinkingTokens)}
                {totals.outputTokens > 0 ? ` (${thinkingPct.toFixed(0)}%)` : ""}
              </span>
              <span className="inline-flex items-center gap-1">
                <i className="size-1.5 rounded-full" style={{ backgroundColor: "var(--theme-chart-4)" }} />回复 {formatTokens(totals.responseTokens)}
              </span>
            </div>
          </div>
        </div>

        {/* Cell 4: 等效成本与分模型拆解 */}
        <div className="flex min-w-0 flex-col justify-between gap-3 bg-[var(--theme-surface)] px-5 py-4.5 transition-colors hover:bg-[var(--theme-surface-elevated)]/45">
          <div className="flex items-center justify-between gap-1.5 text-[12px] font-medium text-[var(--theme-text-muted)]">
            <span className="inline-flex items-center gap-1 truncate">
              等效成本
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="查看等效 API 成本分模型拆解说明"
                    className="inline-flex cursor-pointer opacity-65 transition-opacity hover:opacity-100"
                  >
                    <Info className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-none space-y-1.5 p-2.5 whitespace-nowrap">
                  <div className="font-medium">按模型拆解等效 API 成本</div>
                  <div className="space-y-1">
                    {rawModelSlicesWithColor.map(({ model: m, color }) => {
                      const pct =
                        totals.estimatedCostUsd > 0
                          ? (m.estimatedCostUsd / totals.estimatedCostUsd) * 100
                          : 0;
                      return (
                        <div key={m.modelName} className="flex items-center justify-between gap-4 text-[11px] tabular-nums">
                          <span className="inline-flex items-center gap-1.5">
                            <span style={{ backgroundColor: color }} className="inline-block size-1.5 shrink-0 rounded-full" />
                            <span>{m.modelName}</span>
                          </span>
                          <span className="shrink-0 font-mono">
                            {formatUsd(m.estimatedCostUsd)} ({pct.toFixed(0)}%)
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="border-t border-white/15 pt-1 text-[10px] opacity-80">
                    主会话 {mainConversationCount}
                    {totals.subagentCount > 0 ? ` (+${totals.subagentCount}子)` : ""} ·{" "}
                    {formatExactNumber(totals.callCount)} 轮 · 均 {formatDurationMs(totals.avgLatencyMs)}
                  </div>
                </TooltipContent>
              </Tooltip>
            </span>
            <span className="font-mono text-[11px] font-medium tabular-nums" style={{ color: "var(--theme-chart-4)" }}>
              今日 {formatUsd(totals.todayEstimatedCostUsd)}
            </span>
          </div>

          <div className="flex items-end justify-between gap-3">
            <span className="text-[28px] leading-none font-semibold tracking-[-0.035em] text-[var(--theme-text)] tabular-nums sm:text-[30px]">
              {formatUsd(totals.estimatedCostUsd)}
            </span>
            <MiniSparkline values={costSpark} color="var(--theme-chart-4)" label="每日等效成本走势" />
          </div>

          <div className="space-y-1.5">
            <div className="flex h-[3px] w-full gap-[1.5px] overflow-hidden rounded-full bg-[var(--theme-surface-muted)]">
              {displayCostItems.length > 0 ? (
                displayCostItems.map((item) => (
                  <div
                    key={item.key}
                    style={{
                      width: `${(item.costUsd / safeCostTotal) * 100}%`,
                      backgroundColor: item.color,
                    }}
                  />
                ))
              ) : (
                <div className="h-full w-full bg-amber-500/70" />
              )}
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex cursor-default items-center justify-between gap-2 font-mono text-[10.5px] leading-tight text-[var(--theme-text-muted)] tabular-nums">
                  {displayCostItems.length > 0 ? (
                    <span className="inline-flex min-w-0 items-center gap-2 truncate">
                      {displayCostItems.slice(0, 2).map((item) => (
                        <span key={item.key} className="inline-flex items-center gap-1 whitespace-nowrap">
                          <span style={{ backgroundColor: item.color }} className="inline-block size-1.5 shrink-0 rounded-full" />
                          <span className="max-w-[78px] truncate">{item.label}</span>
                          <span className="font-medium text-[var(--theme-text-secondary)]">
                            {formatUsd(item.costUsd)}
                          </span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span>主会话 {mainConversationCount}</span>
                  )}
                  <span className="shrink-0 text-[10px]">
                    {mainConversationCount}会话·{formatExactNumber(totals.callCount)}轮
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-none space-y-1 p-2.5 whitespace-nowrap">
                {rawModelSlicesWithColor.map(({ model: m, color }) => (
                  <div key={m.modelName} className="flex items-center justify-between gap-3 text-[11px] tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <span style={{ backgroundColor: color }} className="inline-block size-1.5 rounded-full" />
                      <span>{m.modelName}</span>
                    </span>
                    <span className="font-mono">
                      {formatUsd(m.estimatedCostUsd)} · {formatTokens(m.totalTokens)}
                    </span>
                  </div>
                ))}
              </TooltipContent>
            </Tooltip>

            {isWeeklyPoolView && (
              <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-[var(--theme-border)] pt-2 text-[10.5px] tabular-nums">
                <label className="inline-flex shrink-0 items-center gap-1 text-[var(--theme-text-muted)]">
                  <span>周剩</span>
                  <Input
                    type="number"
                    min={0}
                    max={99}
                    step={1}
                    inputMode="decimal"
                    disabled={!canWriteWeeklyCalibration}
                    title={
                      calibrationSyncError
                        ? calibrationSyncError
                        : canWriteWeeklyCalibration
                          ? undefined
                          : "历史周视图或同步中仅支持只读查看，切回当前 7d 整池可修改校准"
                    }
                    aria-label="输入官方周剩余百分比以反算周满额"
                    placeholder="--"
                    value={draftPct}
                    onChange={(e) => handleRemainingPctChange(e.target.value)}
                    onBlur={onDraftBlur}
                    className="h-5 w-11 rounded px-1 text-center font-mono text-[11px] tabular-nums"
                  />
                  <span>%</span>
                </label>
                {weeklyProjection && activeCalibration ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="truncate font-mono text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                        满额 ≈ {formatUsd(weeklyProjection.fullCostUsd)} ·{" "}
                        {formatTokens(weeklyProjection.fullTokens)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs space-y-1 p-2.5 text-[11px] tabular-nums">
                      <div className="font-medium">
                        按官方周剩 {activeCalibration.remainingPct}% 反算（已用{" "}
                        {(100 - activeCalibration.remainingPct).toFixed(0)}%）
                      </div>
                      <div>
                        100% 周满额：{formatUsd(weeklyProjection.fullCostUsd)} ·{" "}
                        {formatTokens(weeklyProjection.fullTokens)} tokens
                      </div>
                      <div>
                        当前推算剩余：约 {weeklyProjection.estimatedRemainingPct.toFixed(1)}%（
                        {formatUsd(weeklyProjection.estimatedRemainingCostUsd)} ·{" "}
                        {formatTokens(weeklyProjection.estimatedRemainingTokens)}）
                      </div>
                      <div className="text-[10px] opacity-75">
                        校准基准：{formatUsd(activeCalibration.calibratedCostUsd)} /{" "}
                        {formatTokens(activeCalibration.calibratedTokens)}（
                        {formatDateTime(activeCalibration.calibratedAt).slice(0, 11)}）
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ) : calibrationSyncError ? (
                  <span title={calibrationSyncError} className="truncate text-[10px] text-amber-600 dark:text-amber-400">
                    校准同步异常（已保留本地）
                  </span>
                ) : (
                  <span className="truncate text-[10px] text-[var(--theme-text-muted)]">
                    填剩余%反算满额
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
});
