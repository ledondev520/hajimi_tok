/**
 * Input: React 钩子与鼠标事件类型、@/lib/format 的 localStorage 持久化读写工具。
 * Output: 导出折线图共享原语：容器宽度监听、图例隐藏集合持久化、路径构造、坐标轴网格、渐变定义、十字准星、浮窗与图例开关按钮。
 * Pos: 前端 5 张 SVG 折线图的公共底座（src/components/SvgChartPrimitives.tsx），消除跨组件重复手写绘图样板。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { readStoredJson, writeStoredJson } from "@/lib/format";

/** 看板中部折线图卡片统一样式 */
export const CHART_CARD_CLASS =
  "min-w-0 gap-2 border-slate-200/80 bg-white py-2.5 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70";

/**
 * 职责：监听图表外层容器像素宽度并在窗口缩放时平滑重算 SVG 坐标系。
 * 参数：active — 当前视图是否挂载容器；defaultWidth — 初始兜底宽度（像素）。
 * 返回值：{ wrapRef, svgWidth }。
 */
export function useContainerWidth(active = true, defaultWidth = 640) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [svgWidth, setSvgWidth] = useState<number>(defaultWidth);

  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  return { wrapRef, svgWidth };
}

/**
 * 职责：持久化管理图表隐藏系列键集合（localStorage 同步），供多图图例点击显隐复用。
 * 参数：storageKey — localStorage 键名。
 * 返回值：[hiddenSet, toggleKey] 二元组。
 */
export function usePersistedSet(storageKey: string): [Set<string>, (key: string) => void] {
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(readStoredJson<string[]>(storageKey, []))
  );

  useEffect(() => {
    writeStoredJson(storageKey, [...hidden]);
  }, [storageKey, hidden]);

  const toggle = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return [hidden, toggle];
}

/** 构造 SVG 折线 path d 字符串 */
export function buildLinePath(pts: ReadonlyArray<{ x: number; y: number }>): string {
  return pts.length >= 2
    ? pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
    : "";
}

/** 构造贴底闭环 SVG 渐变面积 path d 字符串 */
export function buildAreaPath(
  pts: ReadonlyArray<{ x: number; y: number }>,
  baselineY: number
): string {
  const line = buildLinePath(pts);
  if (!line) return "";
  const bY = baselineY.toFixed(1);
  return `${line} L${pts[pts.length - 1].x.toFixed(1)},${bY} L${pts[0].x.toFixed(1)},${bY} Z`;
}

/** 格式化纵轴百分比刻度文本（整值去小数，非整值保留 1 位） */
export function formatPercentTick(val: number): string {
  return `${Number.isInteger(val) ? val : val.toFixed(1)}%`;
}

/** 计算均匀分布的横轴刻度索引数组（首尾必含，自动去重） */
export function computeUniformTickIndices(total: number, maxTicks: number): number[] {
  if (total <= 0) return [];
  if (total <= maxTicks) return Array.from({ length: total }, (_, i) => i);
  return [
    ...new Set(
      Array.from({ length: maxTicks }, (_, i) => Math.round((i / (maxTicks - 1)) * (total - 1)))
    ),
  ];
}

/** 将鼠标在图表容器内的水平位置映射为最近数据点索引 */
export function resolveHoverIndexFromMouse(
  e: MouseEvent<HTMLElement>,
  padLeft: number,
  plotW: number,
  count: number
): number | null {
  if (count <= 0) return null;
  if (count === 1) return 0;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - padLeft) / plotW));
  return Math.round(ratio * (count - 1));
}

/** 渐变面积填充 defs 批量声明 */
export function SvgAreaGradients({
  items,
}: {
  items: Array<{
    id: string;
    color: string;
    topOpacity?: number;
    bottomColor?: string;
    bottomOpacity?: number;
  }>;
}) {
  return (
    <defs>
      {items.map((g) => (
        <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={g.color} stopOpacity={g.topOpacity ?? 0.2} />
          <stop
            offset="100%"
            stopColor={g.bottomColor ?? g.color}
            stopOpacity={g.bottomOpacity ?? 0.01}
          />
        </linearGradient>
      ))}
    </defs>
  );
}

