/**
 * Input: ModelUsageBreakdown 列表、@/lib/format 格式化工具、@/components/ModelCallChart 配色解析器与 @/components/ui 卡片组件。
 * Output: 导出 ModelBreakdownCard 模型消耗分布与占比排行榜卡片组件（对标 OpenRouter / Anthropic Usage）。
 * Pos: 挂载于看板第三行 Bento 右侧的 4 列模型占比分布卡，与左侧 TPS 曲线形成 8:4 非对称视觉节奏（src/components/ModelBreakdownCard.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { memo, useMemo } from "react";
import type { ModelUsageBreakdown } from "@/types/telemetry";
import { formatPercent, formatTokens, formatUsd } from "@/lib/format";
import { ensureDistinctColors, resolveModelStyle } from "@/components/ModelCallChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** ModelBreakdownCard 入参 */
export interface ModelBreakdownCardProps {
  byModel: ModelUsageBreakdown[]; // 当前周期按模型汇总的消耗列表
  totalCostUsd: number; // 当前周期总等效美元成本
  totalTokens: number; // 当前周期总 Token 消耗
}

/** 聚合后的模型排行条目 */
interface RankedModelRow {
  familyKey: string;
  label: string;
  color: string;
  costUsd: number;
  tokens: number;
  calls: number;
  cacheHitRate: number;
  avgTps: number;
  sharePct: number;
}

/**
 * 职责：渲染按费用降序排列的模型消耗占比分布卡（水平比例条 + 费用/Token/命中率速览）。
 * 思路：先通过 resolveModelStyle + ensureDistinctColors 归并模型并保证色值唯一，再用干净的水平填充条呈现占比层级，消除大面积空白。
 * 参数：props — byModel 列表、totalCostUsd 与 totalTokens。
 * 返回值：与 TPS 曲线卡等高呼应的 Bento 分布卡片。
 */
export const ModelBreakdownCard = memo(function ModelBreakdownCard({
  byModel,
  totalCostUsd,
  totalTokens,
}: ModelBreakdownCardProps) {
  const rows = useMemo<RankedModelRow[]>(() => {
    const map = new Map<
      string,
      {
        familyKey: string;
        label: string;
        color: string;
        costUsd: number;
        tokens: number;
        calls: number;
        cacheNum: number;
        tpsNum: number;
      }
    >();

    byModel.forEach((m, idx) => {
      const st = resolveModelStyle(m.modelName, idx);
      const cur = map.get(st.familyKey);
      if (cur) {
        cur.costUsd += m.estimatedCostUsd;
        cur.tokens += m.totalTokens;
        cur.calls += m.callCount;
        cur.cacheNum += m.cacheHitRate * m.totalTokens;
        cur.tpsNum += m.avgOutputTps * m.totalTokens;
      } else {
        map.set(st.familyKey, {
          familyKey: st.familyKey,
          label: st.shortLabel,
          color: st.color,
          costUsd: m.estimatedCostUsd,
          tokens: m.totalTokens,
          calls: m.callCount,
          cacheNum: m.cacheHitRate * m.totalTokens,
          tpsNum: m.avgOutputTps * m.totalTokens,
        });
      }
    });

    const sorted = [...map.values()].sort(
      (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens
    );
    const distinct = ensureDistinctColors(sorted);
    const denom = totalCostUsd > 0 ? totalCostUsd : Math.max(1, totalTokens);

    return distinct.map((item) => {
      const share =
        totalCostUsd > 0 ? (item.costUsd / denom) * 100 : (item.tokens / denom) * 100;
      return {
        familyKey: item.familyKey,
        label: item.label,
        color: item.color,
        costUsd: item.costUsd,
        tokens: item.tokens,
        calls: item.calls,
        cacheHitRate: item.tokens > 0 ? item.cacheNum / item.tokens : 0,
        avgTps: item.tokens > 0 ? item.tpsNum / item.tokens : 0,
        sharePct: Math.max(0, Math.min(100, share)),
      };
    });
  }, [byModel, totalCostUsd, totalTokens]);

  return (
    <Card className="flex h-full min-w-0 flex-col gap-3 py-4">
      <CardHeader className="px-5 pb-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-[13.5px] font-semibold tracking-tight text-[var(--theme-text)]">
            模型分布
          </CardTitle>
          <span className="font-mono text-[11px] text-[var(--theme-text-muted)] tabular-nums">
            {rows.length} 个模型
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-between gap-3 px-5">
        {rows.length === 0 ? (
          <div className="flex min-h-[188px] items-center justify-center rounded-xl border border-dashed border-[var(--theme-border)] text-xs text-[var(--theme-text-muted)]">
            暂无模型调用数据
          </div>
        ) : (
          <div className="space-y-3.5">
            {rows.slice(0, 6).map((row) => (
              <div key={row.familyKey} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="inline-flex min-w-0 items-center gap-2 font-medium text-[var(--theme-text)]">
                    <span
                      style={{ backgroundColor: row.color }}
                      className="size-2 shrink-0 rounded-full"
                    />
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="inline-flex shrink-0 items-baseline gap-2 font-mono tabular-nums">
                    <span className="font-semibold text-[var(--theme-text)]">
                      {formatUsd(row.costUsd)}
                    </span>
                    <span className="w-9 text-right text-[10.5px] text-[var(--theme-text-muted)]">
                      {row.sharePct >= 1 ? `${row.sharePct.toFixed(0)}%` : "<1%"}
                    </span>
                  </span>
                </div>

                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--theme-surface-muted)]">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.max(2, row.sharePct)}%`,
                      backgroundColor: row.color,
                    }}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 font-mono text-[10.5px] text-[var(--theme-text-muted)] tabular-nums">
                  <span>
                    {formatTokens(row.tokens)} · {row.calls.toLocaleString("en-US")} 轮
                  </span>
                  <span>
                    命中 {formatPercent(row.cacheHitRate)}
                    {row.avgTps > 0 ? ` · ${row.avgTps.toFixed(0)}/s` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
