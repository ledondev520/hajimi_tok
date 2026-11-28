/**
 * Input: React 钩子与引用、CallNodePoint 类型、@/lib/format 格式化工具、@/components/ui 卡片/徽章/选项卡组件与 lucide-react 图标。
 * Output: 导出 ModelCallChart 模型调用节点折线图组件与 resolveModelStyle 模型图例样式解析器。
 * Pos: 看板中部紧凑趋势可视化层，将每次增量读取的模型推理调用渲染为可交互 Token 或 TPS 折线节点（src/components/ModelCallChart.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
  readStoredJson,
  writeStoredJson,
} from "@/lib/format";
import { buildSmoothAreaPath, buildSmoothLinePath } from "@/lib/chartPath";
import {
  CURATED_SERIES_PALETTE,
  ensureDistinctColors,
  resolveModelStyle,
  type ModelSeriesStyle,
} from "@/lib/modelStyle";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export { CURATED_SERIES_PALETTE, ensureDistinctColors, resolveModelStyle, type ModelSeriesStyle };

/** 展示节点窗口规模 */
export type NodeWindowKey = "60" | "150" | "all";

/** ModelCallChart 组件入参属性 */
export interface ModelCallChartProps {
  nodes: CallNodePoint[]; // 按时间升序排列的增量调用节点数组
  byModel: ModelUsageBreakdown[]; // 当前视图下按模型汇总的消耗列表
  totalCallCount: number; // 当前筛选条件下的总调用次数
  onSelectConversationId: (conversationId: string) => void; // 点击某个节点时打开对应会话详情
  variant?: "tokens" | "tps" | "cacheRate"; // 图表度量维度：tokens、tps 或 cacheRate（缓存命中率）
  windowKey?: NodeWindowKey; // 可选受控窗口档位（用于左右双图同步缩放）
  onWindowKeyChange?: (key: NodeWindowKey) => void; // 受控窗口切换回调
  hoveredSeq?: number | null; // 可选受控悬停节点序号（用于左右双图十字准星同步）
  onHoverSeq?: (seq: number | null) => void; // 受控悬停节点变更回调
  titleOverride?: string; // 可选自定义卡片标题（如“今日调用增量折线”）
  leadingTabsSlot?: ReactNode; // 可选右上角前置切换器插槽（如「近7天 | 今日」切换）
  emptyMessage?: string; // 可选空数据提示文案
}

const CHART_HEIGHT = 188; // SVG 绘图区统一优雅高度（像素）
const PAD_LEFT = 48; // 左侧 Y 轴刻度留白
const PAD_RIGHT = 14; // 右侧边缘留白
const PAD_TOP = 12; // 顶部圆点防裁切留白
const PAD_BOTTOM = 22; // 底部 X 轴日期-时间留白

