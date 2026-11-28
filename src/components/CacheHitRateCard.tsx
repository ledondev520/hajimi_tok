/**
 * Input: UsageTimeBucket 每日趋势序列、CallNodePoint 调用节点序列、WorkspaceUsageBreakdown、CacheTtlSummary、DailyUsageCard 共享日期归并工具、ModelCallChart、CacheTtlPanel 与 @/components/ui 组件。
 * Output: 导出 CacheHitRateCard 缓存命中率趋势折线卡片（默认展示「今日」单次节点缓存率，支持与「近7天」按日分模型及「TTL 衰减」一键切换）。
 * Pos: 看板中部趋势可视化扩展卡片，专门追踪 Prompt 缓存命中率波动与实测缓存 TTL 衰减曲线（src/components/CacheHitRateCard.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Percent } from "lucide-react";
import type {
  CacheTtlSummary,
  CallNodePoint,
  ModelUsageBreakdown,
  UsageTimeBucket,
  WorkspaceUsageBreakdown,
} from "@/types/telemetry";
import {
  calcCacheHitRate,
  computeAdaptivePercentBounds,
  formatPercent,
  formatTokens,
  readStoredJson,
  writeStoredJson,
} from "@/lib/format";
import { CacheTtlPanel } from "@/components/CacheTtlPanel";
import {
  extractTodayCallSummary,
  resolveDayMeta,
  toLocalDayKey,
} from "@/components/DailyUsageCard";
import {
  ModelCallChart,
  resolveModelStyle,
  type NodeWindowKey,
} from "@/components/ModelCallChart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** 缓存率趋势图时间粒度模式 */
type CacheTrendMode = "7d" | "today" | "ttl";

/** 单日内按模型家族归并的缓存命中统计 */
interface DayFamilyCacheStat {
  familyKey: string; // 模型家族唯一键
  label: string; // 模型短名称
  color: string; // 专属颜色 HEX
  inputTokens: number; // 当日新增未缓存输入
  cacheReadTokens: number; // 当日命中缓存读取
  cacheHitRate: number; // 当日该模型家族缓存命中率（0 ~ 1）
}

/** 标准化后的单日缓存率时间序列点 */
interface DailyCacheDay {
  bucketKey: string; // YYYY-MM-DD
  label: string; // MM-DD
  weekdayLabel: string; // 周几或“今日·周几”
  isToday: boolean; // 是否为本地今日
  inputTokens: number; // 当日总未缓存输入
  cacheReadTokens: number; // 当日总缓存读取
  cacheHitRate: number; // 当日整体缓存命中率（0 ~ 1）
  byFamily: Map<string, DayFamilyCacheStat>; // 模型家族键 -> 当日缓存率明细
}

/** 周期内模型家族缓存率汇总元数据 */
interface ModelCacheMeta {
  familyKey: string; // 模型家族唯一键
  label: string; // 模型展示名
  color: string; // 颜色 HEX
  inputTokens: number; // 周期累计未缓存输入
  cacheReadTokens: number; // 周期累计缓存读取
  cacheHitRate: number; // 周期加权缓存命中率（0 ~ 1）
}

/** CacheHitRateCard 组件入参 */
export interface CacheHitRateCardProps {
  dailyTrend: UsageTimeBucket[]; // 按日期升序排列的日趋势桶数组
  callTimeline: CallNodePoint[]; // 按时间升序排列的单次调用节点数组
  byModel: ModelUsageBreakdown[]; // 当前周期按模型汇总列表
  byWorkspace?: WorkspaceUsageBreakdown[]; // 当前周期各项目汇总列表（供 TTL 衰减按项目切换）
  cacheTtl?: CacheTtlSummary; // 当前筛选范围全局实测缓存 TTL 摘要与 6 档衰减分桶
  windowKey: NodeWindowKey; // 单次节点窗口档位（与其余节点图联动）
  onWindowKeyChange: (key: NodeWindowKey) => void; // 窗口切换回调
  hoveredSeq: number | null; // 跨图同步悬停节点序号
  onHoverSeq: (seq: number | null) => void; // 悬停节点变更回调
  onSelectConversationId: (conversationId: string) => void; // 点击单次节点打开会话详情
}

