/**
 * Input: UsageTimeBucket 每日趋势序列、CallNodePoint 调用节点序列、ModelCallChart 单次节点折线组件与 @/components/ui 组件。
 * Output: 导出 DailyUsageCard 趋势主图组件（支持「近7天」主次双轴量价折线与「今日」单次调用增量折线一键切换）。
 * Pos: 看板中部核心双图之一（图 1），将近 7 天双轴分模型 Token/费用折线与今日单次节点调用增量折线合二为一（src/components/DailyUsageCard.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import type {
  CallNodePoint,
  ModelUsageBreakdown,
  UsageTimeBucket,
} from "@/types/telemetry";
import {
  computeAdaptiveLinearBounds,
  extractTodayCallSummary,
  formatExactNumber,
  formatTokens,
  formatUsd,
  readStoredJson,
  resolveDayMeta,
  toLocalDayKey,
  writeStoredJson,
} from "@/lib/format";

export { extractTodayCallSummary, resolveDayMeta, toLocalDayKey };
import {
  ModelCallChart,
  resolveModelStyle,
  type NodeWindowKey,
} from "@/components/ModelCallChart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** 图表时间粒度模式：近 7 天按日双轴折线 vs 今日单次调用节点折线 */
type TrendGranularityMode = "7d" | "today";

/** 单日内按模型家族归并后的数值项 */
interface DayFamilyPoint {
  familyKey: string; // 模型家族唯一键
  label: string; // 模型短名称（如 Gemini 4 Argon / Gemini 4 Carbon / Opus 5.5）
  color: string; // 专属颜色 HEX
  callCount: number; // 当日调用轮数
  totalTokens: number; // 当日总 Token
  estimatedCostUsd: number; // 当日等效美元成本
}

/** 标准化后的单日时间序列点 */
interface DailySeriesDay {
  bucketKey: string; // YYYY-MM-DD
  label: string; // MM-DD
  weekdayLabel: string; // 周几或“今日”
  isToday: boolean; // 是否为本地今日
  callCount: number; // 当日总调用次数
  totalTokens: number; // 当日总 Token
  estimatedCostUsd: number; // 当日总等效成本（USD）
  byFamily: Map<string, DayFamilyPoint>; // 模型家族键 -> 当日聚合值
}

/** 周期内模型家族元数据 */
interface ModelFamilyMeta {
  familyKey: string; // 模型家族唯一键
  label: string; // 模型展示名
  color: string; // 颜色 HEX
  periodTokens: number; // 周期累计 Token
  periodCostUsd: number; // 周期累计美元成本
}

/** DailyUsageCard 组件入参 */
export interface DailyUsageCardProps {
  dailyTrend: UsageTimeBucket[]; // 按日期升序排列的日趋势桶数组
  callTimeline: CallNodePoint[]; // 按时间升序排列的单次调用节点数组
  byModel: ModelUsageBreakdown[]; // 当前周期按模型汇总列表
  windowKey: NodeWindowKey; // 单次节点窗口档位（与右侧 TPS 折线联动）
  onWindowKeyChange: (key: NodeWindowKey) => void; // 窗口切换回调
  hoveredSeq: number | null; // 跨图同步悬停节点序号
  onHoverSeq: (seq: number | null) => void; // 悬停节点变更回调
  onSelectConversationId: (conversationId: string) => void; // 点击单次节点打开会话详情
}

const CHART_HEIGHT = 152; // 与右侧单次节点 TPS 折线图保持完全等高（像素）
const PAD_LEFT = 48; // 左侧主轴（Token）刻度留白
const PAD_RIGHT = 50; // 右侧次轴（$ USD 费用）刻度留白
const PAD_TOP = 12; // 顶部圆点留白
const PAD_BOTTOM = 22; // 底部日期横轴留白

/**
 * 职责：渲染合并后的趋势主图卡片——默认展示「近7天」分模型 Token（左主轴实线 ●）与费用（右次轴虚线 ○）双轴同显折线，切换「今日」时呈现当日单次节点调用增量折线。
 * 思路：1) 顶栏右侧固定提供「近7天 | 今日」一键切换，去除冗余的单轴模式开关与累计增长开关；
 *      2) 「近7天」模式直接双轴同显各模型每日 Token 与美元费用；
 *      3) 「今日」模式筛选自然今日的调用节点复用 ModelCallChart 单次节点视图，并与右侧 TPS 折线保持跨图准星同步。
 * 参数：props — 包含 dailyTrend、callTimeline、byModel 及跨图联动状态。
 * 返回值：与右侧 TPS 折线图等高对齐的趋势折线卡片。
 */
