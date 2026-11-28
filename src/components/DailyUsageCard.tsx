/**
 * Input: UsageTimeBucket 每日趋势序列、CallNodePoint 调用节点序列、ModelCallChart 单次节点折线组件与 @/components/ui 组件。
 * Output: 导出 DailyUsageCard 趋势主图组件（「按日」对标 OpenRouter / Anthropic Console 堆叠圆角柱状图并支持 Token/费用一键切换，「今日」复用单次调用节点折线图）。
 * Pos: 看板中部核心双图之一（图 1），呈现按日分模型堆叠消耗柱状图与今日单次节点调用增量折线（src/components/DailyUsageCard.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CallNodePoint,
  ModelUsageBreakdown,
  UsageTimeBucket,
} from "@/types/telemetry";
import {
  formatExactNumber,
  formatTokens,
  formatUsd,
  readStoredJson,
  writeStoredJson,
} from "@/lib/format";
import {
  ensureDistinctColors,
  ModelCallChart,
  resolveModelStyle,
  type NodeWindowKey,
} from "@/components/ModelCallChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** 图表时间粒度模式：按日堆叠柱状图 vs 今日单次调用节点折线 */
type TrendGranularityMode = "7d" | "today";

/** 按日堆叠柱状图度量维度：Token 或等效美元费用 */
type DailyMetricMode = "tokens" | "cost";

/** 单日内按模型家族归并后的数值项 */
interface DayFamilyPoint {
  familyKey: string; // 模型家族唯一键
  label: string; // 模型短名称
  color: string; // 专属无冲突颜色 HEX
  callCount: number; // 当日调用轮数
  totalTokens: number; // 当日总 Token
  estimatedCostUsd: number; // 当日等效美元成本
}

/** 标准化后的单日时间序列点 */
interface DailySeriesDay {
  bucketKey: string; // YYYY-MM-DD
  label: string; // MM-DD
  weekdayLabel: string; // 周几或“今日·周几”
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
  color: string; // 唯一颜色 HEX
  periodTokens: number; // 周期累计 Token
  periodCostUsd: number; // 周期累计美元成本
}

/** DailyUsageCard 组件入参 */
export interface DailyUsageCardProps {
  dailyTrend: UsageTimeBucket[]; // 按日期升序排列的日趋势桶数组
  callTimeline: CallNodePoint[]; // 按时间升序排列的单次调用节点数组
  byModel: ModelUsageBreakdown[]; // 当前周期按模型汇总列表
  windowKey: NodeWindowKey; // 单次节点窗口档位（与右侧曲线联动）
  onWindowKeyChange: (key: NodeWindowKey) => void; // 窗口切换回调
  hoveredSeq: number | null; // 跨图同步悬停节点序号
  onHoverSeq: (seq: number | null) => void; // 悬停节点变更回调
  onSelectConversationId: (conversationId: string) => void; // 点击单次节点打开会话详情
}

const CHART_HEIGHT = 196; // 与右侧缓存命中率卡片保持统一高度（像素）
const PAD_LEFT = 50; // 左侧纵轴刻度留白
const PAD_RIGHT = 14; // 右侧留白
const PAD_TOP = 24; // 顶部柱顶数字标签留白
const PAD_BOTTOM = 24; // 底部日期横轴留白
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 职责：构造仅顶部带圆角、底部齐平坐标轴的柱体 SVG 路径（用于堆叠柱体统一圆角裁剪）。
 * 参数：x, y, w, h, r — 矩形左上角坐标、宽高与顶部圆角半径。
 * 返回值：SVG path d 字符串。
 */
function buildTopRoundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): string {
  const safeH = Math.max(0, h);
  const cr = Math.min(r, w / 2, safeH);
  const bottom = y + safeH;
  return [
    `M ${x.toFixed(1)},${(y + cr).toFixed(1)}`,
    `Q ${x.toFixed(1)},${y.toFixed(1)} ${(x + cr).toFixed(1)},${y.toFixed(1)}`,
    `L ${(x + w - cr).toFixed(1)},${y.toFixed(1)}`,
    `Q ${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + cr).toFixed(1)}`,
    `L ${(x + w).toFixed(1)},${bottom.toFixed(1)}`,
    `L ${x.toFixed(1)},${bottom.toFixed(1)}`,
    "Z",
  ].join(" ");
}