/** 3 档水平参考网格线 + 左/右 Y 轴刻度文本 */
export function SvgGridAxes({
  padLeft,
  padRight,
  padTop,
  plotH,
  svgWidth,
  formatLeftLabel,
  leftLabelClassName = "fill-slate-400 font-mono text-[10px] dark:fill-slate-500",
  formatRightLabel,
  rightLabelClassName = "fill-amber-600/90 font-mono text-[10px] dark:fill-amber-400/90",
  highlightRatio,
}: {
  padLeft: number;
  padRight: number;
  padTop: number;
  plotH: number;
  svgWidth: number;
  formatLeftLabel?: (ratio: number) => string | null;
  leftLabelClassName?: string;
  formatRightLabel?: (ratio: number) => string | null;
  rightLabelClassName?: string;
  highlightRatio?: number;
}) {
  return (
    <>
      {[0, 0.5, 1].map((ratio) => {
        const y = padTop + plotH * (1 - ratio);
        const isHighlight = highlightRatio !== undefined && ratio === highlightRatio;
        const leftText = formatLeftLabel ? formatLeftLabel(ratio) : null;
        const rightText = formatRightLabel ? formatRightLabel(ratio) : null;
        return (
          <g key={ratio}>
            <line
              x1={padLeft}
              y1={y}
              x2={svgWidth - padRight}
              y2={y}
              strokeDasharray={isHighlight ? "4 3" : ratio === 0 ? undefined : "3 3"}
              className={
                isHighlight
                  ? "stroke-amber-400/70 dark:stroke-amber-500/50"
                  : "stroke-slate-200/90 dark:stroke-slate-800"
              }
            />
            {leftText !== null && (
              <text
                x={padLeft - 6}
                y={y + 3.5}
                textAnchor="end"
                className={
                  isHighlight
                    ? "fill-amber-600 font-mono text-[10px] dark:fill-amber-400"
                    : leftLabelClassName
                }
              >
                {leftText}
              </text>
            )}
            {rightText !== null && (
              <text
                x={svgWidth - padRight + 6}
                y={y + 3.5}
                textAnchor="start"
                className={rightLabelClassName}
              >
                {rightText}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

/** 悬停竖向虚线准星 */
export function SvgCrosshair({
  x,
  padTop,
  plotH,
  className = "stroke-slate-400 dark:stroke-slate-500",
}: {
  x: number;
  padTop: number;
  plotH: number;
  className?: string;
}) {
  return (
    <line
      x1={x}
      y1={padTop}
      x2={x}
      y2={padTop + plotH}
      strokeDasharray="3 2"
      strokeWidth={1}
      className={className}
    />
  );
}

/** 防溢出悬浮明细浮窗 */
export function ChartFloatingTooltip({
  x,
  svgWidth,
  width,
  top = 4,
  flipRatio = 0.58,
  children,
}: {
  x: number;
  svgWidth: number;
  width: number;
  top?: number;
  flipRatio?: number;
  children: ReactNode;
}) {
  const offset = width + 10;
  const left =
    x > svgWidth * flipRatio
      ? Math.max(4, x - offset)
      : Math.min(Math.max(4, svgWidth - offset), x + 12);
  return (
    <div
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}
      className="pointer-events-none absolute z-20 rounded-lg border border-slate-200 bg-white/95 p-2 text-[11px] shadow-md backdrop-blur-xs dark:border-slate-700 dark:bg-slate-900/95"
    >
      {children}
    </div>
  );
}

/** 可点击显隐的系列图例项按钮 */
export function ChartLegendToggle({
  label,
  color,
  visible,
  onToggle,
  meta,
  title,
  dashedLine,
}: {
  label: string;
  color: string;
  visible: boolean;
  onToggle: () => void;
  meta?: string | null;
  title?: string;
  dashedLine?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={visible}
      title={title ?? `点击显示/隐藏 ${label}`}
      className={`inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium tabular-nums transition-opacity ${
        visible
          ? "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70"
          : "text-slate-400 line-through opacity-45 hover:opacity-75 dark:text-slate-500"
      }`}
    >
      {dashedLine ? (
        <span
          style={{ borderColor: color }}
          className="inline-block h-0.5 w-3 border-t-2 border-dashed"
        />
      ) : (
        <span
          style={{ backgroundColor: color }}
          className="inline-block size-2 shrink-0 rounded-full"
        />
      )}
      <span>{label}</span>
      {meta && (
        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">{meta}</span>
      )}
    </button>
  );
}

/** 统一空数据占位框 */
export function ChartEmptyBox({ message, height = 152 }: { message: string; height?: number }) {
  return (
    <div
      style={{ height: `${height}px` }}
      className="flex items-center justify-center rounded-md border border-dashed border-slate-200 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500"
    >
      {message}
    </div>
  );
}
