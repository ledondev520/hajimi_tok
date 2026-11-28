/**
 * Input: DataSourceInfo 类型、@/lib/format 格式化工具与 lucide-react 图标。
 * Output: 导出 SourceSwitcherBar 多账号/多数据源切换与费用速览栏组件（自适应桌面与手机端窄屏）。
 * Pos: 看板多数据源切换与各账号消耗对比层，仅在发现 >=2 个本地数据源（如 T3 Code 多账号 + 原生目录）时渲染。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo } from "react";
import { Layers, Monitor, Users } from "lucide-react";
import type { DataSourceInfo } from "@/types/telemetry";
import { formatPercent, formatTokens, formatUsd } from "@/lib/format";

/** SourceSwitcherBar 组件入参 */
export interface SourceSwitcherBarProps {
  sources: DataSourceInfo[]; // 本机发现的全部数据源及各自当前筛选下的消耗
  activeSource: string; // 当前选中源 ID（"all" 或具体 sourceId）
  onSelectSource: (sourceId: string) => void; // 切换数据源回调
}

/**
 * 职责：渲染「全部账号汇总」与每个独立账号/数据源的紧凑对比卡片，支持一键切换查看单账号独立配额与明细。
 * 思路：手机端 390px 宽度采用 2 列网格、桌面端自动延展为 3~4 列，确保多账号总费用与今日费用一屏可见且点击热区充足。
 * 参数：props — sources 数据源清单、activeSource 当前选中项、onSelectSource 切换回调。
 * 返回值：多数据源切换栏节点（单源时返回 null）。
 */
export const SourceSwitcherBar = memo(function SourceSwitcherBar({
  sources,
  activeSource,
  onSelectSource,
}: SourceSwitcherBarProps) {
  if (!sources || sources.length <= 1) return null;

  // 0. 计算全源合计数值供「全部账号」总览卡展示
  const allCostUsd = sources.reduce((sum, s) => sum + s.estimatedCostUsd, 0);
  const allTokens = sources.reduce((sum, s) => sum + s.totalTokens, 0);
  const allTodayCostUsd = sources.reduce((sum, s) => sum + s.todayEstimatedCostUsd, 0);
  const allCalls = sources.reduce((sum, s) => sum + s.callCount, 0);
  const isAllActive = !activeSource || activeSource === "all";

  return (
    <section aria-label="多账号数据源切换" className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <button
          type="button"
          aria-pressed={isAllActive}
          onClick={() => onSelectSource("all")}
          className={`flex min-h-[72px] flex-col justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
            isAllActive
              ? "border-indigo-500/70 bg-indigo-50/70 text-slate-900 shadow-2xs dark:border-indigo-400/70 dark:bg-indigo-950/40 dark:text-slate-50"
              : "border-slate-200/90 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-slate-700"
          }`}
        >
          <div className="flex items-center justify-between gap-1.5">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold">
              <Users className="size-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
              <span className="truncate">全部账号</span>
            </span>
            <span className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 tabular-nums dark:bg-slate-800 dark:text-slate-300">
              {sources.length} 个源
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2 tabular-nums">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {formatUsd(allCostUsd)}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {formatTokens(allTokens)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-1 text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
            <span>今日 {formatUsd(allTodayCostUsd)}</span>
            <span>{allCalls.toLocaleString("en-US")} 次</span>
          </div>
        </button>

        {sources.map((src) => {
          const active = activeSource === src.id;
          const kindLabel = src.kind === "t3" ? "T3" : src.kind === "native" ? "原生" : "目录";
          return (
            <button
              key={src.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelectSource(src.id)}
              className={`flex min-h-[72px] flex-col justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-indigo-500/70 bg-indigo-50/70 text-slate-900 shadow-2xs dark:border-indigo-400/70 dark:bg-indigo-950/40 dark:text-slate-50"
                  : "border-slate-200/90 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-slate-700"
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold">
                  {src.kind === "t3" ? (
                    <Layers className="size-3.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
                  ) : (
                    <Monitor className="size-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
                  )}
                  <span className="truncate">{src.label}</span>
                </span>
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {kindLabel}
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2 tabular-nums">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {formatUsd(src.estimatedCostUsd)}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {formatTokens(src.totalTokens)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-1 text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
                <span>今日 {formatUsd(src.todayEstimatedCostUsd)}</span>
                <span>命中 {formatPercent(src.cacheHitRate)}</span>
              </div>
            </button>
          );
        })}
      </div>

      {isAllActive && (
        <p className="px-0.5 text-[11px] text-slate-500 dark:text-slate-400">
          当前为本机多账号合并视图，点选上方单个账号可查看其独立 5h / 7d 配额窗口与周校准。
        </p>
      )}
    </section>
  );
});
