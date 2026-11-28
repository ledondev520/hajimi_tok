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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** 展示节点窗口规模 */
export type NodeWindowKey = "60" | "150" | "all";

/** 模型视觉配色与分组结构 */
interface ModelSeriesStyle {
  familyKey: string; // 模型家族唯一键
  shortLabel: string; // 去前缀紧凑图例名称（如 Opus 5.5 / Argon / Carbon / Neon / Hydrogen）
  color: string; // 主描边与圆点 HEX 色值
  poolTokens: number; // 当前过滤视图下该模型家族累计总 Token
  avgTps: number; // 当前过滤视图下该模型家族端到端平均 TPS
  avgCacheHitRate?: number; // 当前过滤视图下该模型家族平均缓存命中率（0 ~ 1）
}

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

const CHART_HEIGHT = 152; // SVG 绘图区固定紧凑高度（像素）
const PAD_LEFT = 48; // 左侧 Y 轴刻度留白
const PAD_RIGHT = 14; // 右侧边缘留白
const PAD_TOP = 12; // 顶部圆点防裁切留白
const PAD_BOTTOM = 22; // 底部 X 轴日期-时间留白

const FALLBACK_COLORS = ["#6366f1", "#0ea5e9", "#14b8a6", "#f97316"]; // 未知新模型的轮询配色池

/**
 * 职责：将原始模型全称提炼为去前缀紧凑家族键与图例短名，并分配高辨识度固定色值（明确区分 Argon / Carbon / Neon / Hydrogen）。
 * 参数：modelName — 可读模型名称；fallbackIndex — 未知模型兜底色索引。
 * 返回值：ModelSeriesStyle 样式描述对象。
 */
export function resolveModelStyle(modelName: string, fallbackIndex: number): ModelSeriesStyle {
  // 0. 剥离推理档位后缀与 Claude / Gemini 代际前缀
  const base = (modelName || "Unknown").replace(/\s*\([^)]*\)\s*$/g, "").trim();
  const lower = base.toLowerCase();

  if (lower.includes("opus")) {
    const shortLabel = base.replace(/^claude\s+/i, "").trim();
    return { familyKey: shortLabel.toLowerCase(), shortLabel, color: "#8b5cf6", poolTokens: 0, avgTps: 0 };
  }
  if (lower.includes("sonnet")) {
    const shortLabel = base.replace(/^claude\s+/i, "").trim();
    return { familyKey: shortLabel.toLowerCase(), shortLabel, color: "#f59e0b", poolTokens: 0, avgTps: 0 };
  }
  if (lower.includes("haiku")) {
    const shortLabel = base.replace(/^claude\s+/i, "").trim();
    return { familyKey: shortLabel.toLowerCase(), shortLabel, color: "#ec4899", poolTokens: 0, avgTps: 0 };
  }
  if (
    lower.includes("gemini") ||
    lower.includes("argon") ||
    lower.includes("carbon") ||
    lower.includes("neon") ||
    lower.includes("hydrogen")
  ) {
    const shortLabel = lower.includes("flash")
      ? "Flash"
      : base.replace(/^gemini\s+\d+(?:\.\d+)?\s+/i, "").trim() || base;
    const color = lower.includes("carbon")
      ? "#0ea5e9"
      : lower.includes("argon")
        ? "#10b981"
        : lower.includes("neon")
          ? "#14b8a6"
          : lower.includes("hydrogen")
            ? "#6366f1"
            : "#06b6d4";
    return { familyKey: shortLabel.toLowerCase(), shortLabel, color, poolTokens: 0, avgTps: 0 };
  }

  return {
    familyKey: lower || "unknown",
    shortLabel: base || "Unknown",
    color: FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length],
    poolTokens: 0,
    avgTps: 0,
  };
}

