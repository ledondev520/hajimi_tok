/**
 * Input: DataSourceInfo 与 SourcePoolQuotaBadge 类型、@/lib/format 格式化工具、@/components/ui/tooltip 与 lucide-react 图标。
 * Output: 导出 SourceSwitcherBar 紧凑单行分段式多账号/多数据源切换指令条组件（支持悬浮查看各账号明细与 7d 周剩余配额）。
 * Pos: 看板顶部紧凑账号切换层，仅在发现 >=2 个本地数据源（如 T3 Code 多账号 + 原生目录）时渲染，释放首屏核心图表空间（src/components/SourceSwitcherBar.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo } from "react";
import { Info, Layers, Monitor, Users } from "lucide-react";
import type { DataSourceInfo, SourcePoolQuotaBadge } from "@/types/telemetry";
import { formatDateTime, formatPercent, formatTokens, formatUsd } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** SourceSwitcherBar 组件入参 */
export interface SourceSwitcherBarProps {
  sources: DataSourceInfo[]; // 本机发现的全部数据源及各自当前筛选下的消耗
  activeSource: string; // 当前选中源 ID（"all" 或具体 sourceId）
  onSelectSource: (sourceId: string) => void; // 切换数据源回调
}

/** 将周剩余百分比格式化为紧凑文本（整数去 .0，小数保留 1 位） */
function formatQuotaPct(pct: number): string {
  if (!Number.isFinite(pct)) return "--";
  const clamped = Math.max(0, Math.min(100, pct));
  return `${clamped.toFixed(1).replace(/\.0$/, "")}%`;
}

/** 按剩余配额比例选择语义色调（>=50% 绿、20~50% 琥珀、<20% 红） */
function quotaToneText(pct: number): string {
  if (pct >= 50) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 20) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

/** 构造单池配额详细悬浮文案 */
function formatQuotaTooltipLine(poolLabel: string, badge: SourcePoolQuotaBadge): string {
  const srcText = badge.source === "live" ? "实时" : "校准";
  const resetText = badge.resetTime ? ` · 重置 ${formatDateTime(badge.resetTime).slice(0, 11)}` : "";
  return `${poolLabel} ${formatQuotaPct(badge.remainingPct)}（${srcText}${resetText}）`;
}

/** 紧凑内联周剩余百分比标记 */
function InlineQuotaBadge({
  shortLabel,
  badge,
}: {
  shortLabel: string;
  badge: SourcePoolQuotaBadge;
}) {
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-[10px] tabular-nums">
      <span className="text-[var(--theme-text-muted)]">{shortLabel}</span>
      <span className={`font-medium ${quotaToneText(badge.remainingPct)}`}>
        {badge.source === "calibrated" ? "~" : ""}
        {formatQuotaPct(badge.remainingPct)}
      </span>
    </span>
  );
}

/**
 * 职责：渲染单行高密度的多账号分段切换指令条，替代笨重的大号账号卡片，避免与下方 KPI 指标条重复并释放首屏垂直空间。
 * 思路：1) 顶部单行圆角轨容器承载「全部账号」与各独立账号分段按钮；2) 每个账号段展示激活点、标签、类型标识、费用与迷你周剩百分比，完整明细收进 Tooltip 悬浮提示；3) 右侧收纳合并视图说明提示。
 * 参数：props — sources 数据源清单、activeSource 当前选中项、onSelectSource 切换回调。
 * 返回值：紧凑单行账号切换条节点（单源时返回 null）。
 */