/**
 * 职责：将 Date 实例格式化为本地时区 YYYY-MM-DD 字符串。
 * 参数：d — Date 实例。
 * 返回值：YYYY-MM-DD 日期键。
 */
export function toLocalDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 职责：根据 YYYY-MM-DD 日期键解析本地星期标签与是否今日标记。
 * 参数：bucketKey — YYYY-MM-DD 格式日期字符串；todayKey — 今日 YYYY-MM-DD 键。
 * 返回值：包含 weekdayLabel 与 isToday 的对象。
 */
export function resolveDayMeta(
  bucketKey: string,
  todayKey: string
): { weekdayLabel: string; isToday: boolean } {
  const isToday = bucketKey === todayKey;
  const parts = bucketKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return { weekdayLabel: isToday ? "今日" : "", isToday };
  }
  const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
  const weekday = WEEKDAY_NAMES[dateObj.getDay()] ?? "";
  return {
    weekdayLabel: isToday ? `今日·${weekday}` : weekday,
    isToday,
  };
}

/**
 * 职责：筛选自然今日的调用节点并按模型汇总，供「今日」模式折线图复用（当 callTimeline 因 nodeLimit 仅含尾部节点时，自动用 dailyTrend 今日桶补齐真实全天轮数与分模型累计值）。
 * 参数：callTimeline — 调用节点序列；byModel — 周期内分模型汇总；dailyTrend — 可选按日趋势桶。
 * 返回值：包含 todayNodes、todayByModel 与 todayTotalCalls 的对象。
 */
