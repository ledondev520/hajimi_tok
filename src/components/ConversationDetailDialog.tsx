/**
 * Input: React 钩子、ConversationDetail/StepUsageRecord 类型、@/lib/format 工具、SvgChartPrimitives 共享绘图原语、resolveModelStyle 与 @/components/ui 组件。
 * Output: 导出 ConversationDetailDialog 单会话逐轮 LLM 推理时间线与单步缓存率折线图模态框组件。
 * Pos: 会话级单步 Token、缓存命中率变化曲线、上下文窗口、延迟与数据源溯源详情弹窗（src/components/ConversationDetailDialog.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Bot, Loader2, Percent, RefreshCw, Wrench } from "lucide-react";
import type { ConversationDetail, StepUsageRecord } from "@/types/telemetry";
import {
  buildStepCacheRateSeries,
  computeAdaptivePercentBounds,
  formatDateTime,
  formatDurationMs,
  formatExactNumber,
  formatPercent,
  formatTokens,
  formatUsd,
  resolveContextHealth,
} from "@/lib/format";
import {
  analyzeStepCacheTtl,
  formatCompactGap,
  type StepCacheTtlAnnotation,
} from "@/lib/cacheTtl";
import { resolveModelStyle } from "@/components/ModelCallChart";
import {
  buildAreaPath,
  buildLinePath,
  ChartFloatingTooltip,
  computeUniformTickIndices,
  formatPercentTick,
  resolveHoverIndexFromMouse,
  SvgAreaGradients,
  SvgCrosshair,
  SvgGridAxes,
  useContainerWidth,
} from "@/components/SvgChartPrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const STEP_CHART_HEIGHT = 86;
const STEP_PAD_LEFT = 42;
const STEP_PAD_RIGHT = 12;
const STEP_PAD_TOP = 10;
const STEP_PAD_BOTTOM = 20;

function ConversationCacheRateChart({
  steps,
  overallCacheHitRate,
}: {
  steps: StepUsageRecord[];
  overallCacheHitRate: number;
}) {
  const { wrapRef, svgWidth } = useContainerWidth(true, 640);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const chart = useMemo(() => {
    const { points, minRate, maxRate } = buildStepCacheRateSeries(steps);
    const ttlAnalysis = analyzeStepCacheTtl(steps, false);
    const stepAnnMap = new Map<string, StepCacheTtlAnnotation>();
    steps.forEach((s, i) => {
      stepAnnMap.set(`${s.callIndex}-${s.stepIndex}`, ttlAnalysis.annotations[i]);
    });
    const allPercents = points.flatMap((p) => [p.stepRate * 100, p.cumulativeRate * 100]);
    const { minY, maxY } = computeAdaptivePercentBounds(allPercents);
    const ySpan = Math.max(1, maxY - minY);
    const plotW = Math.max(80, svgWidth - STEP_PAD_LEFT - STEP_PAD_RIGHT);
    const plotH = STEP_CHART_HEIGHT - STEP_PAD_TOP - STEP_PAD_BOTTOM;

    const toX = (i: number) =>
      points.length <= 1
        ? STEP_PAD_LEFT + plotW / 2
        : STEP_PAD_LEFT + (i / (points.length - 1)) * plotW;
    const toY = (rate: number) =>
      STEP_PAD_TOP + plotH - Math.min(1, Math.max(0, (rate * 100 - minY) / ySpan)) * plotH;

    const plotted = points.map((p, idx) => ({
      ...p,
      x: toX(idx),
      stepY: toY(p.stepRate),
      cumY: toY(p.cumulativeRate),
      modelStyle: resolveModelStyle(p.step.modelName, idx),
      ttl: stepAnnMap.get(`${p.step.callIndex}-${p.step.stepIndex}`) ?? {
        gapMs: null,
        modelSwitched: false,
        status: "normal" as const,
      },
    }));

    const stepPts = plotted.map((p) => ({ x: p.x, y: p.stepY }));
    const cumPts = plotted.map((p) => ({ x: p.x, y: p.cumY }));

    return {
      plotted,
      minRate,
      maxRate,
      minY,
      ySpan,
      plotW,
      plotH,
      stepLineD: buildLinePath(stepPts),
      stepAreaD: buildAreaPath(stepPts, STEP_PAD_TOP + plotH),
      cumLineD: buildLinePath(cumPts),
      tickIndices: computeUniformTickIndices(plotted.length, plotW < 360 ? 3 : 6),
      ttlSummary: ttlAnalysis.summary,
    };
  }, [steps, svgWidth]);

  const active =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < chart.plotted.length
      ? chart.plotted[hoveredIdx]
      : null;
  const dotRadius = chart.plotted.length <= 40 ? 2.8 : chart.plotted.length <= 100 ? 2.1 : 1.4;

  return (
    <div className="min-w-0 shrink-0 rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/70">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Percent className="size-3.5 shrink-0 text-emerald-500" />
          <span className="font-semibold text-slate-800 dark:text-slate-100">
            单步缓存命中率变化
          </span>
          <span className="font-mono text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
            均 {formatPercent(overallCacheHitRate)} · 范围 {formatPercent(chart.minRate)} ~{" "}
            {formatPercent(chart.maxRate)}
          </span>
          {chart.ttlSummary.sampleCount > 0 && (
            <span className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 tabular-nums dark:bg-slate-800 dark:text-slate-300">
              {chart.ttlSummary.maxKeptGapMs !== null
                ? `保活≤${formatCompactGap(chart.ttlSummary.maxKeptGapMs)}`
                : "暂无保活"}
              {chart.ttlSummary.expiredCount > 0
                ? ` · 失效 ${chart.ttlSummary.expiredCount} 次(中位 ${formatCompactGap(chart.ttlSummary.medianExpiredGapMs ?? chart.ttlSummary.minExpiredGapMs)})`
                : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 rounded-full bg-emerald-500" />
            当步命中率
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-sky-500" />
            累计命中率
          </span>
          {chart.ttlSummary.expiredCount > 0 && (
            <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <span className="inline-block size-2 rounded-full bg-rose-500" />
              TTL 失效
            </span>
          )}
        </div>
      </div>

      <div
        ref={wrapRef}
        className="relative w-full select-none"
        onMouseMove={(e) =>
          setHoveredIdx(
            resolveHoverIndexFromMouse(e, STEP_PAD_LEFT, chart.plotW, chart.plotted.length)
          )
        }
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <svg
          width={svgWidth}
          height={STEP_CHART_HEIGHT}
          role="img"
          aria-label="当前会话逐轮缓存命中率变化折线图"
          className="block w-full max-w-full cursor-crosshair overflow-visible"
        >
          <SvgAreaGradients
            items={[{ id: "conv-detail-cache-grad", color: "#10b981", topOpacity: 0.2 }]}
          />

          <SvgGridAxes
            padLeft={STEP_PAD_LEFT}
            padRight={STEP_PAD_RIGHT}
            padTop={STEP_PAD_TOP}
            plotH={chart.plotH}
            svgWidth={svgWidth}
            formatLeftLabel={(ratio) => formatPercentTick(chart.minY + chart.ySpan * ratio)}
          />

          {chart.tickIndices.map((idx, pos) => {
            const pt = chart.plotted[idx];
            if (!pt) return null;
            const anchor =
              chart.tickIndices.length === 1
                ? "middle"
                : pos === 0
                  ? "start"
                  : pos === chart.tickIndices.length - 1
                    ? "end"
                    : "middle";
            return (
              <text
                key={`${pt.step.callIndex}-${pt.step.stepIndex}`}
                x={pt.x}
                y={STEP_CHART_HEIGHT - 4}
                textAnchor={anchor}
                className="fill-slate-400 font-mono text-[10px] dark:fill-slate-500"
              >
                #{pt.step.callIndex + 1}
              </text>
            );
          })}

          {chart.stepAreaD && <path d={chart.stepAreaD} fill="url(#conv-detail-cache-grad)" />}
          {chart.cumLineD && (
            <path
              d={chart.cumLineD}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={1.3}
              strokeDasharray="3 3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {chart.stepLineD && (
            <path
              d={chart.stepLineD}
              fill="none"
              stroke="#10b981"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {active && <SvgCrosshair x={active.x} padTop={STEP_PAD_TOP} plotH={chart.plotH} />}

          {chart.plotted.map((pt, idx) => {
            const isHovered = hoveredIdx === idx;
            const isExpired = pt.ttl.status === "expired";
            const dotColor = isExpired ? "#f43f5e" : "#10b981";
            return (
              <g key={`${pt.step.callIndex}-${pt.step.stepIndex}`}>
                {(isHovered || isExpired) && (
                  <circle
                    cx={pt.x}
                    cy={pt.stepY}
                    r={isHovered ? 6 : 4.6}
                    fill={dotColor}
                    fillOpacity={isHovered ? 0.24 : 0.18}
                  />
                )}
                <circle
                  cx={pt.x}
                  cy={pt.stepY}
                  r={isHovered ? 3.8 : isExpired ? Math.max(dotRadius, 2.8) : dotRadius}
                  fill={dotColor}
                  className="stroke-white stroke-[1.1] dark:stroke-slate-950"
                />
              </g>
            );
          })}
        </svg>

        {active && (
          <ChartFloatingTooltip x={active.x} svgWidth={svgWidth} width={216} top={2} flipRatio={0.56}>
            <div className="flex items-center justify-between gap-1 font-mono text-[10px] text-slate-400">
              <span>#{active.step.callIndex + 1}</span>
              <span>{formatDateTime(active.step.timestamp)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 truncate text-[10px] font-medium text-slate-600 dark:text-slate-300">
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: active.modelStyle.color }}
              />
              <span className="truncate">{active.step.modelName}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-slate-100 pt-1 tabular-nums dark:border-slate-800">
              <span className="text-slate-500">当步缓存率</span>
              <span
                className={
                  active.stepRate < 0.5
                    ? "font-bold text-amber-600 dark:text-amber-400"
                    : "font-bold text-emerald-600 dark:text-emerald-400"
                }
              >
                {formatPercent(active.stepRate)}
              </span>
            </div>
            <div className="flex items-baseline justify-between text-[10px] tabular-nums">
              <span className="text-slate-400">累计至今</span>
              <span className="font-mono font-medium text-sky-600 dark:text-sky-400">
                {formatPercent(active.cumulativeRate)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-400 tabular-nums">
              <span>读缓存 {formatTokens(active.step.cacheReadTokens)}</span>
              <span>新输入 {formatTokens(active.step.inputTokens)}</span>
            </div>
            {active.ttl.gapMs !== null && (
              <div className="mt-0.5 flex items-center justify-between border-t border-slate-100 pt-0.5 text-[10px] tabular-nums dark:border-slate-800">
                <span className="text-slate-400">距上步 +{formatCompactGap(active.ttl.gapMs)}</span>
                <span
                  className={
                    active.ttl.status === "expired"
                      ? "font-semibold text-rose-600 dark:text-rose-400"
                      : active.ttl.status === "kept"
                        ? "font-medium text-emerald-600 dark:text-emerald-400"
                        : "text-slate-400"
                  }
                >
                  {active.ttl.status === "expired" ? "TTL 失效" : active.ttl.status === "kept" ? "缓存保活" : active.ttl.status === "compacted" ? "上下文压缩" : active.ttl.status === "model-switch" ? "切换模型" : "连续调用"}
                </span>
              </div>
            )}
          </ChartFloatingTooltip>
        )}
      </div>
    </div>
  );
}

/** ConversationDetailDialog 组件入参属性 */
export interface ConversationDetailDialogProps {
  conversationId: string | null; // 待钻取查询的会话 UUID（null 时关闭）
  open: boolean; // 受控打开状态
  onOpenChange: (open: boolean) => void; // 模态框状态变更回调
  sourceId?: string; // 可选数据源 ID（多账号场景下透传至详情接口）
}