/**
 * 职责：渲染高信息密度的模型调用增量节点折线图。
 * 思路：1) 通过 ResizeObserver 获取容器真实像素宽度避免 SVG 拉伸变形；2) 按调用次序均匀排布每个增量节点并标注 MM-DD HH:mm 日期-时间横轴；3) 支持悬停十字准星透视与点击节点打开会话详情。
 * 参数：props — 调用节点序列、总调用次数与点击会话回调。
 * 返回值：shadcn Card 包裹的可交互折线图组件。
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

  // 1.2. 构建同池内各模型的图例样式（带各自累计消耗）并计算每个节点的像素坐标 (x, y)
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
      const style = styleMap.get(resolveModelStyle(node.modelName, 0).familyKey) ?? resolveModelStyle(node.modelName, 0);
      const cacheKind: CacheNodeKind = isCacheRate ? (cacheKindList[idx] ?? "normal") : "normal";
      // shortcut: 按调用次序等距排布避免跨夜空闲挤压活跃节点，需要严格物理时间间距时再切换时间戳比例尺
      const x = activeNodes.length === 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (idx / (activeNodes.length - 1)) * plotW;
      const val = valueOf(node);
      const y = cacheKind === "cold-start" ? PAD_TOP + plotH : PAD_TOP + plotH - Math.min(1, Math.max(0, (val - minY) / ySpan)) * plotH;
      return { node, style, x, y, val, cacheKind };
    });

    // 按模型家族分组构造折线路径（缓存率视图排除 cold-start，避免新会话首轮把主曲线拉出伪深坑）
    const linePlotted = isCacheRate ? plotted.filter((p) => p.cacheKind !== "cold-start") : plotted;
    const seriesPaths = [...styleMap.values()]
      .filter((style) => !hiddenFamilies.has(style.familyKey))
      .map((style) => {
        const pts = linePlotted.filter((p) => p.style.familyKey === style.familyKey);
        const lineD = pts
          .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
          .join(" ");
        const baselineY = (PAD_TOP + plotH).toFixed(1);
        const areaD =
          pts.length >= 2
            ? `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${baselineY} L${pts[0].x.toFixed(1)},${baselineY} Z`
            : "";
        return { style, pts, lineD, areaD };
      });

    const backboneD =
      styleMap.size > 1 && linePlotted.length >= 2
        ? linePlotted
            .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(" ")
        : "";

    // 选取自适应数量的均匀 X 轴日期-时间刻度索引（窄屏降为首尾 2 个防重叠）
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

  // 1.3. 解析受控或本地悬停索引（支持左右双图按 seq 同步联动）
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
    visibleNodes.length <= 75 ? 3.3 : visibleNodes.length <= 160 ? 2.4 : 1.7; // 随节点密度自适应圆点半径

  return (
    <Card className="min-w-0 gap-2 border-slate-200/80 bg-white py-2.5 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
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

            {/* 同池子模型颜色图例（支持点击显隐，展示各自消耗、平均端到端 TPS 或缓存命中率） */}
            <div className="flex flex-wrap items-center gap-1.5 pl-1">
              {chartData.legend.map((s) => {
                const isVisible = !hiddenFamilies.has(s.familyKey);
                return (
                  <button
                    key={s.familyKey}
                    type="button"
                    onClick={() => toggleFamily(s.familyKey)}
                    aria-pressed={isVisible}
                    title={`点击显示/隐藏 ${s.shortLabel}`}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium tabular-nums transition-opacity ${
                      isVisible
                        ? "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70"
                        : "text-slate-400 line-through opacity-45 hover:opacity-75 dark:text-slate-500"
                    }`}
                  >
                    <span
                      style={{ backgroundColor: s.color }}
                      className="inline-block size-2 rounded-full"
                    />
                    <span>{s.shortLabel}</span>
                    {isCacheRate ? (
                      s.avgCacheHitRate !== undefined && (
                        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">
                          均 {formatPercent(s.avgCacheHitRate)}
                        </span>
                      )
                    ) : isTps ? (
                      s.avgTps > 0 && (
                        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">
                          均 {s.avgTps.toFixed(1)}/s
                        </span>
                      )
                    ) : (
                      s.poolTokens > 0 && (
                        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">
                          {formatTokens(s.poolTokens)}
                        </span>
                      )
                    )}
                  </button>
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
                <TabsTrigger value="60" className="px-2 text-[11px]">
                  60
                </TabsTrigger>
                <TabsTrigger value="150" className="px-2 text-[11px]">
                  150
                </TabsTrigger>
                <TabsTrigger value="all" className="px-2 text-[11px]">
                  全部
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4">
        {chartData.plotted.length === 0 ? (
          <div className="flex h-[152px] items-center justify-center rounded-md border border-dashed border-slate-200 text-xs text-slate-400 dark:border-slate-800">
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
              if (activePoint) {
                onSelectConversationId(activePoint.node.conversationId);
              }
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
                    <stop offset="0%" stopColor={style.color} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={style.color} stopOpacity={0.01} />
                  </linearGradient>
                ))}
              </defs>

              {/* 水平参考网格线与 Y 轴刻度 */}
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
                      className="stroke-slate-200/90 dark:stroke-slate-800"
                    />
                    <text
                      x={PAD_LEFT - 6}
                      y={y + 3.5}
                      textAnchor="end"
                      className="fill-slate-400 font-mono text-[10px] dark:fill-slate-500"
                    >
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

              {/* X 轴日期-时间刻度（MM-DD HH:mm） */}
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

              {/* 跨模型时间序微弱虚线骨架 */}
              {chartData.backboneD && (
                <path
                  d={chartData.backboneD}
                  fill="none"
                  strokeDasharray="2 3"
                  strokeWidth={1}
                  className="stroke-slate-300/70 dark:stroke-slate-700/70"
                />
              )}

              {/* 各模型折线与渐变面积 */}
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

              {/* 悬停十字准星竖线 */}
              {activePoint && (
                <line
                  x1={activePoint.x}
                  y1={PAD_TOP}
                  x2={activePoint.x}
                  y2={PAD_TOP + chartData.plotH}
                  strokeDasharray="3 2"
                  strokeWidth={1}
                  className="stroke-slate-400 dark:stroke-slate-500"
                />
              )}

              {/* 逐次增量调用节点圆点（缓存率视图：空心灰圈=新会话首轮、紫点=压缩、红点=真掉缓存） */}
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

            {/* 悬停节点悬浮透视卡片 */}
            {activePoint && (
              <div
                style={{
                  left:
                    activePoint.x > svgWidth * 0.6
                      ? `${Math.max(8, activePoint.x - 258)}px`
                      : `${Math.min(svgWidth - 258, activePoint.x + 12)}px`,
                  top: "4px",
                }}
                className="pointer-events-none absolute z-20 w-[246px] rounded-lg border border-slate-200 bg-white/95 p-2 text-[11px] shadow-md backdrop-blur-xs dark:border-slate-700 dark:bg-slate-900/95"
              >
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
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
