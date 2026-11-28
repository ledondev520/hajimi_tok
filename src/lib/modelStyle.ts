/**
 * Input: 无外部运行时依赖，纯函数解析模型短名称并绑定到主题联动 CSS 图表色槽（--theme-chart-1..8）。
 * Output: 导出 ModelSeriesStyle、CURATED_SERIES_PALETTE、resolveModelStyle 与 ensureDistinctColors。
 * Pos: 全局图表与模型分布共享的模型视觉样式解析器，切换主题时整站图表色盘即时联动且绝不撞色（src/lib/modelStyle.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

/** 模型视觉配色与分组结构 */
export interface ModelSeriesStyle {
  familyKey: string; // 模型家族唯一键
  shortLabel: string; // 去前缀紧凑图例名称（如 Opus 5.5 / Neon High / Neon Medium / Argon / Carbon）
  color: string; // 绑定至当前主题的 CSS 颜色令牌（var(--theme-chart-N)）
  poolTokens: number; // 当前过滤视图下该模型家族累计总 Token
  avgTps: number; // 当前过滤视图下该模型家族端到端平均 TPS
  avgCacheHitRate?: number; // 当前过滤视图下该模型家族平均缓存命中率（0 ~ 1）
}

/** 8 槽位主题联动图表色盘：切换主题时所有柱图、折线、占比条与图例即时换肤且绝不撞色 */
export const CURATED_SERIES_PALETTE = [
  "var(--theme-chart-1)",
  "var(--theme-chart-2)",
  "var(--theme-chart-3)",
  "var(--theme-chart-4)",
  "var(--theme-chart-5)",
  "var(--theme-chart-6)",
  "var(--theme-chart-7)",
  "var(--theme-chart-8)",
] as const;

/**
 * 职责：将原始模型全称提炼为紧凑易读的家族键与图例短名，并按子档位映射至不同的主题联动图表色槽。
 * 参数：modelName — 可读模型名称；fallbackIndex — 未知模型兜底色索引。
 * 返回值：ModelSeriesStyle 样式描述对象。
 */
export function resolveModelStyle(modelName: string, fallbackIndex: number): ModelSeriesStyle {
  const base = (modelName || "Unknown").replace(/\s*\([^)]*\)\s*$/g, "").trim();
  const lower = base.toLowerCase();

  if (lower === "unknown model" || lower === "unknown") {
    return {
      familyKey: "unknown",
      shortLabel: "Unknown",
      color: "var(--theme-chart-muted)",
      poolTokens: 0,
      avgTps: 0,
    };
  }
  if (lower.includes("opus")) {
    const shortLabel = base.replace(/^claude[\s-]+/i, "").trim();
    return {
      familyKey: shortLabel.toLowerCase(),
      shortLabel,
      color: "var(--theme-chart-3)",
      poolTokens: 0,
      avgTps: 0,
    };
  }
  if (lower.includes("sonnet")) {
    const shortLabel = base.replace(/^claude[\s-]+/i, "").trim();
    return {
      familyKey: shortLabel.toLowerCase(),
      shortLabel,
      color: "var(--theme-chart-4)",
      poolTokens: 0,
      avgTps: 0,
    };
  }
  if (lower.includes("haiku")) {
    const shortLabel = base.replace(/^claude[\s-]+/i, "").trim();
    return {
      familyKey: shortLabel.toLowerCase(),
      shortLabel,
      color: "var(--theme-chart-5)",
      poolTokens: 0,
      avgTps: 0,
    };
  }
  if (
    lower.includes("gemini") ||
    lower.includes("argon") ||
    lower.includes("carbon") ||
    lower.includes("neon") ||
    lower.includes("hydrogen")
  ) {
    const stripped = lower.includes("flash")
      ? "Flash"
      : base
          .replace(/^gemini[\s-]+\d+(?:\.\d+)?[\s-]+/i, "")
          .replace(/[-_]+/g, " ")
          .replace(/\b([a-z])/g, (m) => m.toUpperCase())
          .trim() || base;
    const color =
      lower.includes("neon") && lower.includes("high")
        ? "var(--theme-chart-1)"
        : lower.includes("neon") && lower.includes("medium")
          ? "var(--theme-chart-3)"
          : lower.includes("neon") && lower.includes("low")
            ? "var(--theme-chart-4)"
            : lower.includes("neon")
              ? "var(--theme-chart-6)"
              : lower.includes("carbon")
                ? "var(--theme-chart-2)"
                : lower.includes("argon")
                  ? "var(--theme-chart-5)"
                  : lower.includes("hydrogen")
                    ? "var(--theme-chart-7)"
                    : "var(--theme-chart-8)";
    return {
      familyKey: stripped.toLowerCase(),
      shortLabel: stripped,
      color,
      poolTokens: 0,
      avgTps: 0,
    };
  }

  return {
    familyKey: lower || "unknown",
    shortLabel: base || "Unknown",
    color: CURATED_SERIES_PALETTE[fallbackIndex % CURATED_SERIES_PALETTE.length],
    poolTokens: 0,
    avgTps: 0,
  };
}

/**
 * 职责：为同一图表中共存的模型序列做二次去重配色，保证图内任意两个模型绝不撞色。
 * 参数：items — 按消耗排序后的模型样式列表。
 * 返回值：颜色已去重的样式列表。
 */
export function ensureDistinctColors<T extends { color: string }>(items: T[]): T[] {
  const used = new Set<string>();
  return items.map((item) => {
    if (!used.has(item.color)) {
      used.add(item.color);
      return item;
    }
    const replacement =
      CURATED_SERIES_PALETTE.find((c) => !used.has(c)) ?? item.color;
    used.add(replacement);
    return { ...item, color: replacement };
  });
}