export function ConversationDetailDialog({
  conversationId,
  open,
  onOpenChange,
  sourceId = "",
}: ConversationDetailDialogProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!open || !conversationId) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);

    const sourceQuery =
      sourceId && sourceId !== "all" ? `?source=${encodeURIComponent(sourceId)}` : "";
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}${sourceQuery}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Record<string, unknown>;
        const payload = (
          "conversationId" in json ? json : json.data ?? json.conversation
        ) as ConversationDetail | undefined;
        if (!payload) throw new Error("未找到会话详情数据");
        if (!cancelled) setDetail(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "会话详情拉取失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, conversationId, sourceId, reloadTick]);

  const sortedTools = useMemo(() => {
    if (!detail) return [];
    return Object.entries(detail.toolUsageCounts).sort((a, b) => b[1] - a[1]);
  }, [detail]);

  const modelCostSplit = useMemo(() => {
    if (!detail) return [];
    const map = new Map<string, number>();
    for (const s of detail.steps) {
      const k = s.modelName || detail.primaryModel || "Unknown";
      map.set(k, (map.get(k) ?? 0) + s.estimatedCostUsd);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [detail]);

  // 2.1. 渲染受控弹窗主体（高密度压缩头部 + 竖屏整页可滑防明细被挤扁 + 宽屏表内独立滚动）
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-hidden border-slate-200 bg-white p-3 text-slate-900 sm:w-[calc(100vw-2rem)] sm:max-w-6xl sm:p-4 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-50">
        <DialogHeader className="min-w-0 shrink-0 space-y-0.5 pr-6 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <DialogTitle className="truncate text-sm font-semibold sm:text-base">
              {detail?.title || "会话明细"}
            </DialogTitle>
            {detail?.sourceLabel && (
              <Badge
                variant="outline"
                className="h-4 border-indigo-400/40 bg-indigo-500/8 px-1.5 text-[10px] text-indigo-700 dark:text-indigo-300"
              >
                {detail.sourceLabel}
              </Badge>
            )}
            {detail && (detail.nestingDepth > 0 || Boolean(detail.parentConversationId)) && (
              <Badge className="h-4 bg-violet-600 px-1.5 text-[10px] text-white dark:bg-violet-500">
                <Bot className="size-3" />
                Subagent {detail.agentName ? `· ${detail.agentName}` : `(L${detail.nestingDepth})`}
              </Badge>
            )}
            {detail?.archived && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                归档
              </Badge>
            )}
            <DialogDescription className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-slate-400">
              <span>{conversationId ? conversationId.slice(0, 8) : "-"}</span>
              {detail?.workspaceName && <span>· {detail.workspaceName}</span>}
              {detail?.parentConversationId && (
                <span>· 父 {detail.parentConversationId.slice(0, 8)}</span>
              )}
            </DialogDescription>
          </div>
        </DialogHeader>

        {loading ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-slate-500">
            <Loader2 className="size-5 animate-spin text-indigo-500" />
            <span className="text-xs">加载中...</span>
          </div>
        ) : errorMsg ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-center">
            <AlertCircle className="size-6 text-red-500" />
            <p className="text-sm text-red-600 dark:text-red-400">{errorMsg}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setReloadTick((n) => n + 1)}
            >
              <RefreshCw className="size-3.5" />
              重试
            </Button>
          </div>
        ) : detail ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto lg:overflow-hidden">
            {/* 极简压缩汇总条（竖屏紧凑不占高，宽屏一字排开） */}
            {(() => {
              const ctx = resolveContextHealth(
                detail.latestContextUsed ?? detail.peakContextUsed,
                detail.contextLimit
              );
              return (
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1.5 text-[11px] tabular-nums dark:border-slate-800 dark:bg-slate-900/70">
                  <span title={`精确总计: ${formatExactNumber(detail.totalTokens)}`}>
                    <span className="text-slate-400">总 </span>
                    <strong className="font-semibold">{formatTokens(detail.totalTokens)}</strong>
                    <span className="text-slate-400"> ({detail.steps.length}轮)</span>
                  </span>
                  <span>
                    <span className="text-slate-400">缓存 </span>
                    <strong className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {formatPercent(detail.cacheHitRate)}
                    </strong>
                    <span className="text-slate-400"> 省{formatUsd(detail.cacheSavedUsd)}</span>
                  </span>
                  <span>
                    <span className="text-slate-400">输出 </span>
                    <strong>
                      {formatTokens(detail.thinkingTokens)}/{formatTokens(detail.responseTokens)}
                    </strong>
                  </span>
                  <span>
                    <span className="text-slate-400">上下文 </span>
                    <strong
                      className={
                        !detail.archived && ctx.level === "high"
                          ? "text-rose-600 dark:text-rose-400"
                          : !detail.archived && ctx.level === "warn"
                            ? "text-amber-600 dark:text-amber-400"
                            : ""
                      }
                    >
                      {formatTokens(ctx.used)}
                    </strong>
                    <span className="text-slate-400">
                      {" "}
                      (峰{formatTokens(detail.peakContextUsed)} · {formatDurationMs(detail.totalLatencyMs)})
                    </span>
                    {!detail.archived && ctx.level !== "ok" && (
                      <span
                        className={`ml-1 rounded px-1 py-0.2 text-[10px] font-medium ${
                          ctx.level === "high"
                            ? "bg-rose-500/12 text-rose-600 dark:text-rose-400"
                            : "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                        }`}
                      >
                        /compact
                      </span>
                    )}
                  </span>
                  <span
                    className="ml-auto"
                    title={
                      modelCostSplit.length > 0
                        ? modelCostSplit.map(([m, c]) => `${m}: ${formatUsd(c)}`).join(" · ")
                        : undefined
                    }
                  >
                    <strong className="font-semibold text-amber-600 dark:text-amber-400">
                      {formatUsd(detail.estimatedCostUsd)}
                    </strong>
                    <span className="ml-1 text-slate-400">
                      {detail.primaryModel.replace(/^Claude\s+|^Gemini\s+4\s+/i, "")}
                    </span>
                  </span>
                </div>
              );
            })()}

            {/* 单行可横滑工具频次条（不再折行占竖屏高度） */}
            {sortedTools.length > 0 && (
              <div className="flex shrink-0 items-center gap-1 overflow-x-auto pb-0.5 text-[11px]">
                <Wrench className="size-3 shrink-0 text-slate-400" />
                {sortedTools.map(([name, count]) => (
                  <Badge
                    key={name}
                    variant="secondary"
                    className="h-4 shrink-0 px-1.5 font-mono text-[10px] tabular-nums"
                  >
                    {name}×{count}
                  </Badge>
                ))}
              </div>
            )}

            {/* 会话逐轮 Prompt 缓存命中率折线图 */}
            {detail.steps.length > 0 && (
              <ConversationCacheRateChart
                key={detail.conversationId}
                steps={detail.steps}
                overallCacheHitRate={detail.cacheHitRate}
              />
            )}

            {/* 竖屏保证充足高度可顺滑滚动，宽屏自适应剩余高度独立滚动，逐轮默认倒序（最新在前） */}
            <div className="min-h-[300px] min-w-0 flex-1 overflow-auto rounded-lg border border-slate-200 lg:min-h-0 dark:border-slate-800 [&_[data-slot=table-container]]:overflow-visible">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900">
                  <TableRow className="border-slate-200 bg-slate-50 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-900">
                    <TableHead>轮次 ↓</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead className="text-right">新增输入</TableHead>
                    <TableHead className="text-right">缓存读取</TableHead>
                    <TableHead className="text-right">思考</TableHead>
                    <TableHead className="text-right">回复</TableHead>
                    <TableHead className="text-right">上下文水位</TableHead>
                    <TableHead className="text-right">耗时 / TPS</TableHead>
                    <TableHead className="text-right">成本</TableHead>
                    <TableHead>触发工具</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(() => {
                    const stepTtlAnns = analyzeStepCacheTtl(detail.steps, false).annotations;
                    return detail.steps
                      .map((step, idx) => ({ step, ann: stepTtlAnns[idx] }))
                      .reverse()
                      .map(({ step, ann }) => (
                        <TableRow
                          key={`${step.callIndex}-${step.stepIndex}`}
                          className="border-slate-200/60 text-xs dark:border-slate-800/70"
                        >
                          <TableCell
                            title={step.stepIndex > 0 ? `底层轨迹步号 S${step.stepIndex}` : undefined}
                            className="font-mono tabular-nums"
                          >
                            #{step.callIndex + 1}
                          </TableCell>
                          <TableCell className="font-mono text-slate-500 tabular-nums dark:text-slate-400">
                            <div className="flex items-center gap-1.5 whitespace-nowrap">
                              <span>{formatDateTime(step.timestamp)}</span>
                              {ann && ann.gapMs !== null && (ann.status === "expired" || ann.status === "compacted" || ann.gapMs >= 60_000) && (
                                <span
                                  className={`rounded px-1 py-0.2 text-[10px] font-medium ${
                                    ann.status === "expired"
                                      ? "bg-rose-500/12 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300"
                                      : ann.status === "compacted"
                                        ? "bg-violet-500/12 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300"
                                        : ann.status === "kept"
                                          ? "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                                          : "bg-slate-200/70 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                  }`}
                                >
                                  {ann.status === "expired" ? `失效 +${formatCompactGap(ann.gapMs)}` : ann.status === "compacted" ? `压缩 +${formatCompactGap(ann.gapMs)}` : ann.status === "model-switch" ? `切模 +${formatCompactGap(ann.gapMs)}` : `+${formatCompactGap(ann.gapMs)}`}
                                </span>
                              )}
                            </div>
                          </TableCell>
                      <TableCell className="font-medium">{step.modelName}</TableCell>
                      <TableCell className="text-right text-indigo-600 tabular-nums dark:text-indigo-400">
                        {formatTokens(step.inputTokens)}
                      </TableCell>
                      <TableCell className="text-right text-emerald-600 tabular-nums dark:text-emerald-400">
                        {formatTokens(step.cacheReadTokens)}
                      </TableCell>
                      <TableCell className="text-right text-violet-600 tabular-nums dark:text-violet-400">
                        {formatTokens(step.thinkingTokens)}
                      </TableCell>
                      <TableCell className="text-right text-amber-600 tabular-nums dark:text-amber-400">
                        {formatTokens(step.responseTokens)}
                      </TableCell>
                      <TableCell className="text-right text-slate-600 tabular-nums dark:text-slate-300">
                        {formatTokens(step.contextUsed)}
                        {step.contextLimit > 0 ? ` / ${formatTokens(step.contextLimit)}` : ""}
                      </TableCell>
                      <TableCell
                        className="text-right text-slate-500 tabular-nums dark:text-slate-400"
                        title={
                          step.latencyMs > 0
                            ? `首包 TTFT ${formatDurationMs(step.ttftMs)} + 流式 ${formatDurationMs(Math.max(0, step.latencyMs - step.ttftMs))}`
                            : undefined
                        }
                      >
                        {formatDurationMs(step.latencyMs)}
                        {step.latencyMs > 0 && step.outputTokens > 0
                          ? ` · ${(step.outputTokens / (step.latencyMs / 1000)).toFixed(1)}/s`
                          : ""}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatUsd(step.estimatedCostUsd)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {step.toolNames.length === 0 ? (
                            <span className="text-slate-400">-</span>
                          ) : (
                            (() => {
                              const counts = new Map<string, number>();
                              for (const t of step.toolNames) {
                                counts.set(t, (counts.get(t) ?? 0) + 1);
                              }
                              return [...counts.entries()].map(([t, cnt]) => (
                                <Badge
                                  key={t}
                                  variant="secondary"
                                  className="h-4 px-1 font-mono text-[10px] tabular-nums"
                                >
                                  {cnt > 1 ? `${t} ×${cnt}` : t}
                                </Badge>
                              ));
                            })()
                          )}
                        </div>
                      </TableCell>
                        </TableRow>
                      ));
                  })()}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