export function extractTodayCallSummary(
  callTimeline: CallNodePoint[],
  byModel: ModelUsageBreakdown[],
  dailyTrend?: UsageTimeBucket[]
): { todayNodes: CallNodePoint[]; todayByModel: ModelUsageBreakdown[]; todayTotalCalls: number } {
  const todayKey = toLocalDayKey(new Date());
  const matchedNodes = callTimeline.filter((n) => {
    const parsed = new Date(n.timestamp);
    return !Number.isNaN(parsed.getTime()) && toLocalDayKey(parsed) === todayKey;
  });
  const todayBucket = dailyTrend?.find((b) => b.bucketKey === todayKey);
  const todayTotalCalls = Math.max(matchedNodes.length, todayBucket?.callCount ?? 0);
  const toBreakdown = (
    modelName: string,
    s: {
      modelId?: string;
      callCount?: number;
      inputTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedCostUsd?: number;
    }
  ): ModelUsageBreakdown => {
    const ref = byModel.find((item) => item.modelName === modelName);
    const promptSum = s.inputTokens + s.cacheReadTokens;
    return {
      modelName,
      modelId: s.modelId || ref?.modelId || modelName,
      conversationCount: 0,
      callCount: s.callCount ?? 0,
      inputTokens: s.inputTokens,
      cacheReadTokens: s.cacheReadTokens,
      outputTokens: s.outputTokens,
      thinkingTokens: 0,
      responseTokens: 0,
      totalTokens: s.totalTokens,
      cacheHitRate: promptSum > 0 ? s.cacheReadTokens / promptSum : 0,
      avgLatencyMs: 0,
      avgOutputTps: ref?.avgOutputTps ?? 0,
      avgStreamingTps: ref?.avgStreamingTps ?? 0,
      estimatedCostUsd: s.estimatedCostUsd ?? 0,
      cacheSavedUsd: 0,
      shareOfTotalTokens: 0,
    };
  };

  if (todayBucket?.models && todayBucket.models.length > 0 && todayBucket.callCount > matchedNodes.length) {
    return {
      todayNodes: matchedNodes,
      todayByModel: todayBucket.models.map((m) => toBreakdown(m.modelName, m)),
      todayTotalCalls,
    };
  }

  const modelStatsMap = new Map<
    string,
    { inputTokens: number; cacheReadTokens: number; outputTokens: number; totalTokens: number }
  >();
  for (const n of matchedNodes) {
    const cur = modelStatsMap.get(n.modelName) ?? {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    cur.inputTokens += n.inputTokens;
    cur.cacheReadTokens += n.cacheReadTokens;
    cur.outputTokens += n.outputTokens;
    cur.totalTokens += n.totalTokens;
    modelStatsMap.set(n.modelName, cur);
  }
  return {
    todayNodes: matchedNodes,
    todayByModel: [...modelStatsMap.entries()].map(([name, stats]) => toBreakdown(name, stats)),
    todayTotalCalls,
  };
}

/**
 * 职责：渲染合并后的趋势主图卡片——「按日」模式采用 OpenRouter / Anthropic Console 风格的堆叠圆角柱状图并支持 Token/费用一键切换，「今日」模式呈现当日单次调用节点增量曲线。
 * 思路：1) 用清晰的堆叠圆角柱状图替代容易互相遮挡的实线+虚线双轴面条图，柱顶直出当日总计值，3~14 天均有极佳阅读节奏；
 *      2) 顶栏提供紧凑的「Token | 费用」与「按日 | 今日」双分段切换，配合扁平内联模型图例（无冲突配色，点击可显隐模型）；
 *      3) 悬停柱列点亮柔和底轨并聚焦该日，浮窗同步展示 Token 与等效美元拆解。
 * 参数：props — dailyTrend、callTimeline、byModel 及跨图联动状态。
 * 返回值：与右侧缓存命中率卡片等高对齐的趋势图表卡片。
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
  const clipPrefix = useId().replace(/:/g, "");
  const [granularity, setGranularity] = useState<TrendGranularityMode>(() =>
    readStoredJson<string>("agy_chart_daily_granularity_v1", "7d") === "today" ? "today" : "7d"
  );
  const [metric, setMetric] = useState<DailyMetricMode>(() =>
    readStoredJson<string>("agy_chart_daily_metric_v2", "tokens") === "cost" ? "cost" : "tokens"
  );
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<string>>(
    () => new Set(readStoredJson<string[]>("agy_chart_hidden_daily_usage_v1", []))
  );
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [svgWidth, setSvgWidth] = useState<number>(640);

  useEffect(() => {
    writeStoredJson("agy_chart_daily_granularity_v1", granularity);
  }, [granularity]);

  useEffect(() => {
    writeStoredJson("agy_chart_daily_metric_v2", metric);
  }, [metric]);

  useEffect(() => {
    writeStoredJson("agy_chart_hidden_daily_usage_v1", [...hiddenFamilies]);
  }, [hiddenFamilies]);

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

  // 1.1. 「今日」模式筛选自然今日节点
  const { todayNodes, todayByModel, todayTotalCalls } = useMemo(
    () =>
      granularity === "today"
        ? extractTodayCallSummary(callTimeline, byModel, dailyTrend)
        : { todayNodes: [], todayByModel: [], todayTotalCalls: 0 },
    [granularity, callTimeline, byModel, dailyTrend]
  );

  // 1.2. 整理「按日」分模型数据并分配无冲突色值
  const { days, families, avgTokens, avgCost } = useMemo(() => {
    const todayKey = toLocalDayKey(new Date());
    const familyMap = new Map<string, ModelFamilyMeta>();
    let sumTokens = 0;
    let sumCost = 0;

    const rawDays: DailySeriesDay[] = dailyTrend
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

    const sortedFamilies = ensureDistinctColors(
      [...familyMap.values()].sort(
        (a, b) => b.periodCostUsd - a.periodCostUsd || b.periodTokens - a.periodTokens
      )
    );
    const colorByKey = new Map(sortedFamilies.map((f) => [f.familyKey, f.color]));
    for (const d of rawDays) {
      for (const fp of d.byFamily.values()) {
        const resolved = colorByKey.get(fp.familyKey);
        if (resolved) fp.color = resolved;
      }
    }

    const activeCount = Math.max(1, rawDays.length);
    return {
      days: rawDays,
      families: sortedFamilies,
      avgTokens: sumTokens / activeCount,
      avgCost: sumCost / activeCount,
    };
  }, [dailyTrend]);

  // 1.3. 粒度切换器
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

  // 2.1. 「今日」模式：单次节点调用增量折线图
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

  // 2.2. 「按日」模式：OpenRouter / Anthropic 风格堆叠圆角柱状图
  const visibleFamilies = families.filter((fam) => !hiddenFamilies.has(fam.familyKey));
  const isCost = metric === "cost";
  const formatVal = (v: number) => (isCost ? formatUsd(v) : formatTokens(v));

  const dayColumns = days.map((d) => {
    const segments: Array<{
      familyKey: string;
      label: string;
      color: string;
      val: number;
    }> = [];
    let visibleTotal = 0;
    for (const fam of visibleFamilies) {
      const fp = d.byFamily.get(fam.familyKey);
      const val = fp ? (isCost ? fp.estimatedCostUsd : fp.totalTokens) : 0;
      if (val > 0) {
        segments.push({ familyKey: fam.familyKey, label: fam.label, color: fam.color, val });
        visibleTotal += val;
      }
    }
    return { day: d, segments, visibleTotal };
  });

  const rawMax = Math.max(0, ...dayColumns.map((c) => c.visibleTotal));
  const niceMax = rawMax > 0 ? rawMax * 1.12 : 1;

  const plotW = Math.max(100, svgWidth - PAD_LEFT - PAD_RIGHT);
  const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const baseLineY = PAD_TOP + plotH;
  const slotW = days.length > 0 ? plotW / days.length : plotW;
  const barW = Math.min(44, Math.max(18, Math.floor(slotW * 0.44)));
  const backdropW = Math.min(slotW - 6, barW + 22);

  const toSlotCenterX = (i: number): number => PAD_LEFT + slotW * (i + 0.5);
  const toBarHeight = (val: number): number => Math.max(0, (val / niceMax) * plotH);

  const hoveredCol =
    hoveredDayIdx !== null && hoveredDayIdx >= 0 && hoveredDayIdx < dayColumns.length
      ? dayColumns[hoveredDayIdx]
      : null;
  const hoveredDay = hoveredCol?.day ?? null;
  const activeX = hoveredDayIdx !== null ? toSlotCenterX(hoveredDayIdx) : 0;

  return (
    <Card className="min-w-0 gap-2.5 py-4">
      <CardHeader className="space-y-2 px-5 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <CardTitle className="text-[13.5px] font-semibold tracking-tight text-[var(--theme-text)]">
              每日消耗趋势
            </CardTitle>
            <span className="truncate font-mono text-[11px] text-[var(--theme-text-muted)] tabular-nums">
              {days.length} 活跃日 · 日均 {formatTokens(avgTokens)} · {formatUsd(avgCost)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Tabs
              value={metric}
              onValueChange={(v) => setMetric(v as DailyMetricMode)}
              aria-label="按日图表指标切换"
            >
              <TabsList className="h-6 p-0.5">
                <TabsTrigger value="tokens" className="px-2 text-[11px]">
                  Token
                </TabsTrigger>
                <TabsTrigger value="cost" className="px-2 text-[11px]">
                  费用
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {granularityTabs}
          </div>
        </div>

        {/* 扁平内联模型图例（对标 OpenRouter / Vercel，零厚重胶囊边框） */}
        {families.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            {families.map((fam) => {
              const isVisible = !hiddenFamilies.has(fam.familyKey);
              return (
                <button
                  key={fam.familyKey}
                  type="button"
                  onClick={() => toggleFamily(fam.familyKey)}
                  aria-pressed={isVisible}
                  title={`点击显示/隐藏 ${fam.label}`}
                  className={`inline-flex cursor-pointer items-center gap-1.5 py-0.5 tabular-nums transition-opacity ${
                    isVisible
                      ? "text-[var(--theme-text-secondary)] hover:text-[var(--theme-text)]"
                      : "text-[var(--theme-text-muted)] line-through opacity-40 hover:opacity-70"
                  }`}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: fam.color }}
                  />
                  <span className="font-medium">{fam.label}</span>
                  <span className="font-mono text-[10px] text-[var(--theme-text-muted)]">
                    {isCost ? formatUsd(fam.periodCostUsd) : formatTokens(fam.periodTokens)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </CardHeader>

      <CardContent className="px-5">
        {days.length === 0 ? (
          <div className="flex h-[196px] items-center justify-center rounded-xl border border-dashed border-[var(--theme-border)] text-xs text-[var(--theme-text-muted)]">
            当前周期暂无按日消耗记录
          </div>
        ) : (
          <div ref={wrapRef} className="relative w-full select-none">
            <svg
              width={svgWidth}
              height={CHART_HEIGHT}
              role="img"
              aria-label="所选周期按日分模型堆叠消耗柱状图"
              className="block w-full overflow-visible"
              onMouseLeave={() => setHoveredDayIdx(null)}
            >
              <defs>
                {dayColumns.map((col, idx) => {
                  const totalH = toBarHeight(col.visibleTotal);
                  const barX = toSlotCenterX(idx) - barW / 2;
                  const topY = baseLineY - totalH;
                  return (
                    <clipPath key={`clip-${col.day.bucketKey}`} id={`${clipPrefix}-bar-${idx}`}>
                      <path d={buildTopRoundedRectPath(barX, topY, barW, totalH, 5)} />
                    </clipPath>
                  );
                })}
              </defs>

              {/* 极简三档水平参考线与左侧单轴刻度 */}
              {[0, 0.5, 1].map((ratio) => {
                const tickVal = niceMax * ratio;
                const y = PAD_TOP + plotH * (1 - ratio);
                return (
                  <g key={ratio}>
                    <line
                      x1={PAD_LEFT}
                      y1={y}
                      x2={svgWidth - PAD_RIGHT}
                      y2={y}
                      strokeDasharray={ratio === 0 ? undefined : "3 3"}
                      stroke="var(--theme-grid-line)"
                    />
                    <text
                      x={PAD_LEFT - 8}
                      y={y + 3.5}
                      textAnchor="end"
                      fill="var(--theme-chart-axis)"
                      className="font-mono text-[10px]"
                    >
                      {ratio === 0 ? (isCost ? "$0" : "0") : formatVal(tickVal)}
                    </text>
                  </g>
                );
              })}

              {/* 堆叠圆角柱列 + 悬停聚焦底轨 + 柱顶数值直出 */}
              {dayColumns.map((col, idx) => {
                const cx = toSlotCenterX(idx);
                const barX = cx - barW / 2;
                const isHovered = hoveredDayIdx === idx;
                const dimmed = hoveredDayIdx !== null && !isHovered;
                const totalH = toBarHeight(col.visibleTotal);
                const topY = baseLineY - totalH;

                let cursorY = baseLineY;
                const rects = col.segments.map((seg, sIdx) => {
                  const rawSegH = toBarHeight(seg.val);
                  const gap = sIdx > 0 && rawSegH > 3 ? 1.5 : 0;
                  const segH = Math.max(1.5, rawSegH - gap);
                  cursorY -= rawSegH;
                  return {
                    ...seg,
                    y: cursorY + (rawSegH - segH),
                    h: segH,
                  };
                });

                return (
                  <g
                    key={col.day.bucketKey}
                    style={{
                      opacity: dimmed ? 0.52 : 1,
                      transition: "opacity 140ms ease",
                    }}
                  >
                    {/* 悬停高亮柔和底轨 */}
                    {isHovered && (
                      <rect
                        x={cx - backdropW / 2}
                        y={PAD_TOP - 4}
                        width={backdropW}
                        height={plotH + 4}
                        rx={8}
                        fill="var(--theme-surface-elevated)"
                        fillOpacity={0.85}
                      />
                    )}

                    {/* 统一圆角裁剪的堆叠模型色段 */}
                    {totalH > 0 && (
                      <g clipPath={`url(#${clipPrefix}-bar-${idx})`}>
                        {rects.map((seg) => (
                          <rect
                            key={`${col.day.bucketKey}-${seg.familyKey}`}
                            x={barX}
                            y={seg.y}
                            width={barW}
                            height={seg.h}
                            fill={seg.color}
                          />
                        ))}
                      </g>
                    )}

                    {/* 柱顶当日合计值标签 */}
                    {col.visibleTotal > 0 && (days.length <= 10 || isHovered) && (
                      <text
                        x={cx}
                        y={Math.max(11, topY - 7)}
                        textAnchor="middle"
                        fill={
                          isHovered || col.day.isToday
                            ? "var(--theme-text)"
                            : "var(--theme-text-muted)"
                        }
                        className={`font-mono text-[10px] tabular-nums ${
                          isHovered || col.day.isToday ? "font-semibold" : "font-medium"
                        }`}
                      >
                        {formatVal(col.visibleTotal)}
                      </text>
                    )}

                    {/* 底部日期刻度 */}
                    <text
                      x={cx}
                      y={CHART_HEIGHT - 5}
                      textAnchor="middle"
                      fill={
                        col.day.isToday || isHovered
                          ? "var(--theme-text)"
                          : "var(--theme-chart-axis)"
                      }
                      className={`font-mono text-[10px] ${
                        col.day.isToday || isHovered ? "font-semibold" : ""
                      }`}
                    >
                      {col.day.isToday ? "今日" : col.day.label}
                    </text>

                    {/* 全列透明交互热区 */}
                    <rect
                      x={PAD_LEFT + idx * slotW}
                      y={0}
                      width={slotW}
                      height={CHART_HEIGHT}
                      fill="transparent"
                      className={col.day.isToday ? "cursor-pointer" : "cursor-crosshair"}
                      onMouseEnter={() => setHoveredDayIdx(idx)}
                      onClick={() => {
                        if (col.day.isToday) setGranularity("today");
                      }}
                    />
                  </g>
                );
              })}
            </svg>

            {/* 悬停精致浮窗 */}
            {hoveredDay && (
              <div
                style={{
                  left:
                    activeX > svgWidth * 0.55
                      ? `${Math.max(8, activeX - 256)}px`
                      : `${Math.min(svgWidth - 256, activeX + 14)}px`,
                  top: "4px",
                }}
                className="theme-popover-surface pointer-events-none absolute z-20 w-[248px] rounded-xl border p-3 text-[11px]"
              >
                <div className="flex items-center justify-between gap-2 border-b border-[var(--theme-border)] pb-1.5">
                  <span className="font-semibold text-[var(--theme-text)] tabular-nums">
                    {hoveredDay.bucketKey} ({hoveredDay.weekdayLabel})
                  </span>
                  <span className="font-mono text-[10px] text-[var(--theme-text-muted)]">
                    {formatExactNumber(hoveredDay.callCount)} 轮
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between font-medium text-[var(--theme-text-secondary)] tabular-nums">
                  <span>当日合计</span>
                  <span className="font-mono">
                    <strong className="text-[var(--theme-text)]">
                      {formatTokens(hoveredDay.totalTokens)}
                    </strong>
                    {" · "}
                    <strong className="text-amber-600 dark:text-amber-400">
                      {formatUsd(hoveredDay.estimatedCostUsd)}
                    </strong>
                  </span>
                </div>
                <div className="mt-1.5 space-y-1 border-t border-[var(--theme-border)] pt-1.5 tabular-nums">
                  {families.map((fam) => {
                    const fp = hoveredDay.byFamily.get(fam.familyKey);
                    if (!fp || (fp.totalTokens <= 0 && fp.estimatedCostUsd <= 0)) return null;
                    return (
                      <div
                        key={fam.familyKey}
                        className="flex items-center justify-between gap-2 text-[10.5px]"
                      >
                        <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-[var(--theme-text-secondary)]">
                          <span
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: fam.color }}
                          />
                          <span className="truncate">{fam.label}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[var(--theme-text-muted)]">
                          {formatTokens(fp.totalTokens)} ·{" "}
                          <strong className="font-medium text-amber-600 dark:text-amber-400">
                            {formatUsd(fp.estimatedCostUsd)}
                          </strong>
                        </span>
                      </div>
                    );
                  })}
                </div>
                {hoveredDay.isToday && (
                  <div className="mt-1.5 border-t border-[var(--theme-border)] pt-1 text-[10px] text-[var(--theme-text-muted)]">
                    点击柱体切入今日单次调用节点
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
