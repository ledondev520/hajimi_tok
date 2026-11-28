/**
 * Input: React 钩子、CallNodePoint 类型、@/lib/format 工具、SvgChartPrimitives 共享绘图原语、@/components/ui 组件与 lucide-react 图标。
 * Output: 导出 ModelCallChart 模型调用节点折线图组件与 resolveModelStyle 模型图例样式解析器。
 * Pos: 看板中部紧凑趋势可视化层，将每次增量读取的模型推理调用渲染为可交互 Token、缓存率或 TPS 折线节点（src/components/ModelCallChart.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, type ReactNode, useMemo, useState } from "react";
import { Gauge, Percent, TrendingUp } from "lucide-react";
import type { CallNodePoint, ModelUsageBreakdown } from "@/types/telemetry";
import {
  calcCacheHitRate,
  computeAdaptiveLinearBounds,
  computeAdaptivePercentBounds,
  formatDateTime,
  formatDurationMs,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@/lib/format";
import { resolveModelStyle, type ModelSeriesStyle } from "@/lib/models";
import {
  buildAreaPath,
  buildLinePath,
  CHART_CARD_CLASS,
  ChartEmptyBox,
  ChartFloatingTooltip,
  ChartLegendToggle,
  computeUniformTickIndices,
  formatPercentTick,
  resolveHoverIndexFromMouse,
  SvgAreaGradients,
  SvgCrosshair,
  SvgGridAxes,
  useContainerWidth,
  usePersistedSet,
} from "@/components/SvgChartPrimitives";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export { resolveModelStyle };
export type NodeWindowKey = "60" | "150" | "all";

export interface ModelCallChartProps {
  nodes: CallNodePoint[];
  byModel: ModelUsageBreakdown[];
  totalCallCount: number;
  onSelectConversationId: (conversationId: string) => void;
  variant?: "tokens" | "tps" | "cacheRate";
  windowKey?: NodeWindowKey;
  onWindowKeyChange?: (key: NodeWindowKey) => void;
  hoveredSeq?: number | null;
  onHoverSeq?: (seq: number | null) => void;
  titleOverride?: string;
  leadingTabsSlot?: ReactNode;
  emptyMessage?: string;
}

const CHART_HEIGHT = 152;
const PAD_LEFT = 48;
const PAD_RIGHT = 14;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;

export const ModelCallChart = memo(function ModelCallChart({
  nodes,
  byModel,
  totalCallCount,
  onSelectConversationId,
  variant = "tokens",
  windowKey: controlledWindow,
  onWindowKeyChange,
  hoveredSeq,
  onHoverSeq,
  titleOverride,
  leadingTabsSlot,
  emptyMessage,
}: ModelCallChartProps) {
  const isTps = variant === "tps";
  const isCacheRate = variant === "cacheRate";
  const [innerWindowKey, setInnerWindowKey] = useState<NodeWindowKey>("60");
  const windowKey = controlledWindow ?? innerWindowKey;
  const setWindowKey = (k: NodeWindowKey) => {
    setInnerWindowKey(k);
    onWindowKeyChange?.(k);
  };

  const [hiddenFamilies, toggleFamily] = usePersistedSet(`agy_chart_hidden_nodes_${variant}_v1`);
  const [innerHoveredIdx, setInnerHoveredIdx] = useState<number | null>(null);
  const { wrapRef, svgWidth } = useContainerWidth(true, 960);

  const visibleNodes = useMemo(() => {
    if (windowKey === "all") return nodes;
    return nodes.slice(-(windowKey === "60" ? 60 : 150));
  }, [nodes, windowKey]);

  const chartData = useMemo(() => {
    const styleMap = new Map<string, ModelSeriesStyle>();
    let fallbackCounter = 0;

    for (const m of byModel) {
      const probe = resolveModelStyle(m.modelName, fallbackCounter);
      const existing = styleMap.get(probe.familyKey);
      if (existing) {
        const nextTokens = existing.poolTokens + m.totalTokens;
        existing.avgTps =
          nextTokens > 0
            ? (existing.avgTps * existing.poolTokens + m.avgOutputTps * m.totalTokens) / nextTokens
            : m.avgOutputTps;
        existing.avgCacheHitRate =
          nextTokens > 0
            ? ((existing.avgCacheHitRate ?? 0) * existing.poolTokens + m.cacheHitRate * m.totalTokens) /
              nextTokens
            : m.cacheHitRate;
        existing.poolTokens = nextTokens;
      } else {
        styleMap.set(probe.familyKey, {
          ...probe,
          poolTokens: m.totalTokens,
          avgTps: m.avgOutputTps,
          avgCacheHitRate: m.cacheHitRate,
        });
        fallbackCounter += 1;
      }
    }

    for (const n of visibleNodes) {
      const probe = resolveModelStyle(n.modelName, fallbackCounter);
      if (!styleMap.has(probe.familyKey)) {
        styleMap.set(probe.familyKey, probe);
        fallbackCounter += 1;
      }
    }

    const activeNodes = visibleNodes.filter(
      (n) =>
        !hiddenFamilies.has(resolveModelStyle(n.modelName, 0).familyKey) &&
        (!isCacheRate || n.inputTokens + n.cacheReadTokens > 0)
    );

    const valueOf = (n: CallNodePoint) =>
      isCacheRate
        ? calcCacheHitRate(n.inputTokens, n.cacheReadTokens) * 100
        : isTps
          ? n.outputTps
          : n.totalTokens;

    type CacheNodeKind = "normal" | "cold-start" | "compacted" | "miss";
    const cacheKindList: CacheNodeKind[] = [];
    let realMissCount = 0;
    if (isCacheRate) {
      const prevPromptByConv = new Map<string, number>();
      for (const n of activeNodes) {
        const prompt = n.inputTokens + n.cacheReadTokens;
        const rate = calcCacheHitRate(n.inputTokens, n.cacheReadTokens);
        const prevPrompt = prevPromptByConv.get(n.conversationId);
        let kind: CacheNodeKind = "normal";
        if (n.callIndex === 0 && rate < 0.5) kind = "cold-start";
        else if (prevPrompt !== undefined && prevPrompt >= 10_000 && prompt < prevPrompt * 0.6 && rate < 0.5) kind = "compacted";
        else if (rate < 0.3 && prompt >= 10_000) { kind = "miss"; realMissCount += 1; }
        cacheKindList.push(kind);
        if (n.callIndex > 0 || !prevPromptByConv.has(n.conversationId)) prevPromptByConv.set(n.conversationId, prompt);
      }
    }

    const boundSource = isCacheRate ? activeNodes.filter((_, i) => cacheKindList[i] !== "cold-start") : activeNodes;
    const { minY, maxY } = isCacheRate
      ? computeAdaptivePercentBounds((boundSource.length > 0 ? boundSource : activeNodes).map(valueOf))
      : computeAdaptiveLinearBounds(activeNodes.map(valueOf), isTps ? 100 : 1000);
    const ySpan = Math.max(1, maxY - minY);
    const plotW = Math.max(80, svgWidth - PAD_LEFT - PAD_RIGHT);
    const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

    const plotted = activeNodes.map((node, idx) => {
      const style = styleMap.get(resolveModelStyle(node.modelName, 0).familyKey) ?? resolveModelStyle(node.modelName, 0);
      const cacheKind: CacheNodeKind = isCacheRate ? (cacheKindList[idx] ?? "normal") : "normal";
      const x = activeNodes.length === 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (idx / (activeNodes.length - 1)) * plotW;
      const val = valueOf(node);
      const y = cacheKind === "cold-start" ? PAD_TOP + plotH : PAD_TOP + plotH - Math.min(1, Math.max(0, (val - minY) / ySpan)) * plotH;
      return { node, style, x, y, val, cacheKind };
    });

    const linePlotted = isCacheRate ? plotted.filter((p) => p.cacheKind !== "cold-start") : plotted;
    const seriesPaths = [...styleMap.values()]
      .filter((style) => !hiddenFamilies.has(style.familyKey))
      .map((style) => {
        const pts = linePlotted.filter((p) => p.style.familyKey === style.familyKey);
        return {
          style,
          pts,
          lineD: buildLinePath(pts),
          areaD: buildAreaPath(pts, PAD_TOP + plotH),
        };
      });

    const backboneD = styleMap.size > 1 ? buildLinePath(linePlotted) : "";
    const tickIndices = computeUniformTickIndices(plotted.length, plotW < 360 ? 2 : 4);

    return {
      legend: [...styleMap.values()],
      plotted,
      seriesPaths,
      backboneD,
      minY,
      maxY,
      plotW,
      plotH,
      tickIndices,
      realMissCount,
    };
  }, [visibleNodes, byModel, isTps, isCacheRate, hiddenFamilies, svgWidth]);

  const hoveredIdx = useMemo(() => {
    if (hoveredSeq !== undefined) {
      if (hoveredSeq === null) return null;
      const found = chartData.plotted.findIndex((p) => p.node.seq === hoveredSeq);
      return found >= 0 ? found : null;
    }
    return innerHoveredIdx;
  }, [hoveredSeq, innerHoveredIdx, chartData.plotted]);

  const updateHoverIdx = (idx: number | null) => {
    setInnerHoveredIdx(idx);
    if (onHoverSeq) {
      onHoverSeq(idx !== null && chartData.plotted[idx] ? chartData.plotted[idx].node.seq : null);
    }
  };

  const activePoint =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < chartData.plotted.length
      ? chartData.plotted[hoveredIdx]
      : null;

  const dotRadius =
    visibleNodes.length <= 75 ? 3.3 : visibleNodes.length <= 160 ? 2.4 : 1.7;

  return (
    <Card className={CHART_CARD_CLASS}>
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {isCacheRate ? (
              <Percent className="size-3.5 text-emerald-500" />
            ) : isTps ? (
              <Gauge className="size-3.5 text-violet-500" />
            ) : (
              <TrendingUp className="size-3.5 text-indigo-500" />
            )}
            <CardTitle className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {titleOverride ??
                (isCacheRate ? "单次缓存率" : isTps ? "生成速率 TPS" : "单次消耗")}
            </CardTitle>
            <Badge variant="secondary" className="h-4 px-1.5 text-[11px] tabular-nums">
              {visibleNodes.length === totalCallCount
                ? `${totalCallCount} 次`
                : `${visibleNodes.length} / ${totalCallCount}`}
            </Badge>
            {isCacheRate && chartData.realMissCount > 0 && (
              <Badge
                variant="outline"
                title="老会话非首轮且非压缩的真实缓存失效次数"
                className="h-4 border-rose-500/40 bg-rose-500/10 px-1.5 text-[10px] text-rose-600 tabular-nums dark:text-rose-300"
              >
                掉 {chartData.realMissCount} 次
              </Badge>
            )}

            <div className="flex flex-wrap items-center gap-1.5 pl-1">
              {chartData.legend.map((s) => {
                const meta = isCacheRate
                  ? s.avgCacheHitRate !== undefined
                    ? `均 ${formatPercent(s.avgCacheHitRate)}`
                    : null
                  : isTps
                    ? s.avgTps > 0
                      ? `均 ${s.avgTps.toFixed(1)}/s`
                      : null
                    : s.poolTokens > 0
                      ? formatTokens(s.poolTokens)
                      : null;
                return (
                  <ChartLegendToggle
                    key={s.familyKey}
                    label={s.shortLabel}
                    color={s.color}
                    meta={meta}
                    visible={!hiddenFamilies.has(s.familyKey)}
                    onToggle={() => toggleFamily(s.familyKey)}
                  />
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {leadingTabsSlot}
            <Tabs
              value={windowKey}
              onValueChange={(v) => setWindowKey(v as NodeWindowKey)}
              aria-label="调用节点数量范围"
            >
              <TabsList className="h-6 p-0.5">
                <TabsTrigger value="60" className="px-2 text-[11px]">60</TabsTrigger>
                <TabsTrigger value="150" className="px-2 text-[11px]">150</TabsTrigger>
                <TabsTrigger value="all" className="px-2 text-[11px]">全部</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4">
        {chartData.plotted.length === 0 ? (
          <ChartEmptyBox message={emptyMessage ?? "暂无数据"} />
        ) : (
          <div
            ref={wrapRef}
            className="relative w-full select-none"
            onMouseMove={(e) =>
              updateHoverIdx(
                resolveHoverIndexFromMouse(e, PAD_LEFT, chartData.plotW, chartData.plotted.length)
              )
            }
            onMouseLeave={() => updateHoverIdx(null)}
            onClick={() => {
              if (activePoint) onSelectConversationId(activePoint.node.conversationId);
            }}
          >
            <svg
              width={svgWidth}
              height={CHART_HEIGHT}
              role="img"
              aria-label={
                isCacheRate
                  ? "单次调用节点缓存率折线图"
                  : isTps
                    ? "单次调用节点 TPS 折线图"
                    : "模型调用节点 Token 折线图"
              }
              className="block w-full max-w-full cursor-crosshair overflow-visible"
            >
              <SvgAreaGradients
                items={chartData.seriesPaths.map(({ style }) => ({
                  id: `grad-${variant}-${style.familyKey.replace(/[^a-z0-9]/g, "-")}`,
                  color: style.color,
                  topOpacity: 0.2,
                }))}
              />

              <SvgGridAxes
                padLeft={PAD_LEFT}
                padRight={PAD_RIGHT}
                padTop={PAD_TOP}
                plotH={chartData.plotH}
                svgWidth={svgWidth}
                formatLeftLabel={(ratio) => {
                  const val = chartData.minY + (chartData.maxY - chartData.minY) * ratio;
                  if (isCacheRate) return formatPercentTick(val);
                  if (val <= 0) return "0";
                  return isTps ? `${Math.round(val)}/s` : formatTokens(Math.round(val));
                }}
              />

              {chartData.tickIndices.map((idx, pos) => {
                const pt = chartData.plotted[idx];
                if (!pt) return null;
                const anchor =
                  chartData.tickIndices.length === 1
                    ? "middle"
                    : pos === 0
                      ? "start"
                      : pos === chartData.tickIndices.length - 1
                        ? "end"
                        : "middle";
                return (
                  <text
                    key={pt.node.seq}
                    x={pt.x}
                    y={CHART_HEIGHT - 4}
                    textAnchor={anchor}
                    className="fill-slate-400 font-mono text-[10px] dark:fill-slate-500"
                  >
                    {formatDateTime(pt.node.timestamp).slice(0, 11)}
                  </text>
                );
              })}

              {chartData.backboneD && (
                <path
                  d={chartData.backboneD}
                  fill="none"
                  strokeDasharray="2 3"
                  strokeWidth={1}
                  className="stroke-slate-300/70 dark:stroke-slate-700/70"
                />
              )}

              {chartData.seriesPaths.map(({ style, lineD, areaD }) => {
                const gradId = `grad-${variant}-${style.familyKey.replace(/[^a-z0-9]/g, "-")}`;
                return (
                  <g key={style.familyKey}>
                    {areaD && <path d={areaD} fill={`url(#${gradId})`} />}
                    {lineD && (
                      <path
                        d={lineD}
                        fill="none"
                        stroke={style.color}
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </g>
                );
              })}

              {activePoint && <SvgCrosshair x={activePoint.x} padTop={PAD_TOP} plotH={chartData.plotH} />}

              {chartData.plotted.map((pt, idx) => {
                const isLatest = idx === chartData.plotted.length - 1;
                const isHovered = hoveredIdx === idx;
                const isCold = pt.cacheKind === "cold-start";
                const isCompacted = pt.cacheKind === "compacted";
                const isMiss = pt.cacheKind === "miss";
                const fillColor = isMiss ? "#f43f5e" : isCompacted ? "#8b5cf6" : pt.style.color;
                return (
                  <g key={pt.node.seq}>
                    {(isLatest || isHovered || isMiss) && (
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 6.5 : 5.5}
                        fill={isCold ? "#94a3b8" : fillColor}
                        fillOpacity={isHovered ? 0.25 : 0.18}
                      />
                    )}
                    {isCold ? (
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 4 : Math.max(dotRadius, 2.6)}
                        stroke="#94a3b8"
                        strokeWidth={1.4}
                        className="fill-white dark:fill-slate-950"
                      />
                    ) : (
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 4.2 : isMiss ? Math.max(dotRadius, 3.2) : dotRadius}
                        fill={fillColor}
                        className="stroke-white stroke-[1.2] dark:stroke-slate-950"
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            {activePoint && (
              <ChartFloatingTooltip x={activePoint.x} svgWidth={svgWidth} width={246} flipRatio={0.6}>
                <div className="flex items-center justify-between gap-1 font-mono text-[10px] whitespace-nowrap text-slate-400">
                  <span>
                    {formatDateTime(activePoint.node.timestamp)} · #{activePoint.node.seq}
                  </span>
                  <span
                    style={{ color: activePoint.style.color }}
                    className="truncate font-sans font-semibold"
                  >
                    {activePoint.style.shortLabel}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-medium text-slate-900 dark:text-slate-100">
                  {activePoint.node.conversationTitle}
                </div>
                {isCacheRate ? (
                  <>
                    <div className="mt-1 flex items-baseline justify-between border-t border-slate-100 pt-1 tabular-nums dark:border-slate-800">
                      <span className="inline-flex items-center gap-1 text-slate-500">
                        <span>当次缓存率</span>
                        {activePoint.cacheKind !== "normal" && (
                          <span
                            className={`rounded px-1 py-0.2 text-[9.5px] font-medium ${
                              activePoint.cacheKind === "miss"
                                ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                                : activePoint.cacheKind === "compacted"
                                  ? "bg-violet-500/12 text-violet-600 dark:text-violet-300"
                                  : "bg-slate-200/80 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                            }`}
                          >
                            {activePoint.cacheKind === "miss"
                              ? "真掉缓存"
                              : activePoint.cacheKind === "compacted"
                                ? "上下文压缩"
                                : "新会话首轮"}
                          </span>
                        )}
                      </span>
                      <span
                        className={
                          activePoint.cacheKind === "miss"
                            ? "font-bold text-rose-600 dark:text-rose-400"
                            : activePoint.cacheKind === "cold-start"
                              ? "font-semibold text-slate-400"
                              : "font-bold text-emerald-600 dark:text-emerald-400"
                        }
                      >
                        {formatPercent(
                          calcCacheHitRate(
                            activePoint.node.inputTokens,
                            activePoint.node.cacheReadTokens
                          )
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-slate-400 tabular-nums">
                      <span>读缓存 {formatTokens(activePoint.node.cacheReadTokens)}</span>
                      <span>新输入 {formatTokens(activePoint.node.inputTokens)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
                      <span>输出 {formatTokens(activePoint.node.outputTokens)}</span>
                      <span>{formatUsd(activePoint.node.estimatedCostUsd)}</span>
                    </div>
                  </>
                ) : isTps ? (
                  <>
                    <div className="mt-1 flex items-baseline justify-between border-t border-slate-100 pt-1 tabular-nums dark:border-slate-800">
                      <span className="text-slate-500">当次 TPS</span>
                      <span className="font-bold text-slate-950 dark:text-slate-50">
                        {activePoint.node.outputTps > 0
                          ? `${activePoint.node.outputTps.toFixed(1)} tok/s`
                          : "待落库"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-slate-400 tabular-nums">
                      <span>输出 {formatTokens(activePoint.node.outputTokens)}</span>
                      <span>耗时 {formatDurationMs(activePoint.node.latencyMs)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
                      <span>首包 {formatDurationMs(activePoint.node.ttftMs)}</span>
                      <span>
                        流式{" "}
                        {formatDurationMs(
                          Math.max(0, activePoint.node.latencyMs - activePoint.node.ttftMs)
                        )}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-1 flex items-baseline justify-between border-t border-slate-100 pt-1 tabular-nums dark:border-slate-800">
                      <span className="text-slate-500">本次节点</span>
                      <span className="font-bold text-slate-950 dark:text-slate-50">
                        {formatTokens(activePoint.node.totalTokens)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-slate-400 tabular-nums">
                      <span>缓 {formatTokens(activePoint.node.cacheReadTokens)}</span>
                      <span>新 {formatTokens(activePoint.node.inputTokens)}</span>
                      <span>出 {formatTokens(activePoint.node.outputTokens)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
                      <span>耗时 {formatDurationMs(activePoint.node.latencyMs)}</span>
                      <span>
                        {activePoint.node.outputTps > 0
                          ? `${activePoint.node.outputTps.toFixed(1)}/s · ${formatUsd(activePoint.node.estimatedCostUsd)}`
                          : formatUsd(activePoint.node.estimatedCostUsd)}
                      </span>
                    </div>
                  </>
                )}
              </ChartFloatingTooltip>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
