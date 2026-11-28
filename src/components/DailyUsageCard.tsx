/**
 * Input: UsageTimeBucket 每日趋势序列、CallNodePoint 调用节点序列、@/lib/format 工具、SvgChartPrimitives 共享绘图原语、ModelCallChart 与 @/components/ui 组件。
 * Output: 导出 DailyUsageCard 趋势主图组件（支持「按日」主次双轴量价折线与「今日」单次调用增量折线一键切换）。
 * Pos: 看板中部核心双图之一（图 1），将按日双轴分模型 Token/费用折线与今日单次节点调用增量折线合二为一（src/components/DailyUsageCard.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, useEffect, useMemo, useState } from "react";
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
  SvgAreaGradients,
  SvgGridAxes,
  useContainerWidth,
  usePersistedSet,
} from "@/components/SvgChartPrimitives";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export { extractTodayCallSummary, resolveDayMeta, toLocalDayKey };

type TrendGranularityMode = "7d" | "today";

interface DayFamilyPoint {
  familyKey: string;
  label: string;
  color: string;
  callCount: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface DailySeriesDay {
  bucketKey: string;
  label: string;
  weekdayLabel: string;
  isToday: boolean;
  callCount: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byFamily: Map<string, DayFamilyPoint>;
}

interface ModelFamilyMeta {
  familyKey: string;
  label: string;
  color: string;
  periodTokens: number;
  periodCostUsd: number;
}

export interface DailyUsageCardProps {
  dailyTrend: UsageTimeBucket[];
  callTimeline: CallNodePoint[];
  byModel: ModelUsageBreakdown[];
  windowKey: NodeWindowKey;
  onWindowKeyChange: (key: NodeWindowKey) => void;
  hoveredSeq: number | null;
  onHoverSeq: (seq: number | null) => void;
  onSelectConversationId: (conversationId: string) => void;
}

const CHART_HEIGHT = 152;
const PAD_LEFT = 48;
const PAD_RIGHT = 50;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;

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
  const [granularity, setGranularity] = useState<TrendGranularityMode>(() =>
    readStoredJson<string>("agy_chart_daily_granularity_v1", "7d") === "today" ? "today" : "7d"
  );
  useEffect(() => {
    writeStoredJson("agy_chart_daily_granularity_v1", granularity);
  }, [granularity]);

  const [hiddenFamilies, toggleFamily] = usePersistedSet("agy_chart_hidden_daily_usage_v1");
  const savedMetrics = readStoredJson<{ showTokens: boolean; showCost: boolean }>(
    "agy_chart_daily_metrics_v1",
    { showTokens: true, showCost: true }
  );
  const [showTokens, setShowTokens] = useState<boolean>(savedMetrics.showTokens);
  const [showCost, setShowCost] = useState<boolean>(savedMetrics.showCost);
  useEffect(() => {
    writeStoredJson("agy_chart_daily_metrics_v1", { showTokens, showCost });
  }, [showTokens, showCost]);

  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const { wrapRef, svgWidth } = useContainerWidth(granularity === "7d", 640);

  const { todayNodes, todayByModel, todayTotalCalls } = useMemo(
    () =>
      granularity === "today"
        ? extractTodayCallSummary(callTimeline, byModel, dailyTrend)
        : { todayNodes: [], todayByModel: [], todayTotalCalls: 0 },
    [granularity, callTimeline, byModel, dailyTrend]
  );

  const { days, families, avgTokens, avgCost } = useMemo(() => {
    const todayKey = toLocalDayKey(new Date());
    const familyMap = new Map<string, ModelFamilyMeta>();
    let sumTokens = 0;
    let sumCost = 0;

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
    };
  }, [dailyTrend]);

  const granularityTabs = (
    <Tabs
      value={granularity}
      onValueChange={(v) => setGranularity(v as TrendGranularityMode)}
      aria-label="趋势时间范围切换"
    >
      <TabsList className="h-6 p-0.5">
        <TabsTrigger value="7d" className="px-2 text-[11px]">按日</TabsTrigger>
        <TabsTrigger value="today" className="px-2 text-[11px]">今日</TabsTrigger>
      </TabsList>
    </Tabs>
  );

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
  const toX = (i: number) =>
    days.length <= 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (i / (days.length - 1)) * plotW;
  const toYToken = (v: number) =>
    PAD_TOP + plotH - Math.min(1, Math.max(0, (v - tokenBounds.minY) / tokenSpan)) * plotH;
  const toYCost = (v: number) =>
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
    return {
      fam,
      tokenPts,
      costPts,
      tokenLine: buildLinePath(tokenPts),
      costLine: buildLinePath(costPts),
      tokenArea: buildAreaPath(tokenPts, PAD_TOP + plotH),
    };
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
            <CalendarDays className="size-3.5 shrink-0 text-indigo-500" />
            <CardTitle className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              每日消耗
            </CardTitle>
            <Badge variant="secondary" className="h-4 px-1.5 text-[11px] tabular-nums">
              {days.length} 活跃日 · 均 {formatTokens(avgTokens)} · {formatUsd(avgCost)}
            </Badge>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-0.5 text-[11px]">
              {families.map((fam) => (
                <ChartLegendToggle
                  key={fam.familyKey}
                  label={fam.label}
                  color={fam.color}
                  meta={formatUsd(fam.periodCostUsd)}
                  visible={!hiddenFamilies.has(fam.familyKey)}
                  onToggle={() => toggleFamily(fam.familyKey)}
                />
              ))}
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
          <ChartEmptyBox message="当前周期暂无按日消耗记录" />
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
              <SvgAreaGradients
                items={families.map((fam) => ({
                  id: `daily-dual-${fam.familyKey.replace(/[^a-z0-9]/gi, "-")}`,
                  color: fam.color,
                  topOpacity: 0.18,
                }))}
              />

              <SvgGridAxes
                padLeft={PAD_LEFT}
                padRight={PAD_RIGHT}
                padTop={PAD_TOP}
                plotH={plotH}
                svgWidth={svgWidth}
                leftLabelClassName="fill-indigo-600/80 font-mono text-[10px] dark:fill-indigo-400/80"
                formatLeftLabel={
                  showTokens
                    ? (ratio) => {
                        const v = tokenBounds.minY + tokenSpan * ratio;
                        return v <= 0 ? "0" : formatTokens(v);
                      }
                    : undefined
                }
                formatRightLabel={
                  showCost
                    ? (ratio) => {
                        const v = costBounds.minY + costSpan * ratio;
                        return v <= 0 ? "$0" : formatUsd(v);
                      }
                    : undefined
                }
              />

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

              {showTokens &&
                seriesList.map(({ fam, tokenArea, tokenLine }) => {
                  const gradId = `daily-dual-${fam.familyKey.replace(/[^a-z0-9]/gi, "-")}`;
                  return (
                    <g key={`tok-${fam.familyKey}`}>
                      {tokenArea && <path d={tokenArea} fill={`url(#${gradId})`} />}
                      {tokenLine && (
                        <path
                          d={tokenLine}
                          fill="none"
                          stroke={fam.color}
                          strokeWidth={2.1}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}
                    </g>
                  );
                })}

              {showCost &&
                seriesList.map(({ fam, costLine }) =>
                  costLine ? (
                    <path
                      key={`cost-${fam.familyKey}`}
                      d={costLine}
                      fill="none"
                      stroke={fam.color}
                      strokeWidth={1.8}
                      strokeDasharray="5 3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.9}
                    />
                  ) : null
                )}

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

            {hoveredDay && (
              <ChartFloatingTooltip x={activeX} svgWidth={svgWidth} width={244} flipRatio={0.55}>
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
              </ChartFloatingTooltip>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