export const SourceSwitcherBar = memo(function SourceSwitcherBar({
  sources,
  activeSource,
  onSelectSource,
}: SourceSwitcherBarProps) {
  if (!sources || sources.length <= 1) return null;

  const allCostUsd = sources.reduce((sum, s) => sum + s.estimatedCostUsd, 0);
  const allTokens = sources.reduce((sum, s) => sum + s.totalTokens, 0);
  const allTodayCostUsd = sources.reduce((sum, s) => sum + s.todayEstimatedCostUsd, 0);
  const allCalls = sources.reduce((sum, s) => sum + s.callCount, 0);
  const isAllActive = !activeSource || activeSource === "all";
  const hasMergedAccount = sources.some((s) => s.mergedKinds && s.mergedKinds.length > 1);

  return (
    <section
      aria-label="多账号数据源切换"
      className="theme-account-rail flex flex-wrap items-center justify-between gap-2 rounded-xl border px-2 py-1.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {/* 全部账号汇总切换项 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={isAllActive}
              onClick={() => onSelectSource("all")}
              className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-xs transition-all tabular-nums ${
                isAllActive
                  ? "border-[var(--theme-accent-border)] bg-[var(--theme-accent-soft)] font-semibold text-[var(--theme-text)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                  : "border-transparent text-[var(--theme-text-secondary)] hover:bg-[var(--theme-surface-elevated)] hover:text-[var(--theme-text)]"
              }`}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  isAllActive ? "bg-[var(--theme-accent)]" : "bg-[var(--theme-border-strong)]"
                }`}
              />
              <Users className="size-3.5 shrink-0 text-[var(--theme-text-muted)]" />
              <span>全部账号</span>
              <span className="font-mono text-[10.5px] text-[var(--theme-text-muted)]">
                {sources.length}源
              </span>
              {!isAllActive && (
                <span className="font-mono text-[11px] font-medium text-[var(--theme-text-secondary)]">
                  {formatUsd(allCostUsd)}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent className="space-y-1 p-2.5 text-[11px] tabular-nums">
            <div className="font-semibold">全部账号汇总（{sources.length} 个本地数据源）</div>
            <div className="font-mono">
              总计 {formatUsd(allCostUsd)} · {formatTokens(allTokens)} · {allCalls.toLocaleString("en-US")} 轮
            </div>
            <div className="text-[10.5px] opacity-80">
              今日 {formatUsd(allTodayCostUsd)}
              {hasMergedAccount ? " · 同账号 T3 与原生目录已自动归并" : ""}
            </div>
          </TooltipContent>
        </Tooltip>

        <span className="mx-0.5 hidden h-4 w-px bg-[var(--theme-border)] sm:inline-block" />

        {/* 各独立账号切换项 */}
        {sources.map((src) => {
          const active = activeSource === src.id;
          const isMergedT3Native = Boolean(
            src.mergedKinds?.includes("t3") && src.mergedKinds?.includes("native")
          );
          const kindLabel = isMergedT3Native
            ? "T3+原生"
            : src.kind === "t3"
              ? "T3"
              : src.kind === "native"
                ? "原生"
                : "目录";
          const gQuota = src.weeklyQuota?.gemini;
          const cQuota = src.weeklyQuota?.claude;

          return (
            <Tooltip key={src.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelectSource(src.id)}
                  className={`inline-flex h-8 max-w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-xs transition-all tabular-nums ${
                    active
                      ? "border-[var(--theme-accent-border)] bg-[var(--theme-accent-soft)] font-semibold text-[var(--theme-text)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                      : "border-transparent text-[var(--theme-text-secondary)] hover:bg-[var(--theme-surface-elevated)] hover:text-[var(--theme-text)]"
                  }`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      active ? "bg-[var(--theme-accent)]" : "bg-[var(--theme-border-strong)]"
                    }`}
                  />
                  {src.kind === "t3" ? (
                    <Layers className="size-3.5 shrink-0 text-[var(--theme-text-muted)]" />
                  ) : (
                    <Monitor className="size-3.5 shrink-0 text-[var(--theme-text-muted)]" />
                  )}
                  <span className="max-w-[150px] truncate">{src.label}</span>
                  <span className="hidden rounded bg-[var(--theme-surface-elevated)] px-1 py-0.5 font-mono text-[9.5px] leading-none text-[var(--theme-text-muted)] sm:inline">
                    {kindLabel}
                  </span>
                  <span className="font-mono text-[11px] font-medium text-[var(--theme-text)]">
                    {formatUsd(src.estimatedCostUsd)}
                  </span>
                  {(gQuota || cQuota) && (
                    <span className="hidden items-center gap-1.5 border-l border-[var(--theme-border)] pl-2 md:inline-flex">
                      {gQuota && <InlineQuotaBadge shortLabel="G" badge={gQuota} />}
                      {cQuota && <InlineQuotaBadge shortLabel="C" badge={cQuota} />}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="space-y-1 p-2.5 text-[11px] tabular-nums">
                <div className="flex items-center justify-between gap-4 font-semibold">
                  <span>{src.label}</span>
                  <span className="font-mono text-[10px] opacity-75">{kindLabel}</span>
                </div>
                <div className="font-mono">
                  {formatUsd(src.estimatedCostUsd)} · {formatTokens(src.totalTokens)} · 今日{" "}
                  {formatUsd(src.todayEstimatedCostUsd)}
                </div>
                <div className="text-[10.5px] opacity-85">
                  缓存命中 {formatPercent(src.cacheHitRate)} · {src.callCount.toLocaleString("en-US")} 轮调用
                </div>
                {(gQuota || cQuota) && (
                  <div className="space-y-0.5 border-t border-white/15 pt-1 font-mono text-[10px] opacity-90">
                    {gQuota && <div>{formatQuotaTooltipLine("Gemini 7d", gQuota)}</div>}
                    {cQuota && <div>{formatQuotaTooltipLine("Claude 7d", cQuota)}</div>}
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* 右侧极简状态提示（仅桌面宽屏显示，零垂直占用） */}
      {isAllActive && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="hidden cursor-default items-center gap-1 pr-1.5 text-[11px] text-[var(--theme-text-muted)] xl:inline-flex">
              <Info className="size-3 shrink-0 opacity-75" />
              <span>点选单账号查独立配额</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-[11px]">
            {hasMergedAccount
              ? "当前为本机多账号合并视图（同账号的 T3 与原生目录已自动归并），点选单个账号可查看独立 5h / 7d 窗口与周校准。"
              : "当前为本机多账号合并视图，点选左侧单个账号可查看其独立 5h / 7d 配额窗口与周校准。"}
          </TooltipContent>
        </Tooltip>
      )}
    </section>
  );
});
