/**
 * Input: 依赖 src/types/telemetry.ts 中的 ModelPriceRate 领域类型定义。
 * Output: 导出 DEFAULT_MODEL_PRICING 默认模型费率表、matchModelRate 费率匹配器与 calculateStepCost 单步成本计算函数。
 * Pos: 服务端等效 API 成本估算与 Prompt 缓存节省金额核算模块。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import type { ModelPriceRate } from "../src/types/telemetry";

const TOKENS_PER_MILLION = 1_000_000; // 每百万 Token 换算基数

/** AntiGravity 常见模型等效 API 参考单价表（USD / 1M Tokens） */
export const DEFAULT_MODEL_PRICING: ModelPriceRate[] = [
  {
    modelPattern: "opus",
    label: "Claude Opus",
    inputPerMillion: 15.0,
    cacheReadPerMillion: 1.5,
    outputPerMillion: 75.0,
  },
  {
    modelPattern: "sonnet",
    label: "Claude Sonnet",
    inputPerMillion: 3.0,
    cacheReadPerMillion: 0.3,
    outputPerMillion: 15.0,
  },
  {
    modelPattern: "argon",
    label: "Gemini 4 Argon",
    inputPerMillion: 1.25,
    cacheReadPerMillion: 0.31,
    outputPerMillion: 10.0,
  },
  {
    modelPattern: "carbon",
    label: "Gemini 4 Carbon",
    inputPerMillion: 1.25,
    cacheReadPerMillion: 0.31,
    outputPerMillion: 10.0,
  },
  {
    modelPattern: "pro",
    label: "Gemini Pro",
    inputPerMillion: 1.25,
    cacheReadPerMillion: 0.31,
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
    inputPerMillion: 1.25,
    cacheReadPerMillion: 0.31,
    outputPerMillion: 10.0,
  },
];

/**
 * 职责：根据可读模型名与内部模型 ID 匹配对应的百万 Token 费率配置。
 * 思路：将 modelName 与 modelId 合并转小写后，先顺序匹配所有非 "*" 的具体规则，最后回退至 "*" 通配项。
 * 参数：modelName — 可读模型名；modelId — 内部模型 ID；rates — 可选自定义费率表。
 * 返回值：命中的 ModelPriceRate 单价对象。
 */
export function matchModelRate(
  modelName: string,
  modelId: string,
  rates: ModelPriceRate[] = DEFAULT_MODEL_PRICING,
): ModelPriceRate {
  // 0. 拼接并归一化待检索的模型文本及可用规则表
  const activeRates = rates.length > 0 ? rates : DEFAULT_MODEL_PRICING; // 有效费率配置列表
  const haystack = `${modelName || ""} ${modelId || ""}`.toLowerCase(); // 大小写无关匹配源串

  // 1. 优先按顺序检查所有非通配符（modelPattern !== "*"）的具体关键字
  for (const rate of activeRates) {
    const pattern = rate.modelPattern.trim().toLowerCase();
    if (!pattern || pattern === "*") continue;
    if (haystack.includes(pattern)) {
      return rate;
    }
  }

  // 2. 未命中具体规则时，查找通配符 "*" 兜底项或默认表末项
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
  // 0. 归一化非负 Token 计数
  const safeInput = Math.max(0, Number.isFinite(inputTokens) ? inputTokens : 0);
  const safeCacheRead = Math.max(0, Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0);
  const safeOutput = Math.max(0, Number.isFinite(outputTokens) ? outputTokens : 0);

  // 1. 计算实际等效 API 消耗成本与因缓存免除的全额输入差价
  const estimatedCostUsd =
    (safeInput * rate.inputPerMillion +
      safeCacheRead * rate.cacheReadPerMillion +
      safeOutput * rate.outputPerMillion) /
    TOKENS_PER_MILLION;

  const unitSavings = Math.max(0, rate.inputPerMillion - rate.cacheReadPerMillion);
  const cacheSavedUsd = (safeCacheRead * unitSavings) / TOKENS_PER_MILLION;

  return { estimatedCostUsd, cacheSavedUsd };
}
