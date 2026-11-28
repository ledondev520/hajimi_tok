/**
 * Input: UsageTimeBucket 每日趋势序列、CallNodePoint 调用节点序列、WorkspaceUsageBreakdown、CacheTtlSummary、@/lib/format 工具、SvgChartPrimitives 共享绘图原语、ModelCallChart、CacheTtlPanel 与 @/components/ui 组件。
 * Output: 导出 CacheHitRateCard 缓存命中率趋势折线卡片（默认展示「今日」单次节点缓存率，支持与「按日」分模型及「TTL 衰减」一键切换）。
 * Pos: 看板中部趋势可视化扩展卡片，专门追踪 Prompt 缓存命中率波动与实测缓存 TTL 衰减曲线（src/components/CacheHitRateCard.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { lazy, memo, Suspense, useEffect, useMemo, useState } from "react";
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
  extractTodayCallSummary,
  formatPercent,
  formatTokens,
  readStoredJson,
  resolveDayMeta,
  toLocalDayKey,
  writeStoredJson,
} from "@/lib/format";
import {
  ModelCallChart,
  resolveModelStyle,
  type NodeWindowKey,
} from "@/components/ModelCallChart";
import {
  buildAreaPath,
  buildLinePath,
  CHART_CARD_CLASS,
  ChartEmptyBox,
  ChartFloatingTooltip,
  ChartLegendToggle,
  formatPercentTick,
  SvgAreaGradients,
  SvgDayAxisOverlay,
  SvgGridAxes,
  useContainerWidth,
  usePersistedSet,
} from "@/components/SvgChartPrimitives";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const CacheTtlPanel = lazy(() =>
  import("@/components/CacheTtlPanel").then((m) => ({ default: m.CacheTtlPanel }))
);

type CacheTrendMode = "7d" | "today" | "ttl";

interface DayFamilyCacheStat {
  familyKey: string;
  label: string;
  color: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
}

interface DailyCacheDay {
  bucketKey: string;
  label: string;
  weekdayLabel: string;
  isToday: boolean;
  inputTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
  byFamily: Map<string, DayFamilyCacheStat>;
}

interface ModelCacheMeta {
  familyKey: string;
  label: string;
  color: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
}

export interface CacheHitRateCardProps {
  dailyTrend: UsageTimeBucket[];
  callTimeline: CallNodePoint[];
  byModel: ModelUsageBreakdown[];
  byWorkspace?: WorkspaceUsageBreakdown[];
  cacheTtl?: CacheTtlSummary;
  windowKey: NodeWindowKey;
  onWindowKeyChange: (key: NodeWindowKey) => void;
  hoveredSeq: number | null;
  onHoverSeq: (seq: number | null) => void;
  onSelectConversationId: (conversationId: string) => void;
}

const CHART_HEIGHT = 152;
const PAD_LEFT = 48;
const PAD_RIGHT = 18;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;

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
  const [granularity, setGranularity] = useState<CacheTrendMode>(() => {
    const saved = readStoredJson<string>("agy_chart_cache_granularity_v1", "today");
    return saved === "7d" || saved === "ttl" ? saved : "today";
  });
  useEffect(() => {
    writeStoredJson("agy_chart_cache_granularity_v1", granularity);
  }, [granularity]);

  const [hiddenSeries, toggleSeries] = usePersistedSet("agy_chart_hidden_cache_rate_v1");
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const { wrapRef, svgWidth } = useContainerWidth(granularity === "7d", 960);

  const { todayNodes, todayByModel, todayTotalCalls } = useMemo(
    () =>
      granularity === "today"
        ? extractTodayCallSummary(callTimeline, byModel, dailyTrend)
        : { todayNodes: [], todayByModel: [], todayTotalCalls: 0 },
    [granularity, callTimeline, byModel, dailyTrend]
  );

  const { days, families, periodCacheRate } = useMemo(() => {
    const todayKey = toLocalDayKey(new Date());
    const familyMap = new Map<string, ModelCacheMeta>();
    let totalInput = 0;
    let totalCacheRead = 0;

    const addStat = (
      target: Map<string, DayFamilyCacheStat>,
      familyKey: string,
      label: string,
      color: string,
      input: number,
      cacheRead: number
    ) => {
      const cur = target.get(familyKey);
      if (cur) {
        cur.inputTokens += input;
        cur.cacheReadTokens += cacheRead;
        cur.cacheHitRate = calcCacheHitRate(cur.inputTokens, cur.cacheReadTokens);
      } else {
        target.set(familyKey, {
          familyKey,
          label,
          color,
          inputTokens: input,
          cacheReadTokens: cacheRead,
          cacheHitRate: calcCacheHitRate(input, cacheRead),
        });
      }
    };

    const seriesDays: DailyCacheDay[] = dailyTrend
      .filter((b) => b.inputTokens + b.cacheReadTokens > 0)
      .sort((a, b) => a.bucketKey.localeCompare(b.bucketKey))
      .map((b) => {
        const { weekdayLabel, isToday } = resolveDayMeta(b.bucketKey, todayKey);
        const byFamily = new Map<string, DayFamilyCacheStat>();
        (b.models ?? []).forEach((m, idx) => {
          if (m.inputTokens + m.cacheReadTokens <= 0) return;
          const style = resolveModelStyle(m.modelName, idx);
          addStat(byFamily, style.familyKey, style.shortLabel, style.color, m.inputTokens, m.cacheReadTokens);
          addStat(familyMap, style.familyKey, style.shortLabel, style.color, m.inputTokens, m.cacheReadTokens);
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

  const granularityTabs = (
    <Tabs
      value={granularity}
      onValueChange={(v) => setGranularity(v as CacheTrendMode)}
      aria-label="缓存率趋势与 TTL 衰减视图切换"
    >
      <TabsList className="h-6 p-0.5">
        <TabsTrigger value="7d" className="px-2 text-[11px]">按日</TabsTrigger>
        <TabsTrigger value="today" className="px-2 text-[11px]">今日</TabsTrigger>
        <TabsTrigger value="ttl" className="px-2 text-[11px]">TTL 衰减</TabsTrigger>
      </TabsList>
    </Tabs>
  );

  if (granularity === "ttl") {
    return (
      <Suspense fallback={<div className="h-[220px] rounded-xl border border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-900/70" />}>
        <CacheTtlPanel cacheTtl={cacheTtl} byWorkspace={byWorkspace} leadingTabsSlot={granularityTabs} />
      </Suspense>
    );
  }

  if (granularity === "today") {
    return (
      <ModelCallChart
        variant="cacheRate"
        titleOverride="今日缓存率"
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
  const toX = (i: number) =>
    days.length <= 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (i / (days.length - 1)) * plotW;
  const toY = (rate: number) =>
    PAD_TOP + plotH - Math.min(1, Math.max(0, (rate * 100 - minY) / ySpan)) * plotH;

  const overallPts = showOverall
    ? days.map((d, idx) => ({ x: toX(idx), y: toY(d.cacheHitRate), rate: d.cacheHitRate, idx }))
    : [];
  const overallLine = buildLinePath(overallPts);
  const overallArea = buildAreaPath(overallPts, PAD_TOP + plotH);

  const familySeries = families
    .filter((fam) => !hiddenSeries.has(fam.familyKey))
    .map((fam) => {
      const pts = days
        .map((d, idx) => {
          const stat = d.byFamily.get(fam.familyKey);
          return stat ? { x: toX(idx), y: toY(stat.cacheHitRate), stat, idx } : null;
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      return { fam, pts, lineD: buildLinePath(pts) };
    });

  const hoveredDay =
    hoveredDayIdx !== null && hoveredDayIdx >= 0 && hoveredDayIdx < days.length
      ? days[hoveredDayIdx]
      : null;
  const activeX = hoveredDay && hoveredDayIdx !== null ? toX(hoveredDayIdx) : 0;

  return (
    <Card className={CHART_CARD_CLASS}>
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
              <ChartLegendToggle
                label="总命中"
                color="#10b981"
                dashedLine
                visible={showOverall}
                onToggle={() => toggleSeries("overall")}
                title="点击显示/隐藏日均总命中率"
              />
              {families.map((fam) => (
                <ChartLegendToggle
                  key={fam.familyKey}
                  label={fam.label}
                  color={fam.color}
                  meta={formatPercent(fam.cacheHitRate)}
                  visible={!hiddenSeries.has(fam.familyKey)}
                  onToggle={() => toggleSeries(fam.familyKey)}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">{granularityTabs}</div>
        </div>
      </CardHeader>

      <CardContent className="px-4">
        {days.length === 0 ? (
          <ChartEmptyBox message="当前周期暂无缓存命中记录" />
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
              <SvgAreaGradients
                items={[{ id: "cache-rate-overall-grad", color: "#10b981", topOpacity: 0.16 }]}
              />

              <SvgGridAxes
                padLeft={PAD_LEFT}
                padRight={PAD_RIGHT}
                padTop={PAD_TOP}
                plotH={plotH}
                svgWidth={svgWidth}
                formatLeftLabel={(ratio) => formatPercentTick(minY + ySpan * ratio)}
              />

              {overallArea && <path d={overallArea} fill="url(#cache-rate-overall-grad)" />}
              {overallLine && (
                <path
                  d={overallLine}
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {familySeries.map(({ fam, pts, lineD }) => (
                <g key={fam.familyKey}>
                  {lineD && (
                    <path
                      d={lineD}
                      fill="none"
                      stroke={fam.color}
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                  {pts.map((p) => (
                    <circle
                      key={`${fam.familyKey}-${p.idx}`}
                      cx={p.x}
                      cy={p.y}
                      r={hoveredDayIdx === p.idx ? 4 : 2.8}
                      fill={fam.color}
                      className="stroke-white stroke-[1.2] dark:stroke-slate-950"
                    />
                  ))}
                </g>
              ))}

              {overallPts.map((p) => (
                <circle
                  key={`overall-${p.idx}`}
                  cx={p.x}
                  cy={p.y}
                  r={hoveredDayIdx === p.idx ? 4 : 2.8}
                  fill="#ffffff"
                  stroke="#10b981"
                  strokeWidth={1.8}
                />
              ))}

              <SvgDayAxisOverlay
                days={days}
                toX={toX}
                padLeft={PAD_LEFT}
                padRight={PAD_RIGHT}
                padTop={PAD_TOP}
                plotW={plotW}
                plotH={plotH}
                chartHeight={CHART_HEIGHT}
                svgWidth={svgWidth}
                hoveredIdx={hoveredDayIdx}
                onHoverIdx={setHoveredDayIdx}
                hoverLineClassName="stroke-emerald-500/60 dark:stroke-emerald-400/60"
                todayLabelClassName="fill-emerald-600 font-mono text-[10px] font-semibold dark:fill-emerald-400"
                formatDayLabel={(d) => (d.isToday ? "今日" : d.label)}
              />
            </svg>

            {hoveredDay && (
              <ChartFloatingTooltip x={activeX} svgWidth={svgWidth} width={234} flipRatio={0.62}>
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
              </ChartFloatingTooltip>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
