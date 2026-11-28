/**
 * Input: 依赖 src/types/telemetry.ts 中的 ModelPriceRate 领域类型定义。
 * Output: 导出 DEFAULT_MODEL_PRICING 官方 API 费率表、matchModelRate 费率匹配器与 calculateStepCost 单步成本计算函数。
 * Pos: 服务端等效 API 成本估算与 Prompt 缓存节省金额核算模块（对齐 Google / Anthropic 官方公开 API 牌价）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import type { ModelPriceRate } from "../src/types/telemetry";

const TOKENS_PER_MILLION = 1_000_000; // 每百万 Token 换算基数

/**
 * AntiGravity 常见模型官方 API 标准单价表（USD / 1M Tokens，按具体型号优先顺序匹配）。
 * 来源核验（2026-11）：
 * - Google Gemini API / Vertex AI：Neon $3/$0.15/$15、Hydrogen $1.5/$0.075/$7.5、Argon/Carbon $2/$0.10/$10、3.1 Pro $2/$0.20/$12、3.8 Flash $0.75/$0.075/$3.75、2.5 Pro $1.25/$0.125/$10
 * - Anthropic Claude API：Fable 5 $10/$1/$50、Opus 5.5 $4/$0.20/$20、Opus 5/4.6~4.8 $5/$0.50/$25、Sonnet 5.5 $2/$0.10/$10、Sonnet 5 $2/$0.20/$10、Sonnet 4.6 $3/$0.30/$15、Haiku 4.5 $1/$0.10/$5
 */
export const DEFAULT_MODEL_PRICING: ModelPriceRate[] = [
  {
    modelPattern: "fable",
    label: "Claude Fable 5",
    inputPerMillion: 10.0,
    cacheReadPerMillion: 1.0,
    outputPerMillion: 50.0,
  },
  {
    modelPattern: "opus 5.5",
    label: "Claude Opus 5.5",
    inputPerMillion: 4.0,
    cacheReadPerMillion: 0.2,
    outputPerMillion: 20.0,
  },
  {
    modelPattern: "opus",
    label: "Claude Opus",
    inputPerMillion: 5.0,
    cacheReadPerMillion: 0.5,
    outputPerMillion: 25.0,
  },
  {
    modelPattern: "sonnet 5.5",
    label: "Claude Sonnet 5.5",
    inputPerMillion: 2.0,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10.0,
  },
  {
    modelPattern: "sonnet 5",
    label: "Claude Sonnet 5",
    inputPerMillion: 2.0,
    cacheReadPerMillion: 0.2,
    outputPerMillion: 10.0,
  },
  {
    modelPattern: "sonnet",
    label: "Claude Sonnet",
    inputPerMillion: 3.0,
    cacheReadPerMillion: 0.3,
    outputPerMillion: 15.0,
  },
  {
    modelPattern: "haiku",
    label: "Claude Haiku 4.5",
    inputPerMillion: 1.0,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 5.0,
  },
  {
    modelPattern: "neon",
    label: "Gemini 4 Neon",
    inputPerMillion: 3.0,
    cacheReadPerMillion: 0.15,
    outputPerMillion: 15.0,
  },
  {
    modelPattern: "hydrogen",
    label: "Gemini 4 Hydrogen",
    inputPerMillion: 1.5,
    cacheReadPerMillion: 0.075,
    outputPerMillion: 7.5,
  },
  {
    modelPattern: "argon",
    label: "Gemini 4 Argon",
    inputPerMillion: 2.0,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10.0,
  },
  {
    modelPattern: "carbon",
    label: "Gemini 4 Carbon",
    inputPerMillion: 2.0,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10.0,
  },
  {
    modelPattern: "3.1 pro",
    label: "Gemini 3.1 Pro",
    inputPerMillion: 2.0,
    cacheReadPerMillion: 0.2,
    outputPerMillion: 12.0,
  },
  {
    modelPattern: "3.8 flash",
    label: "Gemini 3.8 Flash",
    inputPerMillion: 0.75,
    cacheReadPerMillion: 0.075,
    outputPerMillion: 3.75,
  },
  {
    modelPattern: "pro",
    label: "Gemini Pro",
    inputPerMillion: 1.25,
    cacheReadPerMillion: 0.125,
    outputPerMillion: 10.0,
  },
  {
    modelPattern: "flash-lite",
    label: "Gemini Flash-Lite",
    inputPerMillion: 0.1,
    cacheReadPerMillion: 0.025,
    outputPerMillion: 0.4,
  },
  {
    modelPattern: "flash",
    label: "Gemini Flash",
    inputPerMillion: 0.3,
    cacheReadPerMillion: 0.075,
    outputPerMillion: 2.5,
  },
  {
    modelPattern: "*",
    label: "Default Fallback",
    inputPerMillion: 2.0,
    cacheReadPerMillion: 0.1,
    outputPerMillion: 10.0,
  },
];

