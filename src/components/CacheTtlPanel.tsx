/**
 * Input: CacheTtlSummary 与 WorkspaceUsageBreakdown 类型、@/lib/cacheTtl 格式化函数、@/lib/format 工具、SvgChartPrimitives 共享绘图原语与 @/components/ui 组件。
 * Output: 导出 CacheTtlPanel 缓存 TTL 衰减折线图与各项目上一次有效时长速览组件。
 * Pos: 挂载于 CacheHitRateCard「TTL 衰减」标签页下的专项可视化视图（src/components/CacheTtlPanel.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { useMemo, useState } from "react";
import { Timer } from "lucide-react";
import type { CacheTtlSummary, WorkspaceUsageBreakdown } from "@/types/telemetry";
import { formatCompactGap } from "@/lib/cacheTtl";
import { formatDateTime, formatPercent } from "@/lib/format";
import {
  buildAreaPath,
  buildLinePath,
  CHART_CARD_CLASS,
  ChartEmptyBox,
  ChartFloatingTooltip,
  resolveHoverIndexFromMouse,
  SvgAreaGradients,
  SvgCrosshair,
  SvgGridAxes,
  useContainerWidth,
} from "@/components/SvgChartPrimitives";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** CacheTtlPanel 入参 */
export interface CacheTtlPanelProps {
  cacheTtl?: CacheTtlSummary; // 当前筛选范围全局实测缓存 TTL 汇总
  byWorkspace: WorkspaceUsageBreakdown[]; // 各项目汇总列表（含单项目实测 TTL）
  leadingTabsSlot: React.ReactNode; // 顶部粒度切换 Tabs 插槽（近7天 / 今日 / TTL 衰减）
}

const CHART_HEIGHT = 152;
const PAD_LEFT = 46;
const PAD_RIGHT = 18;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;