const CHART_HEIGHT = 152; // 与上方趋势折线图保持等高（像素）
const PAD_LEFT = 48; // 左侧 0%–100% 刻度留白
const PAD_RIGHT = 18; // 右侧边缘留白
const PAD_TOP = 12; // 顶部圆点防裁切留白
const PAD_BOTTOM = 22; // 底部日期横轴留白

/**
 * 职责：渲染 Prompt 缓存命中率趋势折线图卡片，支持「近7天」按日分模型缓存率与「今日」单次调用节点缓存率切换。
 * 思路：1) 「近7天」模式按日聚合整日与各模型家族的 cacheRead / (input + cacheRead) 命中率，固定 0%–100% Y 轴便于横向对比；
 *      2) 「今日」模式复用 ModelCallChart(variant="cacheRate")，并与全局节点窗口及悬停准星保持同步。
 * 参数：props — dailyTrend、callTimeline、byModel 及跨图联动回调。
 * 返回值：shadcn Card 包裹的缓存率趋势折线卡片。
 */
export const CacheHitRateCard = memo(function CacheHitRateCard({
  dailyTrend,
  callTimeline,
  byModel,
  byWorkspace = [],
  cacheTtl,
  windowKey,
  onWindowKeyChange,
  hoveredSeq,
  onHoverSeq,
  onSelectConversationId,
}: CacheHitRateCardProps) {
  // 0. 粒度模式（持久化至 localStorage，默认「今日」单次节点）、图例显隐集合与宽度测量
  const [granularity, setGranularity] = useState<CacheTrendMode>(() => {
    const saved = readStoredJson<string>("agy_chart_cache_granularity_v1", "today");
    return saved === "7d" || saved === "ttl" ? saved : "today";
  });
  useEffect(() => {
    writeStoredJson("agy_chart_cache_granularity_v1", granularity);
  }, [granularity]);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(
    () => new Set(readStoredJson<string[]>("agy_chart_hidden_cache_rate_v1", []))
  );
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [svgWidth, setSvgWidth] = useState<number>(960);

  useEffect(() => {
    writeStoredJson("agy_chart_hidden_cache_rate_v1", [...hiddenSeries]);
  }, [hiddenSeries]);

  const toggleSeries = (key: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  // 1.1. 仅在「今日」模式下遍历自然今日单次调用节点
  const { todayNodes, todayByModel } = useMemo(
    () => (granularity === "today" ? extractTodayCallSummary(callTimeline, byModel) : { todayNodes: [], todayByModel: [] }),
    [granularity, callTimeline, byModel]
  );

  // 1.2. 整理「近7天」按日整体与分模型家族缓存命中率序列
  const { days, families, periodCacheRate } = useMemo(() => {
    const todayKey = toLocalDayKey(new Date());
    const familyMap = new Map<string, ModelCacheMeta>();
    let totalInput = 0;
    let totalCacheRead = 0;

    const seriesDays: DailyCacheDay[] = dailyTrend
      .filter((b) => b.inputTokens + b.cacheReadTokens > 0)
      .sort((a, b) => a.bucketKey.localeCompare(b.bucketKey))
      .map((b) => {
        const { weekdayLabel, isToday } = resolveDayMeta(b.bucketKey, todayKey);
        const byFamily = new Map<string, DayFamilyCacheStat>();

        (b.models ?? []).forEach((m, idx) => {
          if (m.inputTokens + m.cacheReadTokens <= 0) return;
          const style = resolveModelStyle(m.modelName, idx);
          const cur = byFamily.get(style.familyKey);
          if (cur) {
            cur.inputTokens += m.inputTokens;
            cur.cacheReadTokens += m.cacheReadTokens;
            cur.cacheHitRate = calcCacheHitRate(cur.inputTokens, cur.cacheReadTokens);
          } else {
            byFamily.set(style.familyKey, {
              familyKey: style.familyKey,
              label: style.shortLabel,
              color: style.color,
              inputTokens: m.inputTokens,
              cacheReadTokens: m.cacheReadTokens,
              cacheHitRate: calcCacheHitRate(m.inputTokens, m.cacheReadTokens),
            });
          }

          const gFam = familyMap.get(style.familyKey);
          if (gFam) {
            gFam.inputTokens += m.inputTokens;
            gFam.cacheReadTokens += m.cacheReadTokens;
            gFam.cacheHitRate = calcCacheHitRate(gFam.inputTokens, gFam.cacheReadTokens);
          } else {
            familyMap.set(style.familyKey, {
              familyKey: style.familyKey,
              label: style.shortLabel,
              color: style.color,
              inputTokens: m.inputTokens,
              cacheReadTokens: m.cacheReadTokens,
              cacheHitRate: calcCacheHitRate(m.inputTokens, m.cacheReadTokens),
            });
          }
        });

        totalInput += b.inputTokens;
        totalCacheRead += b.cacheReadTokens;

        return {
          bucketKey: b.bucketKey,
          label: b.label,
          weekdayLabel,
          isToday,
          inputTokens: b.inputTokens,
          cacheReadTokens: b.cacheReadTokens,
          cacheHitRate: calcCacheHitRate(b.inputTokens, b.cacheReadTokens),
          byFamily,
        };
      });

    return {
      days: seriesDays,
      families: [...familyMap.values()].sort(
        (a, b) => b.cacheReadTokens + b.inputTokens - (a.cacheReadTokens + a.inputTokens)
      ),
      periodCacheRate: calcCacheHitRate(totalInput, totalCacheRead),
    };
  }, [dailyTrend]);

  // 1.3. 共享「按日 | 今日 | TTL 衰减」切换器（按日覆盖当前所选周期全部活跃日）
  const granularityTabs = (
    <Tabs
      value={granularity}
      onValueChange={(v) => setGranularity(v as CacheTrendMode)}
      aria-label="缓存率趋势与 TTL 衰减视图切换"
    >
      <TabsList className="h-6 p-0.5">
        <TabsTrigger value="7d" className="px-2 text-[11px]">
          按日
        </TabsTrigger>
        <TabsTrigger value="today" className="px-2 text-[11px]">
          今日
        </TabsTrigger>
        <TabsTrigger value="ttl" className="px-2 text-[11px]">
          TTL 衰减
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  // 2.0. 「TTL 衰减」模式：展示空闲间隔衰减折线与各项目上次有效时长速览
  if (granularity === "ttl") {
    return (
      <CacheTtlPanel
        cacheTtl={cacheTtl}
        byWorkspace={byWorkspace}
        leadingTabsSlot={granularityTabs}
      />
    );
  }

  // 2.1. 「今日」模式：复用 ModelCallChart 单次节点缓存率视图
  if (granularity === "today") {
    return (
      <ModelCallChart
        variant="cacheRate"
        titleOverride="今日缓存率"
        nodes={todayNodes}
        byModel={todayByModel}
        totalCallCount={todayNodes.length}
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

  // 2.2. 「近7天」模式：渲染按日整体缓存率与分模型家族缓存率折线图（自适应 Y 轴 + 可交互图例）
  const showOverall = !hiddenSeries.has("overall");
  const visibleRates: number[] = [];
  if (showOverall) {
    for (const d of days) visibleRates.push(d.cacheHitRate * 100);
  }
  for (const fam of families) {
    if (hiddenSeries.has(fam.familyKey)) continue;
    for (const d of days) {
      const stat = d.byFamily.get(fam.familyKey);
      if (stat) visibleRates.push(stat.cacheHitRate * 100);
    }
  }
  const { minY, maxY } = computeAdaptivePercentBounds(visibleRates);
  const ySpan = Math.max(1, maxY - minY);

  const plotW = Math.max(80, svgWidth - PAD_LEFT - PAD_RIGHT);
  const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const toX = (i: number): number =>
    days.length <= 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (i / (days.length - 1)) * plotW;
  const toY = (rate: number): number =>
    PAD_TOP + plotH - Math.min(1, Math.max(0, (rate * 100 - minY) / ySpan)) * plotH;

  const overallPts = showOverall
    ? days.map((d, idx) => ({
        x: toX(idx),
        y: toY(d.cacheHitRate),
        rate: d.cacheHitRate,
        idx,
      }))
    : [];
  const overallPoly = overallPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const overallArea =
    overallPts.length >= 2
      ? `M ${overallPts[0].x.toFixed(1)},${(PAD_TOP + plotH).toFixed(1)} L ${overallPts
          .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
          .join(" L ")} L ${overallPts[overallPts.length - 1].x.toFixed(1)},${(PAD_TOP + plotH).toFixed(1)} Z`
      : "";

  const familySeries = families
    .filter((fam) => !hiddenSeries.has(fam.familyKey))
    .map((fam) => {
      const pts = days
        .map((d, idx) => {
          const stat = d.byFamily.get(fam.familyKey);
          if (!stat) return null;
          return { x: toX(idx), y: toY(stat.cacheHitRate), stat, idx };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      const lineD = pts
        .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
        .join(" ");
      return { fam, pts, lineD };
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
            <Percent className="size-3.5 shrink-0 text-emerald-500" />
            <CardTitle className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              缓存命中率
            </CardTitle>
            <Badge variant="secondary" className="h-4 px-1.5 text-[11px] tabular-nums">
              {days.length} 活跃日 · 均 {formatPercent(periodCacheRate)}
            </Badge>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => toggleSeries("overall")}
                aria-pressed={showOverall}
                title="点击显示/隐藏日均总命中率"
                className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-medium transition-opacity ${
                  showOverall
                    ? "text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
                    : "text-slate-400 line-through opacity-45 hover:opacity-75 dark:text-slate-500"
                }`}
              >
                <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-emerald-500" />
                <span>总命中</span>
              </button>
              {families.map((fam) => {
                const isVisible = !hiddenSeries.has(fam.familyKey);
                return (
                  <button
                    key={fam.familyKey}
                    type="button"
                    onClick={() => toggleSeries(fam.familyKey)}
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
                      {formatPercent(fam.cacheHitRate)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-1.5">{granularityTabs}</div>
        </div>
      </CardHeader>

      <CardContent className="px-4">
        {days.length === 0 ? (
          <div className="flex h-[152px] items-center justify-center rounded-md border border-dashed border-slate-200 text-xs text-slate-400 dark:border-slate-800">
            当前周期暂无缓存命中记录
          </div>
        ) : (
          <div ref={wrapRef} className="relative w-full select-none">
            <svg
              width={svgWidth}
              height={CHART_HEIGHT}
              role="img"
              aria-label="所选周期按日缓存命中率变化折线图"
              className="block w-full overflow-visible"
              onMouseLeave={() => setHoveredDayIdx(null)}
            >
              <defs>
                <linearGradient id="cache-rate-overall-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* 水平参考网格线与自适应百分比刻度 */}
              {[0, 0.5, 1].map((ratio) => {
                const y = PAD_TOP + plotH * (1 - ratio);
                const tickVal = minY + ySpan * ratio;
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
                    <text
                      x={PAD_LEFT - 6}
                      y={y + 3.5}
                      textAnchor="end"
                      className="fill-slate-400 font-mono text-[10px] dark:fill-slate-500"
                    >
                      {`${Number.isInteger(tickVal) ? tickVal : tickVal.toFixed(1)}%`}
                    </text>
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
                          ? "stroke-emerald-500/60 dark:stroke-emerald-400/60"
                          : "stroke-slate-200/45 dark:stroke-slate-800/45"
                      }
                    />
                    <text
                      x={x}
                      y={CHART_HEIGHT - 4}
                      textAnchor="middle"
                      className={
                        d.isToday
                          ? "fill-emerald-600 font-mono text-[10px] font-semibold dark:fill-emerald-400"
                          : "fill-slate-400 font-mono text-[10px] dark:fill-slate-500"
                      }
                    >
                      {d.isToday ? "今日" : d.label}
                    </text>
                  </g>
                );
              })}

              {/* 整体日缓存率渐变面积 + 虚线 */}
              {overallArea && <path d={overallArea} fill="url(#cache-rate-overall-grad)" />}
              {overallPts.length >= 2 && (
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={overallPoly}
                />
              )}

              {/* 各模型家族日缓存率实线与数据圆点 */}
              {familySeries.map(({ fam, pts, lineD }) => (
                <g key={fam.familyKey}>
                  {pts.length >= 2 && (
                    <path
                      d={lineD}
                      fill="none"
                      stroke={fam.color}
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                  {pts.map((p) => {
                    const isHovered = hoveredDayIdx === p.idx;
                    return (
                      <circle
                        key={`${fam.familyKey}-${p.idx}`}
                        cx={p.x}
                        cy={p.y}
                        r={isHovered ? 4 : 2.8}
                        fill={fam.color}
                        className="stroke-white stroke-[1.2] dark:stroke-slate-950"
                      />
                    );
                  })}
                </g>
              ))}

              {/* 整体日缓存率空心节点 */}
              {overallPts.map((p) => {
                const isHovered = hoveredDayIdx === p.idx;
                return (
                  <circle
                    key={`overall-${p.idx}`}
                    cx={p.x}
                    cy={p.y}
                    r={isHovered ? 4 : 2.8}
                    fill="#ffffff"
                    stroke="#10b981"
                    strokeWidth={1.8}
                  />
                );
              })}

              {/* 透明热区列，确保任意日期列稳定响应悬停 */}
              {days.map((d, idx) => {
                const colW = days.length <= 1 ? plotW : plotW / Math.max(1, days.length - 1);
                const xStart =
                  days.length <= 1
                    ? PAD_LEFT
                    : Math.max(PAD_LEFT, toX(idx) - colW / 2);
                const xEnd =
                  days.length <= 1
                    ? PAD_LEFT + plotW
                    : Math.min(svgWidth - PAD_RIGHT, toX(idx) + colW / 2);
                return (
                  <rect
                    key={`hit-${d.bucketKey}`}
                    x={xStart}
                    y={0}
                    width={Math.max(12, xEnd - xStart)}
                    height={CHART_HEIGHT}
                    fill="transparent"
                    className="cursor-crosshair"
                    onMouseEnter={() => setHoveredDayIdx(idx)}
                  />
                );
              })}
            </svg>

            {/* 悬停单日缓存率明细浮窗 */}
            {hoveredDay && (
              <div
                style={{
                  left:
                    activeX > svgWidth * 0.62
                      ? `${Math.max(8, activeX - 246)}px`
                      : `${Math.min(svgWidth - 246, activeX + 12)}px`,
                  top: "4px",
                }}
                className="pointer-events-none absolute z-20 w-[234px] rounded-lg border border-slate-200 bg-white/95 p-2 text-[11px] shadow-md backdrop-blur-xs dark:border-slate-700 dark:bg-slate-900/95"
              >
                <div className="flex items-center justify-between border-b border-slate-100 pb-1 dark:border-slate-800">
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {hoveredDay.bucketKey} · {hoveredDay.weekdayLabel}
                  </span>
                  <span className="font-mono font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                    {formatPercent(hoveredDay.cacheHitRate)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400 tabular-nums">
                  <span>读缓存 {formatTokens(hoveredDay.cacheReadTokens)}</span>
                  <span>新输入 {formatTokens(hoveredDay.inputTokens)}</span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {families
                    .map((fam) => hoveredDay.byFamily.get(fam.familyKey))
                    .filter((fp): fp is DayFamilyCacheStat => Boolean(fp))
                    .map((fp) => (
                      <div
                        key={fp.familyKey}
                        className="flex items-center justify-between gap-2 text-[10px] tabular-nums"
                      >
                        <span className="inline-flex min-w-0 items-center gap-1 truncate text-slate-700 dark:text-slate-300">
                          <span
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: fp.color }}
                          />
                          <span className="truncate">{fp.label}</span>
                        </span>
                        <span className="shrink-0 font-mono text-slate-900 dark:text-slate-100">
                          {formatPercent(fp.cacheHitRate)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