/**
 * 职责：渲染高信息密度的模型调用增量节点曲线图。
 * 思路：1) 通过 ResizeObserver 获取容器真实像素宽度避免 SVG 拉伸变形；2) 同模型仅连接相邻连续片段（下标间距 <= 3），杜绝稀疏模型跨越大段空白画出误导性横贯直线；3) 支持悬停十字准星透视与点击节点打开会话详情。
 * 参数：props — 调用节点序列、总调用次数与点击会话回调。
 * 返回值：shadcn Card 包裹的可交互曲线图组件。
 */
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
  // 0. 节点窗口、容器像素宽度与当前悬停节点索引状态
  const isTps = variant === "tps"; // 是否为单次节点 TPS 速率模式
  const isCacheRate = variant === "cacheRate"; // 是否为单次节点缓存命中率模式
  const [innerWindowKey, setInnerWindowKey] = useState<NodeWindowKey>("60"); // 非受控默认窗口
  const windowKey = controlledWindow ?? innerWindowKey;
  const setWindowKey = (k: NodeWindowKey) => {
    setInnerWindowKey(k);
    onWindowKeyChange?.(k);
  };
  const storageKey = `agy_chart_hidden_nodes_${variant}_v1`;
  const [svgWidth, setSvgWidth] = useState<number>(960); // SVG 实测像素宽度
  const [innerHoveredIdx, setInnerHoveredIdx] = useState<number | null>(null); // 非受控悬停下标
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<string>>(
    () => new Set(readStoredJson<string[]>(storageKey, []))
  ); // 持久化的图例隐藏模型家族键集合
  const wrapRef = useRef<HTMLDivElement | null>(null); // 绘图容器 DOM 引用

  useEffect(() => {
    writeStoredJson(storageKey, [...hiddenFamilies]);
  }, [storageKey, hiddenFamilies]);

  const toggleFamily = (familyKey: string) => {
    setHiddenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(familyKey)) next.delete(familyKey);
      else next.add(familyKey);
      return next;
    });
  };

  // 0.1. 监听容器宽度自适应重算像素坐标
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const updateWidth = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 120) setSvgWidth(w);
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 1.1. 根据窗口档位截取尾部最近 N 个增量节点
  const visibleNodes = useMemo(() => {
    if (windowKey === "all") return nodes;
    const limit = windowKey === "60" ? 60 : 150;
    return nodes.slice(-limit);
  }, [nodes, windowKey]);

  // 1.2. 构建同池内各模型的图例样式（带各自累计消耗与防撞色）并计算每个节点的像素坐标 (x, y)
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

    // 保证同图内所有模型颜色互不重复
    const distinctLegend = ensureDistinctColors([...styleMap.values()]);
    const distinctStyleMap = new Map(distinctLegend.map((s) => [s.familyKey, s]));

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

    // 方案 A：区分新会话首轮冷启动（脱线灰圈）、上下文压缩（紫点）与老会话真掉缓存（红点）
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
    const bounds = isCacheRate
      ? computeAdaptivePercentBounds((boundSource.length > 0 ? boundSource : activeNodes).map(valueOf))
      : computeAdaptiveLinearBounds(activeNodes.map(valueOf), isTps ? 100 : 1000);
    const minY = bounds.minY;
    const maxY = bounds.maxY;
    const ySpan = Math.max(1, maxY - minY);
    const plotW = Math.max(80, svgWidth - PAD_LEFT - PAD_RIGHT);
    const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

    const plotted = activeNodes.map((node, idx) => {
      const fk = resolveModelStyle(node.modelName, 0).familyKey;
      const style = distinctStyleMap.get(fk) ?? resolveModelStyle(node.modelName, 0);
      const cacheKind: CacheNodeKind = isCacheRate ? (cacheKindList[idx] ?? "normal") : "normal";
      const x = activeNodes.length === 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (idx / (activeNodes.length - 1)) * plotW;
      const val = valueOf(node);
      const y = cacheKind === "cold-start" ? PAD_TOP + plotH : PAD_TOP + plotH - Math.min(1, Math.max(0, (val - minY) / ySpan)) * plotH;
      return { node, style, x, y, val, cacheKind, plotIdx: idx };
    });

    // 按模型家族分组并拆分为连续片段（下标间隔 > 3 即断线），孤立点改为散点标记，杜绝跨空横线穿模
    const linePlotted = isCacheRate ? plotted.filter((p) => p.cacheKind !== "cold-start") : plotted;
    const baseLineY = PAD_TOP + plotH;
    const MAX_SEGMENT_GAP = 3;
    const seriesPaths = distinctLegend
      .filter((style) => !hiddenFamilies.has(style.familyKey))
      .map((style) => {
        const pts = linePlotted.filter((p) => p.style.familyKey === style.familyKey);
        const segments: Array<typeof pts> = [];
        let current: typeof pts = [];
        for (const p of pts) {
          if (current.length > 0 && p.plotIdx - current[current.length - 1].plotIdx > MAX_SEGMENT_GAP) {
            segments.push(current);
            current = [p];
          } else {
            current.push(p);
          }
        }
        if (current.length > 0) segments.push(current);

        const drawnSegments = segments
          .filter((seg) => seg.length >= 2)
          .map((seg) => ({
            lineD: buildSmoothLinePath(seg, PAD_TOP, baseLineY),
            areaD: buildSmoothAreaPath(seg, baseLineY, PAD_TOP, baseLineY),
          }));
        const isolatedPts = segments.filter((seg) => seg.length === 1).map((seg) => seg[0]);
        return { style, pts, drawnSegments, isolatedPts };
      });

    // 仅统计当前窗口内有效 TPS 的均值与峰值，供 TPS 图表标题栏摘要使用
    const tpsVals = isTps ? plotted.map((p) => p.val).filter((v) => v > 0) : [];
    const windowAvgTps = tpsVals.length > 0 ? tpsVals.reduce((s, v) => s + v, 0) / tpsVals.length : 0;
    const windowPeakTps = tpsVals.length > 0 ? Math.max(...tpsVals) : 0;

    const maxTicks = plotW < 360 ? 2 : 4;
    const tickIndices =
      plotted.length <= maxTicks
        ? plotted.map((_, i) => i)
        : maxTicks === 2
          ? [0, plotted.length - 1]
          : [
              0,
              Math.floor((plotted.length - 1) / 3),
              Math.floor(((plotted.length - 1) * 2) / 3),
              plotted.length - 1,
            ];

    return {
      legend: distinctLegend,
      plotted,
      seriesPaths,
      minY,
      maxY,
      plotW,
      plotH,
      tickIndices,
      realMissCount,
      windowAvgTps,
      windowPeakTps,
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

  const isSparse = visibleNodes.length <= 28;

  return (
    <Card className="h-full min-w-0 gap-3 py-4">
      <CardHeader className="space-y-2.5 px-5 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {isCacheRate ? (
              <Percent className="size-3.5 text-[var(--theme-text-muted)]" />
            ) : isTps ? (
              <Gauge className="size-3.5 text-[var(--theme-text-muted)]" />
            ) : (
              <TrendingUp className="size-3.5 text-[var(--theme-text-muted)]" />
            )}
            <CardTitle className="text-[13.5px] font-semibold tracking-tight text-[var(--theme-text)]">
              {titleOverride ??
                (isCacheRate ? "单次缓存率" : isTps ? "生成速率 TPS" : "单次消耗")}
            </CardTitle>
            <span className="font-mono text-[11px] text-[var(--theme-text-muted)] tabular-nums">
              {visibleNodes.length === totalCallCount
                ? `${totalCallCount} 次`
                : `${visibleNodes.length} / ${totalCallCount}`}
            </span>
            {isTps && chartData.windowAvgTps > 0 && (
              <span className="hidden items-center gap-2 border-l border-[var(--theme-border)] pl-2 font-mono text-[11px] text-[var(--theme-text-muted)] tabular-nums sm:inline-flex">
                <span>
                  均 <strong className="font-medium text-[var(--theme-text-secondary)]">{chartData.windowAvgTps.toFixed(1)}/s</strong>
                </span>
                <span>
                  峰 <strong className="font-medium text-[var(--theme-text-secondary)]">{Math.round(chartData.windowPeakTps)}/s</strong>
                </span>
              </span>
            )}
            {isCacheRate && chartData.realMissCount > 0 && (
              <Badge
                variant="outline"
                title="老会话非首轮且非压缩的真实缓存失效次数"
                className="h-5 rounded-md border-rose-500/35 bg-rose-500/10 px-1.5 font-mono text-[10px] text-rose-600 tabular-nums dark:text-rose-300"
              >
                掉 {chartData.realMissCount} 次
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {leadingTabsSlot}
            <Tabs
              value={windowKey}
              onValueChange={(v) => setWindowKey(v as NodeWindowKey)}
              aria-label="调用节点数量范围"
            >
              <TabsList className="h-6.5 rounded-lg p-0.5">
                <TabsTrigger value="60" className="rounded-md px-2 text-[11px]">60</TabsTrigger>
                <TabsTrigger value="150" className="rounded-md px-2 text-[11px]">150</TabsTrigger>
                <TabsTrigger value="all" className="rounded-md px-2 text-[11px]">全部</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {/* 第二行：Vercel / OpenRouter 风格扁平内联图例（告别繁杂灰底胶囊堆砌） */}
        {chartData.legend.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
            {chartData.legend.map((s) => {
              const isVisible = !hiddenFamilies.has(s.familyKey);
              return (
                <button
                  key={s.familyKey}
                  type="button"
                  onClick={() => toggleFamily(s.familyKey)}
                  aria-pressed={isVisible}
                  title={`点击显示/隐藏 ${s.shortLabel}`}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 font-medium tabular-nums transition-all hover:bg-[var(--theme-surface-elevated)] ${
                    isVisible
                      ? "text-[var(--theme-text-secondary)]"
                      : "text-[var(--theme-text-muted)] line-through opacity-35 hover:opacity-70"
                  }`}
                >
                  <span style={{ backgroundColor: s.color }} className="inline-block size-2 shrink-0 rounded-full" />
                  <span>{s.shortLabel}</span>
                  {isCacheRate ? (
                    s.avgCacheHitRate !== undefined && (
                      <span className="font-mono text-[10.5px] font-normal text-[var(--theme-text-muted)]">
                        {formatPercent(s.avgCacheHitRate)}
                      </span>
                    )
                  ) : isTps ? (
                    s.avgTps > 0 && (
                      <span className="font-mono text-[10.5px] font-normal text-[var(--theme-text-muted)]">
                        {s.avgTps.toFixed(1)}/s
                      </span>
                    )
                  ) : (
                    s.poolTokens > 0 && (
                      <span className="font-mono text-[10.5px] font-normal text-[var(--theme-text-muted)]">
                        {formatTokens(s.poolTokens)}
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </div>
        )}
      </CardHeader>

      <CardContent className="px-5">
        {chartData.plotted.length === 0 ? (
          <div className="flex h-[188px] items-center justify-center rounded-xl border border-dashed border-[var(--theme-border)] text-xs text-[var(--theme-text-muted)]">
            {emptyMessage ?? "暂无数据"}
          </div>
        ) : (
          <div
            ref={wrapRef}
            className="relative w-full select-none"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = e.clientX - rect.left - PAD_LEFT;
              if (chartData.plotted.length === 1) {
                updateHoverIdx(0);
                return;
              }
              const ratio = Math.max(0, Math.min(1, relX / chartData.plotW));
              updateHoverIdx(Math.round(ratio * (chartData.plotted.length - 1)));
            }}
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
                  ? "单次调用节点缓存率曲线图"
                  : isTps
                    ? "单次调用节点 TPS 曲线图"
                    : "模型调用节点 Token 曲线图"
              }
              className="block w-full max-w-full cursor-crosshair overflow-visible"
            >
              <defs>
                {chartData.seriesPaths.map(({ style }) => (
                  <linearGradient
                    key={style.familyKey}
                    id={`grad-${variant}-${style.familyKey.replace(/[^a-z0-9]/g, "-")}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={style.color} stopOpacity={0.14} />
                    <stop offset="100%" stopColor={style.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>

              {/* 极简水平参考发丝线与 Y 轴刻度 */}
              {[0, 0.5, 1].map((ratio) => {
                const y = PAD_TOP + chartData.plotH * (1 - ratio);
                const val = chartData.minY + (chartData.maxY - chartData.minY) * ratio;
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
                    <text x={PAD_LEFT - 8} y={y + 3.5} textAnchor="end" fill="var(--theme-chart-axis)" className="font-mono text-[10px]">
                      {isCacheRate
                        ? `${Number.isInteger(val) ? val : val.toFixed(1)}%`
                        : val <= 0
                          ? "0"
                          : isTps
                            ? `${Math.round(val)}/s`
                            : formatTokens(Math.round(val))}
                    </text>
                  </g>
                );
              })}

              {/* X 轴日期-时间刻度 */}
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
                  <text key={pt.node.seq} x={pt.x} y={CHART_HEIGHT - 4} textAnchor={anchor} fill="var(--theme-chart-axis)" className="font-mono text-[10px]">
                    {formatDateTime(pt.node.timestamp).slice(0, 11)}
                  </text>
                );
              })}

              {/* 仅绘制相邻连续片段的平滑曲线与渐变面积；孤立点用精致散点表达，彻底消除跨空横贯直线 */}
              {chartData.seriesPaths.map(({ style, drawnSegments, isolatedPts }) => {
                const gradId = `grad-${variant}-${style.familyKey.replace(/[^a-z0-9]/g, "-")}`;
                return (
                  <g key={style.familyKey}>
                    {drawnSegments.map((seg, segIdx) => (
                      <g key={segIdx}>
                        {seg.areaD && <path d={seg.areaD} fill={`url(#${gradId})`} />}
                        {seg.lineD && (
                          <path
                            d={seg.lineD}
                            fill="none"
                            stroke={style.color}
                            strokeWidth={1.85}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        )}
                      </g>
                    ))}
                    {isolatedPts.map((pt) => (
                      <g key={`iso-${pt.node.seq}`}>
                        <line
                          x1={pt.x}
                          y1={pt.y}
                          x2={pt.x}
                          y2={PAD_TOP + chartData.plotH}
                          stroke={style.color}
                          strokeOpacity={0.28}
                          strokeDasharray="2 2"
                          strokeWidth={1}
                        />
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={3.2}
                          fill={style.color}
                          stroke="var(--theme-surface)"
                          strokeWidth={1.5}
                        />
                      </g>
                    ))}
                  </g>
                );
              })}

              {/* 悬停十字准星竖线 */}
              {activePoint && (
                <line
                  x1={activePoint.x}
                  y1={PAD_TOP}
                  x2={activePoint.x}
                  y2={PAD_TOP + chartData.plotH}
                  strokeDasharray="3 3"
                  strokeWidth={1}
                  stroke="var(--theme-border-strong)"
                />
              )}

              {/* 仅突出悬停点、最新点、稀疏点与异常掉缓存/压缩告警点，杜绝密集圆点噪点 */}
              {chartData.plotted.map((pt, idx) => {
                const isLatest = idx === chartData.plotted.length - 1;
                const isHovered = hoveredIdx === idx;
                const isCold = pt.cacheKind === "cold-start";
                const isCompacted = pt.cacheKind === "compacted";
                const isMiss = pt.cacheKind === "miss";
                if (!isHovered && !isLatest && !isMiss && !isCompacted && !isSparse && !isCold) {
                  return null;
                }
                const fillColor = isMiss ? "#f43f5e" : isCompacted ? "#8b5cf6" : pt.style.color;
                return (
                  <g key={pt.node.seq}>
                    {(isLatest || isHovered || isMiss) && (
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 7.5 : 5.5}
                        fill={isCold ? "#94a3b8" : fillColor}
                        fillOpacity={isHovered ? 0.22 : 0.16}
                      />
                    )}
                    {isCold ? (
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 4 : 2.3}
                        stroke="#94a3b8"
                        strokeWidth={1.4}
                        fill="var(--theme-surface)"
                      />
                    ) : (
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isHovered ? 4.2 : isMiss ? 3.2 : 2.5}
                        fill={fillColor}
                        stroke="var(--theme-surface)"
                        strokeWidth={1.4}
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            {/* 悬停精致浮窗 */}
            {activePoint && (
              <div
                style={{
                  left:
                    activePoint.x > svgWidth * 0.6
                      ? `${Math.max(8, activePoint.x - 262)}px`
                      : `${Math.min(svgWidth - 262, activePoint.x + 12)}px`,
                  top: "4px",
                }}
                className="theme-popover-surface pointer-events-none absolute z-20 w-[250px] rounded-xl border p-3 text-[11px]"
              >
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] whitespace-nowrap text-[var(--theme-text-muted)]">
                  <span>{formatDateTime(activePoint.node.timestamp)} · #{activePoint.node.seq}</span>
                  <span style={{ color: activePoint.style.color }} className="truncate font-sans font-semibold">
                    {activePoint.style.shortLabel}
                  </span>
                </div>
                <div className="mt-1 truncate font-medium text-[var(--theme-text)]">
                  {activePoint.node.conversationTitle}
                </div>
                {isCacheRate ? (
                  <>
                    <div className="mt-2 flex items-baseline justify-between border-t border-[var(--theme-border)] pt-1.5 tabular-nums">
                      <span className="inline-flex items-center gap-1 text-[var(--theme-text-muted)]">
                        <span>当次缓存率</span>
                        {activePoint.cacheKind !== "normal" && (
                          <span
                            className={`rounded px-1 py-0.5 text-[9.5px] font-medium ${
                              activePoint.cacheKind === "miss"
                                ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                                : activePoint.cacheKind === "compacted"
                                  ? "bg-violet-500/12 text-violet-600 dark:text-violet-300"
                                  : "bg-[var(--theme-surface-muted)] text-[var(--theme-text-muted)]"
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
                            ? "font-mono font-bold text-rose-600 dark:text-rose-400"
                            : activePoint.cacheKind === "cold-start"
                              ? "font-mono font-semibold text-[var(--theme-text-muted)]"
                              : "font-mono font-bold text-emerald-600 dark:text-emerald-400"
                        }
                      >
                        {formatPercent(calcCacheHitRate(activePoint.node.inputTokens, activePoint.node.cacheReadTokens))}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
                      <span>读缓存 {formatTokens(activePoint.node.cacheReadTokens)}</span>
                      <span>新输入 {formatTokens(activePoint.node.inputTokens)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
                      <span>输出 {formatTokens(activePoint.node.outputTokens)}</span>
                      <span className="font-mono">{formatUsd(activePoint.node.estimatedCostUsd)}</span>
                    </div>
                  </>
                ) : isTps ? (
                  <>
                    <div className="mt-2 flex items-baseline justify-between border-t border-[var(--theme-border)] pt-1.5 tabular-nums">
                      <span className="text-[var(--theme-text-muted)]">当次 TPS</span>
                      <span className="font-mono font-bold text-[var(--theme-text)]">
                        {activePoint.node.outputTps > 0 ? `${activePoint.node.outputTps.toFixed(1)} tok/s` : "待落库"}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
                      <span>输出 {formatTokens(activePoint.node.outputTokens)}</span>
                      <span>耗时 {formatDurationMs(activePoint.node.latencyMs)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
                      <span>首包 {formatDurationMs(activePoint.node.ttftMs)}</span>
                      <span>流式 {formatDurationMs(Math.max(0, activePoint.node.latencyMs - activePoint.node.ttftMs))}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-2 flex items-baseline justify-between border-t border-[var(--theme-border)] pt-1.5 tabular-nums">
                      <span className="text-[var(--theme-text-muted)]">本次节点</span>
                      <span className="font-mono font-bold text-[var(--theme-text)]">
                        {formatTokens(activePoint.node.totalTokens)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
                      <span>缓 {formatTokens(activePoint.node.cacheReadTokens)}</span>
                      <span>新 {formatTokens(activePoint.node.inputTokens)}</span>
                      <span>出 {formatTokens(activePoint.node.outputTokens)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
                      <span>耗时 {formatDurationMs(activePoint.node.latencyMs)}</span>
                      <span className="font-mono">
                        {activePoint.node.outputTps > 0
                          ? `${activePoint.node.outputTps.toFixed(1)}/s · ${formatUsd(activePoint.node.estimatedCostUsd)}`
                          : formatUsd(activePoint.node.estimatedCostUsd)}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