export function CacheTtlPanel({
  cacheTtl,
  byWorkspace,
  leadingTabsSlot,
}: CacheTtlPanelProps) {
  const [selectedWs, setSelectedWs] = useState<string>("");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const { wrapRef, svgWidth } = useContainerWidth(true, 640);

  const workspacesWithTtl = useMemo(
    () =>
      byWorkspace.filter(
        (w) => w.cacheTtl && w.cacheTtl.sampleCount > 0 && (w.cacheTtl.buckets?.length ?? 0) > 0
      ),
    [byWorkspace]
  );

  const effectiveWs = useMemo(
    () =>
      selectedWs && workspacesWithTtl.some((w) => w.workspaceName === selectedWs)
        ? selectedWs
        : "",
    [selectedWs, workspacesWithTtl]
  );

  const activeSummary: CacheTtlSummary | undefined = useMemo(
    () =>
      effectiveWs
        ? workspacesWithTtl.find((w) => w.workspaceName === effectiveWs)?.cacheTtl
        : cacheTtl,
    [effectiveWs, workspacesWithTtl, cacheTtl]
  );

  const buckets = activeSummary?.buckets ?? [];
  const plotW = Math.max(80, svgWidth - PAD_LEFT - PAD_RIGHT);
  const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const toX = (i: number) =>
    buckets.length <= 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (i / (buckets.length - 1)) * plotW;
  const toY = (rate: number) =>
    PAD_TOP + plotH - Math.min(1, Math.max(0, rate)) * plotH;

  const plotted = buckets.map((b, idx) => ({
    ...b,
    idx,
    x: toX(idx),
    y: toY(b.avgHitRate),
    hasData: b.sampleCount > 0,
  }));
  const validPts = plotted.filter((p) => p.hasData);
  const lineD = buildLinePath(validPts);
  const areaD = buildAreaPath(validPts, PAD_TOP + plotH);

  const hovered =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < plotted.length
      ? plotted[hoveredIdx]
      : null;

  const summaryBadgeText = useMemo(() => {
    if (!activeSummary || activeSummary.sampleCount === 0) return "暂无间隔样本";
    const parts: string[] = [];
    if (activeSummary.maxKeptGapMs !== null) {
      parts.push(`保活≤${formatCompactGap(activeSummary.maxKeptGapMs)}`);
    }
    const robustExp = activeSummary.medianExpiredGapMs ?? activeSummary.minExpiredGapMs;
    if (robustExp !== null && robustExp !== undefined) {
      parts.push(`失效中位 ${formatCompactGap(robustExp)}`);
    }
    return parts.length > 0 ? parts.join(" · ") : `${activeSummary.sampleCount} 笔样本`;
  }, [activeSummary]);

  const keepWarmHint = useMemo(() => {
    const exp = activeSummary?.medianExpiredGapMs ?? activeSummary?.minExpiredGapMs ?? null;
    const windowText = exp !== null && exp <= 7 * 60_000 ? "5m" : "10m";
    return `建议：${windowText} 内续聊 · >350K /compact`;
  }, [activeSummary]);

  return (
    <Card className={CHART_CARD_CLASS}>
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Timer className="size-3.5 shrink-0 text-emerald-500" />
            <CardTitle className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              缓存 TTL
            </CardTitle>
            <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[11px] tabular-nums">
              {summaryBadgeText}
            </Badge>
            {activeSummary?.lastEventKind && activeSummary.lastEventGapMs !== null && (
              <span
                title={
                  activeSummary.lastEventAt
                    ? `最近一次发生于 ${formatDateTime(activeSummary.lastEventAt)}`
                    : undefined
                }
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${
                  activeSummary.lastEventKind === "expired"
                    ? "bg-rose-500/10 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                    : "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                }`}
              >
                上次
                {activeSummary.lastEventKind === "expired" ? "失效 " : "保活 "}
                {formatCompactGap(activeSummary.lastEventGapMs)}
              </span>
            )}
          </div>
          {leadingTabsSlot}
        </div>
      </CardHeader>

      <CardContent className="space-y-1.5 px-4 pt-0">
        {!activeSummary || activeSummary.sampleCount === 0 || validPts.length === 0 ? (
          <ChartEmptyBox message="暂无有效间隔样本" />
        ) : (
          <div
            ref={wrapRef}
            className="relative w-full select-none"
            onMouseMove={(e) =>
              setHoveredIdx(resolveHoverIndexFromMouse(e, PAD_LEFT, plotW, plotted.length))
            }
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <svg
              width={svgWidth}
              height={CHART_HEIGHT}
              role="img"
              aria-label="Prompt 缓存命中率随空闲间隔衰减折线图"
              className="block w-full max-w-full cursor-crosshair overflow-visible"
            >
              <SvgAreaGradients
                items={[
                  {
                    id: "ttl-decay-grad",
                    color: "#10b981",
                    topOpacity: 0.2,
                    bottomColor: "#f43f5e",
                    bottomOpacity: 0.03,
                  },
                ]}
              />

              <SvgGridAxes
                padLeft={PAD_LEFT}
                padRight={PAD_RIGHT}
                padTop={PAD_TOP}
                plotH={plotH}
                svgWidth={svgWidth}
                highlightRatio={0.5}
                formatLeftLabel={(ratio) => `${Math.round(ratio * 100)}%`}
              />

              {plotted.map((pt, idx) => (
                <text
                  key={pt.key}
                  x={pt.x}
                  y={CHART_HEIGHT - 4}
                  textAnchor={
                    idx === 0 ? "start" : idx === plotted.length - 1 ? "end" : "middle"
                  }
                  className={
                    pt.hasData
                      ? "fill-slate-500 font-mono text-[10px] dark:fill-slate-400"
                      : "fill-slate-300 font-mono text-[10px] dark:fill-slate-700"
                  }
                >
                  {pt.label}
                </text>
              ))}

              {areaD && <path d={areaD} fill="url(#ttl-decay-grad)" />}
              {lineD && (
                <path
                  d={lineD}
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {hovered && <SvgCrosshair x={hovered.x} padTop={PAD_TOP} plotH={plotH} />}

              {plotted.map((pt) => {
                if (!pt.hasData) return null;
                const isHot = hoveredIdx === pt.idx;
                const color = pt.avgHitRate >= 0.5 ? "#10b981" : "#f43f5e";
                return (
                  <g key={pt.key}>
                    {isHot && <circle cx={pt.x} cy={pt.y} r={7} fill={color} fillOpacity={0.22} />}
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={isHot ? 4.4 : 3.2}
                      fill={color}
                      className="stroke-white stroke-[1.3] dark:stroke-slate-950"
                    />
                  </g>
                );
              })}
            </svg>

            {hovered && (
              <ChartFloatingTooltip x={hovered.x} svgWidth={svgWidth} width={198} flipRatio={0.56}>
                <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                  <span>空闲间隔 {hovered.label}</span>
                  <span>{effectiveWs || "全部项目"}</span>
                </div>
                {hovered.hasData ? (
                  <>
                    <div className="mt-1 flex items-baseline justify-between border-t border-slate-100 pt-1 tabular-nums dark:border-slate-800">
                      <span className="text-slate-500">平均缓存命中</span>
                      <span
                        className={
                          hovered.avgHitRate >= 0.5
                            ? "font-bold text-emerald-600 dark:text-emerald-400"
                            : "font-bold text-rose-600 dark:text-rose-400"
                        }
                      >
                        {formatPercent(hovered.avgHitRate)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
                      <span>样本 {hovered.sampleCount} 笔</span>
                      <span>
                        保活 {hovered.keptCount} · 失效 {hovered.expiredCount}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="mt-1 text-[10px] text-slate-400">该间隔档位暂无样本</div>
                )}
              </ChartFloatingTooltip>
            )}
          </div>
        )}

        {workspacesWithTtl.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-1.5 text-[10.5px] dark:border-slate-800/80">
            <button
              type="button"
              onClick={() => setSelectedWs("")}
              className={`cursor-pointer rounded px-1.5 py-0.5 font-medium transition-colors ${
                effectiveWs === ""
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              全部项目
            </button>
            {workspacesWithTtl.slice(0, 8).map((ws) => {
              const ttl = ws.cacheTtl!;
              const isSelected = effectiveWs === ws.workspaceName;
              const pillLabel =
                ttl.lastEventKind && ttl.lastEventGapMs !== null
                  ? `${ttl.lastEventKind === "expired" ? "失效" : "保活"} ${formatCompactGap(ttl.lastEventGapMs)}`
                  : ttl.maxKeptGapMs !== null
                    ? `保活 ${formatCompactGap(ttl.maxKeptGapMs)}`
                    : `${ttl.sampleCount}笔`;
              return (
                <button
                  key={ws.workspaceName}
                  type="button"
                  onClick={() =>
                    setSelectedWs((prev) => (prev === ws.workspaceName ? "" : ws.workspaceName))
                  }
                  title={`${ws.workspaceName}：样本 ${ttl.sampleCount} 笔，最长保活 ${formatCompactGap(ttl.maxKeptGapMs)}，失效中位 ${formatCompactGap(ttl.medianExpiredGapMs ?? ttl.minExpiredGapMs)}`}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono tabular-nums transition-colors ${
                    isSelected
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800/90 dark:text-slate-300 dark:hover:bg-slate-700"
                  }`}
                >
                  <span className="max-w-24 truncate font-sans font-medium">
                    {ws.workspaceName}
                  </span>
                  <span
                    className={
                      isSelected
                        ? "text-indigo-100"
                        : ttl.lastEventKind === "expired"
                          ? "text-rose-600 dark:text-rose-400"
                          : "text-emerald-600 dark:text-emerald-400"
                    }
                  >
                    {pillLabel}
                  </span>
                </button>
              );
            })}
            <span className="ml-auto text-[10px] text-slate-400 dark:text-slate-500">
              {keepWarmHint}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