export const DailyUsageCard = memo(function DailyUsageCard({
  dailyTrend,
  callTimeline,
  byModel,
  windowKey,
  onWindowKeyChange,
  hoveredSeq,
  onHoverSeq,
  onSelectConversationId,
}: DailyUsageCardProps) {
  // 0. 粒度切换状态（持久化至 localStorage，默认「近7天」双轴同显）、图例显隐集合与宽度测量
  const [granularity, setGranularity] = useState<TrendGranularityMode>(() =>
    readStoredJson<string>("agy_chart_daily_granularity_v1", "7d") === "today" ? "today" : "7d"
  );
  useEffect(() => {
    writeStoredJson("agy_chart_daily_granularity_v1", granularity);
  }, [granularity]);
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<string>>(
    () => new Set(readStoredJson<string[]>("agy_chart_hidden_daily_usage_v1", []))
  );
  const [showTokens, setShowTokens] = useState<boolean>(
    () => readStoredJson<{ showTokens: boolean; showCost: boolean }>("agy_chart_daily_metrics_v1", { showTokens: true, showCost: true }).showTokens
  );
  const [showCost, setShowCost] = useState<boolean>(
    () => readStoredJson<{ showTokens: boolean; showCost: boolean }>("agy_chart_daily_metrics_v1", { showTokens: true, showCost: true }).showCost
  );
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [svgWidth, setSvgWidth] = useState<number>(640);

  useEffect(() => {
    writeStoredJson("agy_chart_hidden_daily_usage_v1", [...hiddenFamilies]);
  }, [hiddenFamilies]);

  useEffect(() => {
    writeStoredJson("agy_chart_daily_metrics_v1", { showTokens, showCost });
  }, [showTokens, showCost]);

  const toggleFamily = (familyKey: string) => {
    setHiddenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(familyKey)) next.delete(familyKey);
      else next.add(familyKey);
      return next;
    });
  };

  useEffect(() => {
    if (granularity !== "7d") return;
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const updateWidth = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 120) setSvgWidth(w);
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [granularity]);

  // 1.1. 仅在「今日」模式下筛选自然今日的单次调用节点，并结合 dailyTrend 今日桶保持全天轮数与模型均值准确
  const { todayNodes, todayByModel, todayTotalCalls } = useMemo(
    () =>
      granularity === "today"
        ? extractTodayCallSummary(callTimeline, byModel, dailyTrend)
        : { todayNodes: [], todayByModel: [], todayTotalCalls: 0 },
    [granularity, callTimeline, byModel, dailyTrend]
  );

  // 1.2. 整理「近7天」按日分模型序列数据
  const { days, families, avgTokens, avgCost } = useMemo(() => {
    const todayKey = toLocalDayKey(new Date());
    const familyMap = new Map<string, ModelFamilyMeta>();

    let sumTokens = 0;
    let sumCost = 0;
    let peakTokens = 0;
    let peakCost = 0;

    const seriesDays: DailySeriesDay[] = dailyTrend
      .filter((b) => b.totalTokens > 0 || b.callCount > 0)
      .sort((a, b) => a.bucketKey.localeCompare(b.bucketKey))
      .map((b) => {
        const { weekdayLabel, isToday } = resolveDayMeta(b.bucketKey, todayKey);
        const byFamily = new Map<string, DayFamilyPoint>();

        (b.models ?? []).forEach((m, idx) => {
          const style = resolveModelStyle(m.modelName, idx);
          const cur = byFamily.get(style.familyKey);
          if (cur) {
            cur.callCount += m.callCount;
            cur.totalTokens += m.totalTokens;
            cur.estimatedCostUsd += m.estimatedCostUsd;
          } else {
            byFamily.set(style.familyKey, {
              familyKey: style.familyKey,
              label: style.shortLabel,
              color: style.color,
              callCount: m.callCount,
              totalTokens: m.totalTokens,
              estimatedCostUsd: m.estimatedCostUsd,
            });
          }

          const gFam = familyMap.get(style.familyKey);
          if (gFam) {
            gFam.periodTokens += m.totalTokens;
            gFam.periodCostUsd += m.estimatedCostUsd;
          } else {
            familyMap.set(style.familyKey, {
              familyKey: style.familyKey,
              label: style.shortLabel,
              color: style.color,
              periodTokens: m.totalTokens,
              periodCostUsd: m.estimatedCostUsd,
            });
          }
        });

        for (const fp of byFamily.values()) {
          if (fp.totalTokens > peakTokens) peakTokens = fp.totalTokens;
          if (fp.estimatedCostUsd > peakCost) peakCost = fp.estimatedCostUsd;
        }

        sumTokens += b.totalTokens;
        sumCost += b.estimatedCostUsd;

        return {
          bucketKey: b.bucketKey,
          label: b.label,
          weekdayLabel,
          isToday,
          callCount: b.callCount,
          totalTokens: b.totalTokens,
          estimatedCostUsd: b.estimatedCostUsd,
          byFamily,
        };
      });

    const activeCount = Math.max(1, seriesDays.length);
    return {
      days: seriesDays,
      families: [...familyMap.values()].sort(
        (a, b) => b.periodCostUsd - a.periodCostUsd || b.periodTokens - a.periodTokens
      ),
      avgTokens: sumTokens / activeCount,
      avgCost: sumCost / activeCount,
      maxModelTokens: peakTokens > 0 ? peakTokens * 1.1 : 1,
      maxModelCost: peakCost > 0 ? peakCost * 1.1 : 1,
    };
  }, [dailyTrend]);

  // 1.3. 共享的「按日 | 今日」粒度切换标签栏（按日覆盖当前所选周期全部活跃日）
  const granularityTabs = (
    <Tabs
      value={granularity}
      onValueChange={(v) => setGranularity(v as TrendGranularityMode)}
      aria-label="趋势时间范围切换"
    >
      <TabsList className="h-6 p-0.5">
        <TabsTrigger value="7d" className="px-2 text-[11px]">
          按日
        </TabsTrigger>
        <TabsTrigger value="today" className="px-2 text-[11px]">
          今日
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  // 2.1. 若用户切换至「今日」，直接渲染今日单次节点调用增量折线图
  if (granularity === "today") {
    return (
      <ModelCallChart
        variant="tokens"
        titleOverride="今日消耗"
        nodes={todayNodes}
        byModel={todayByModel}
        totalCallCount={todayTotalCalls}
        windowKey={windowKey}
        onWindowKeyChange={onWindowKeyChange}
        hoveredSeq={hoveredSeq}
        onHoverSeq={onHoverSeq}
        onSelectConversationId={onSelectConversationId}
        leadingTabsSlot={granularityTabs}
        emptyMessage="今日暂无数据"
      />
    );
  }

  // 2.2. 「近7天」模式：渲染自适应双轴同显折线图（左主轴 Token 实线 ● + 右次轴 $ 费用虚线 ○，支持图例点击显隐）
  const visibleFamilies = families.filter((fam) => !hiddenFamilies.has(fam.familyKey));
  const visibleTokenVals: number[] = [];
  const visibleCostVals: number[] = [];
  for (const fam of visibleFamilies) {
    for (const d of days) {
      const fp = d.byFamily.get(fam.familyKey);
      if (fp) {
        visibleTokenVals.push(fp.totalTokens);
        visibleCostVals.push(fp.estimatedCostUsd);
      }
    }
  }
  const tokenBounds = computeAdaptiveLinearBounds(visibleTokenVals, 1);
  const costBounds = computeAdaptiveLinearBounds(visibleCostVals, 1);
  const tokenSpan = Math.max(1e-9, tokenBounds.maxY - tokenBounds.minY);
  const costSpan = Math.max(1e-9, costBounds.maxY - costBounds.minY);

  const plotW = Math.max(80, svgWidth - PAD_LEFT - PAD_RIGHT);
  const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const toX = (i: number): number =>
    days.length <= 1
      ? PAD_LEFT + plotW / 2
      : PAD_LEFT + (i / (days.length - 1)) * plotW;

  const toYToken = (v: number): number =>
    PAD_TOP + plotH - Math.min(1, Math.max(0, (v - tokenBounds.minY) / tokenSpan)) * plotH;

  const toYCost = (v: number): number =>
    PAD_TOP + plotH - Math.min(1, Math.max(0, (v - costBounds.minY) / costSpan)) * plotH;

  const seriesList = visibleFamilies.map((fam) => {
    const tokenPts = days.map((d, idx) => {
      const val = d.byFamily.get(fam.familyKey)?.totalTokens ?? 0;
      return { x: toX(idx), y: toYToken(val), val, idx };
    });
    const costPts = days.map((d, idx) => {
      const val = d.byFamily.get(fam.familyKey)?.estimatedCostUsd ?? 0;
      return { x: toX(idx), y: toYCost(val), val, idx };
    });

    const tokenPoly = tokenPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const costPoly = costPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    const first = tokenPts[0];
    const last = tokenPts[tokenPts.length - 1];
    const tokenArea =
      tokenPts.length >= 2 && first && last
        ? `M ${first.x.toFixed(1)},${(PAD_TOP + plotH).toFixed(1)} L ${tokenPts
            .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(" L ")} L ${last.x.toFixed(1)},${(PAD_TOP + plotH).toFixed(1)} Z`
        : "";

    return { fam, tokenPts, costPts, tokenPoly, costPoly, tokenArea };
  });

  const hoveredDay =
    hoveredDayIdx !== null && hoveredDayIdx >= 0 && hoveredDayIdx < days.length
      ? days[hoveredDayIdx]
      : null;
  const activeX = hoveredDay && hoveredDayIdx !== null ? toX(hoveredDayIdx) : 0;

  return (
    <Card className="min-w-0 gap-2 border-slate-200/80 bg-white py-2.5 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CalendarDays className="size-3.5 shrink-0 text-indigo-500" />
            <CardTitle className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              每日消耗
            </CardTitle>
            <Badge variant="secondary" className="h-4 px-1.5 text-[11px] tabular-nums">
              {days.length} 活跃日 · 均 {formatTokens(avgTokens)} · {formatUsd(avgCost)}
            </Badge>

            {/* 周期模型图例 + 主次双轴线型说明（均支持点击显隐） */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-0.5 text-[11px]">
              {families.map((fam) => {
                const isVisible = !hiddenFamilies.has(fam.familyKey);
                return (
                  <button
                    key={fam.familyKey}
                    type="button"
                    onClick={() => toggleFamily(fam.familyKey)}
                    aria-pressed={isVisible}
                    title={`点击显示/隐藏 ${fam.label}`}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-medium tabular-nums transition-opacity ${
                      isVisible
                        ? "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70"
                        : "text-slate-400 line-through opacity-45 hover:opacity-75 dark:text-slate-500"
                    }`}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: fam.color }}
                    />
                    <span>{fam.label}</span>
                    <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">
                      {formatUsd(fam.periodCostUsd)}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setShowTokens((v) => !v)}
                aria-pressed={showTokens}
                title="点击显示/隐藏 Token 实线"
                className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10px] transition-opacity ${
                  showTokens
                    ? "text-indigo-600/85 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                    : "text-slate-400 line-through opacity-45 hover:opacity-75 dark:text-slate-500"
                }`}
              >
                ●实线Token
              </button>
              <button
                type="button"
                onClick={() => setShowCost((v) => !v)}
                aria-pressed={showCost}
                title="点击显示/隐藏费用虚线"
                className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10px] transition-opacity ${
                  showCost
                    ? "text-amber-600/90 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40"
                    : "text-slate-400 line-through opacity-45 hover:opacity-75 dark:text-slate-500"
                }`}
              >
                ○虚线费用$
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">{granularityTabs}</div>
        </div>
      </CardHeader>

      <CardContent className="px-4">
        {days.length === 0 ? (
          <div className="flex h-[152px] items-center justify-center rounded-md border border-dashed border-slate-200 text-xs text-slate-400 dark:border-slate-800">
            当前周期暂无按日消耗记录
          </div>
        ) : (
          <div ref={wrapRef} className="relative w-full select-none">
            <svg
              width={svgWidth}
              height={CHART_HEIGHT}
              role="img"
              aria-label="所选周期按日分模型 Token 与费用主次双轴折线图"
              className="block w-full overflow-visible"
              onMouseLeave={() => setHoveredDayIdx(null)}
            >
              <defs>
                {families.map((fam) => {
                  const gradId = `daily-dual-${fam.familyKey.replace(/[^a-z0-9]/gi, "-")}`;
                  return (
                    <linearGradient key={gradId} id={gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={fam.color} stopOpacity="0.18" />
                      <stop offset="100%" stopColor={fam.color} stopOpacity="0.01" />
                    </linearGradient>
                  );
                })}
              </defs>

              {/* 水平参考网格线 + 左主轴（Token）刻度 + 右次轴（$ USD）刻度 */}
              {[0, 0.5, 1].map((ratio) => {
                const tokenVal = tokenBounds.minY + tokenSpan * ratio;
                const costVal = costBounds.minY + costSpan * ratio;
                const y = PAD_TOP + plotH * (1 - ratio);
                return (
                  <g key={ratio}>
                    <line
                      x1={PAD_LEFT}
                      y1={y}
                      x2={svgWidth - PAD_RIGHT}
                      y2={y}
                      strokeDasharray={ratio === 0 ? undefined : "3 3"}
                      className="stroke-slate-200/90 dark:stroke-slate-800"
                    />
                    {showTokens && (
                      <text
                        x={PAD_LEFT - 6}
                        y={y + 3.5}
                        textAnchor="end"
                        className="fill-indigo-600/80 font-mono text-[10px] dark:fill-indigo-400/80"
                      >
                        {tokenVal <= 0 ? "0" : formatTokens(tokenVal)}
                      </text>
                    )}
                    {showCost && (
                      <text
                        x={svgWidth - PAD_RIGHT + 6}
                        y={y + 3.5}
                        textAnchor="start"
                        className="fill-amber-600/90 font-mono text-[10px] dark:fill-amber-400/90"
                      >
                        {costVal <= 0 ? "$0" : formatUsd(costVal)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* 底部 X 轴自然日刻度与纵向准星线 */}
              {days.map((d, idx) => {
                const x = toX(idx);
                const isHovered = hoveredDayIdx === idx;
                return (
                  <g key={d.bucketKey}>
                    <line
                      x1={x}
                      y1={PAD_TOP}
                      x2={x}
                      y2={PAD_TOP + plotH}
                      strokeDasharray={isHovered ? "3 2" : undefined}
                      strokeWidth={isHovered ? 1.4 : 1}
                      className={
                        isHovered
                          ? "stroke-indigo-500/60 dark:stroke-indigo-400/60"
                          : "stroke-slate-200/45 dark:stroke-slate-800/45"
                      }
                    />
                    <text
                      x={x}
                      y={CHART_HEIGHT - 4}
                      textAnchor="middle"
                      className={
                        d.isToday || isHovered
                          ? "fill-indigo-600 font-mono text-[10px] font-bold dark:fill-indigo-400"
                          : "fill-slate-400 font-mono text-[10px] dark:fill-slate-500"
                      }
                    >
                      {d.label}
                    </text>
                  </g>
                );
              })}

              {/* 左主轴：各模型每日 Token 渐变面积与实线 */}
              {showTokens &&
                seriesList.map(({ fam, tokenArea, tokenPoly, tokenPts }) => {
                  const gradId = `daily-dual-${fam.familyKey.replace(/[^a-z0-9]/gi, "-")}`;
                  return (
                    <g key={`tok-${fam.familyKey}`}>
                      {tokenArea && <path d={tokenArea} fill={`url(#${gradId})`} />}
                      {tokenPts.length >= 2 && (
                        <polyline
                          fill="none"
                          stroke={fam.color}
                          strokeWidth={2.1}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          points={tokenPoly}
                        />
                      )}
                    </g>
                  );
                })}

              {/* 右次轴：各模型每日美元费用虚线 */}
              {showCost &&
                seriesList.map(({ fam, costPoly, costPts }) =>
                  costPts.length >= 2 ? (
                    <polyline
                      key={`cost-${fam.familyKey}`}
                      fill="none"
                      stroke={fam.color}
                      strokeWidth={1.8}
                      strokeDasharray="5 3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.9}
                      points={costPoly}
                    />
                  ) : null
                )}

              {/* 左主轴：Token 实心圆点（●） */}
              {showTokens &&
                seriesList.map(({ fam, tokenPts }) =>
                  tokenPts.map((p) => {
                    const isHovered = hoveredDayIdx === p.idx;
                    if (p.val <= 0 && !isHovered) {
                      return (
                        <circle
                          key={`tok-dot-${fam.familyKey}-${p.idx}`}
                          cx={p.x}
                          cy={p.y}
                          r={1.4}
                          fill={fam.color}
                          opacity={0.3}
                        />
                      );
                    }
                    return (
                      <circle
                        key={`tok-dot-${fam.familyKey}-${p.idx}`}
                        cx={p.x}
                        cy={p.y}
                        r={isHovered ? 4.8 : 3.4}
                        fill={fam.color}
                        className="stroke-white stroke-[1.3] dark:stroke-slate-950"
                      />
                    );
                  })
                )}

              {/* 右次轴：美元费用空心圆环节点（○） */}
              {showCost &&
                seriesList.map(({ fam, costPts }) =>
                  costPts.map((p) => {
                    const isHovered = hoveredDayIdx === p.idx;
                    if (p.val <= 0 && !isHovered) return null;
                    return (
                      <circle
                        key={`cost-dot-${fam.familyKey}-${p.idx}`}
                        cx={p.x}
                        cy={p.y}
                        r={isHovered ? 4.6 : 3.2}
                      stroke={fam.color}
                      strokeWidth={isHovered ? 2.1 : 1.7}
                      className="fill-white dark:fill-slate-950"
                    />
                  );
                })
              )}

              {/* 按日感应热区：悬停弹出明细，点击「今日」节点可直接钻取至今日单次调用折线 */}
              {days.map((d, idx) => {
                const x = toX(idx);
                const sliceW = days.length <= 1 ? plotW : plotW / (days.length - 1);
                return (
                  <rect
                    key={`hit-${d.bucketKey}`}
                    x={Math.max(PAD_LEFT, x - sliceW / 2)}
                    y={0}
                    width={sliceW}
                    height={CHART_HEIGHT}
                    fill="transparent"
                    className={d.isToday ? "cursor-pointer" : "cursor-crosshair"}
                    onMouseEnter={() => setHoveredDayIdx(idx)}
                    onClick={() => {
                      if (d.isToday) setGranularity("today");
                    }}
                  />
                );
              })}
            </svg>

            {/* 悬停任意自然日时浮出的分模型双轴明细卡片 */}
            {hoveredDay && (
              <div
                style={{
                  left:
                    activeX > svgWidth * 0.55
                      ? `${Math.max(8, activeX - 252)}px`
                      : `${Math.min(svgWidth - 252, activeX + 12)}px`,
                  top: "4px",
                }}
                className="pointer-events-none absolute z-20 w-[244px] rounded-lg border border-slate-200 bg-white/95 p-2 text-[11px] shadow-md backdrop-blur-xs dark:border-slate-700 dark:bg-slate-900/95"
              >
                <div className="flex items-center justify-between gap-1 border-b border-slate-100 pb-1 dark:border-slate-800">
                  <span className="font-bold text-slate-900 tabular-nums dark:text-slate-100">
                    {hoveredDay.bucketKey} ({hoveredDay.weekdayLabel})
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    {formatExactNumber(hoveredDay.callCount)} 轮
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between font-semibold text-slate-700 tabular-nums dark:text-slate-200">
                  <span>当日合计</span>
                  <span>
                    <strong className="text-indigo-600 dark:text-indigo-400">
                      {formatTokens(hoveredDay.totalTokens)}
                    </strong>
                    {" · "}
                    <strong className="text-amber-600 dark:text-amber-400">
                      {formatUsd(hoveredDay.estimatedCostUsd)}
                    </strong>
                  </span>
                </div>
                <div className="mt-1 space-y-0.5 border-t border-slate-100 pt-1 tabular-nums dark:border-slate-800">
                  {families.map((fam) => {
                    const fp = hoveredDay.byFamily.get(fam.familyKey);
                    if (!fp || (fp.totalTokens <= 0 && fp.estimatedCostUsd <= 0)) return null;
                    return (
                      <div
                        key={fam.familyKey}
                        className="flex items-center justify-between gap-1.5 text-[10px]"
                      >
                        <span className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-slate-700 dark:text-slate-200">
                          <span
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: fam.color }}
                          />
                          <span className="truncate">{fam.label}</span>
                        </span>
                        <span className="shrink-0 text-slate-500 dark:text-slate-300">
                          ●{formatTokens(fp.totalTokens)} ·{" "}
                          <strong className="font-semibold text-amber-600 dark:text-amber-400">
                            ○{formatUsd(fp.estimatedCostUsd)}
                          </strong>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