/** 归一化模型匹配键：统一小写、将版本号间 `-`/`_` 转为小数点并折叠分隔符，兼容 `opus-5-5` 与 `Opus 5.5` */
function normalizeModelKey(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/(\d)[-_](\d)/g, "$1.$2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 职责：根据可读模型名与内部模型 ID 匹配对应的百万 Token 费率配置。
 * 思路：将 modelName 与 modelId 归一化合并后，先顺序匹配所有非 "*" 的具体规则，最后回退至 "*" 通配项。
 * 参数：modelName — 可读模型名；modelId — 内部模型 ID；rates — 可选自定义费率表。
 * 返回值：命中的 ModelPriceRate 单价对象。
 */
export function matchModelRate(
  modelName: string,
  modelId: string,
  rates: ModelPriceRate[] = DEFAULT_MODEL_PRICING,
): ModelPriceRate {
  const activeRates = rates.length > 0 ? rates : DEFAULT_MODEL_PRICING;
  const haystack = normalizeModelKey(`${modelName || ""} ${modelId || ""}`);

  for (const rate of activeRates) {
    const pattern = normalizeModelKey(rate.modelPattern);
    if (!pattern || pattern === "*") continue;
    if (haystack.includes(pattern)) {
      return rate;
    }
  }

  const wildcard = activeRates.find((r) => r.modelPattern.trim() === "*");
  return wildcard ?? DEFAULT_MODEL_PRICING[DEFAULT_MODEL_PRICING.length - 1];
}

/**
 * 职责：根据单步输入、缓存读取与输出 Token 数量核算等效 API 成本及缓存节省成本。
 * 思路：
 *   1) 对三类 Token 计数做非负保护；
 *   2) 等效成本 = (input * inputRate + cacheRead * cacheReadRate + output * outputRate) / 1e6；
 *   3) 缓存节省 = max(0, cacheRead * (inputRate - cacheReadRate) / 1e6)。
 * 参数：inputTokens — 新增未缓存输入；cacheReadTokens — 缓存命中读取；outputTokens — 总输出；rate — 模型单价。
 * 返回值：包含 estimatedCostUsd 与 cacheSavedUsd 的金额对象（单位 USD）。
 */
export function calculateStepCost(
  inputTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
  rate: ModelPriceRate,
): { estimatedCostUsd: number; cacheSavedUsd: number } {
  const safeInput = Math.max(0, Number.isFinite(inputTokens) ? inputTokens : 0);
  const safeCacheRead = Math.max(0, Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0);
  const safeOutput = Math.max(0, Number.isFinite(outputTokens) ? outputTokens : 0);

  const estimatedCostUsd =
    (safeInput * rate.inputPerMillion +
      safeCacheRead * rate.cacheReadPerMillion +
      safeOutput * rate.outputPerMillion) /
    TOKENS_PER_MILLION;

  const unitSavings = Math.max(0, rate.inputPerMillion - rate.cacheReadPerMillion);
  const cacheSavedUsd = (safeCacheRead * unitSavings) / TOKENS_PER_MILLION;

  return { estimatedCostUsd, cacheSavedUsd };
}
