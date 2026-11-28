/**
 * Input: 原始模型名称与模型 ID 字符串。
 * Output: 导出统一的模型池判定（Claude / Gemini / 其他）、模型过滤匹配、紧凑短名与固定视觉配色解析器。
 * Pos: 前后端共用的模型家族与配额池唯一真源（src/lib/models.ts），消除服务端与前端多处重复正则与漂移风险。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

export type ModelPoolKind = "claude" | "gemini" | "other";

export interface ModelSeriesStyle {
  familyKey: string;
  shortLabel: string;
  color: string;
  poolTokens: number;
  avgTps: number;
  avgCacheHitRate?: number;
}

const FALLBACK_COLORS = ["#6366f1", "#0ea5e9", "#14b8a6", "#f97316"];
const CLAUDE_TOKENS = ["claude", "opus", "sonnet", "haiku", "anthropic"];
const GEMINI_TOKENS = ["gemini", "argon", "carbon", "neon", "hydrogen", "flash"];

/** 剥离模型名称末尾的推理档位括号后缀（如 "(High)"、"(Medium)"） */
export function stripModelReasoningSuffix(modelName: string): string {
  return (modelName || "Unknown").replace(/\s*\([^)]*\)\s*$/g, "").trim();
}

/** 剥离模型前缀（如 "Claude " / "Gemini 4 "），保留档位后缀供紧凑表格/明细展示 */
export function stripModelBrandPrefix(modelName: string): string {
  return (modelName || "Unknown").replace(/^Claude\s+|^Gemini\s+\d+(?:\.\d+)?\s+/i, "").trim() || "Unknown";
}

/** 判定模型文本所属配额池（claude / gemini / other） */
export function resolveModelPool(text: string): ModelPoolKind {
  const lower = (text || "").toLowerCase();
  if (CLAUDE_TOKENS.some((t) => lower.includes(t))) return "claude";
  if (GEMINI_TOKENS.some((t) => lower.includes(t))) return "gemini";
  return "other";
}

/** 判断模型名称或模型 ID 是否命中配额池（pool:claude / pool:gemini）或关键字过滤 */
export function matchesModelQuery(modelName: string, modelId: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${modelName} ${modelId}`.toLowerCase();
  if (needle === "pool:claude") return resolveModelPool(hay) === "claude";
  if (needle === "pool:gemini") return resolveModelPool(hay) === "gemini";
  return hay.includes(needle);
}

/** 提取紧凑模型短名（去代际前缀与推理档位后缀） */
export function formatCompactModelName(modelName: string): string {
  const base = stripModelReasoningSuffix(modelName);
  const lower = base.toLowerCase();
  if (lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    return base.replace(/^claude\s+/i, "").trim();
  }
  if (resolveModelPool(lower) === "gemini") {
    return lower.includes("flash")
      ? "Flash"
      : base.replace(/^gemini\s+\d+(?:\.\d+)?\s+/i, "").trim() || base;
  }
  return base || "Unknown";
}

/** 将原始模型全称提炼为去前缀紧凑家族键、图例短名与高辨识度固定色值 */
export function resolveModelStyle(modelName: string, fallbackIndex = 0): ModelSeriesStyle {
  const base = stripModelReasoningSuffix(modelName);
  const lower = base.toLowerCase();
  const shortLabel = formatCompactModelName(modelName);

  if (lower.includes("opus")) {
    return { familyKey: shortLabel.toLowerCase(), shortLabel, color: "#8b5cf6", poolTokens: 0, avgTps: 0 };
  }
  if (lower.includes("sonnet")) {
    return { familyKey: shortLabel.toLowerCase(), shortLabel, color: "#f59e0b", poolTokens: 0, avgTps: 0 };
  }
  if (lower.includes("haiku")) {
    return { familyKey: shortLabel.toLowerCase(), shortLabel, color: "#ec4899", poolTokens: 0, avgTps: 0 };
  }
  if (resolveModelPool(lower) === "gemini") {
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
