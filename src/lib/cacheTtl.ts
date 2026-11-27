/**
 * Input: @/types/telemetry 中的 StepUsageRecord、CacheTtlBucket 与 CacheTtlSummary 类型定义。
 * Output: 导出缓存 TTL 实测反推引擎（analyzeStepCacheTtl、aggregateCacheTtlObservations、formatCompactGap、resolveLiveCacheWarmth）。
 * Pos: 前后端共享的 Prompt 缓存有效期（TTL）实测统计与失效节点判定纯函数模块（src/lib/cacheTtl.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import type {
  CacheTtlBucket,
  CacheTtlSummary,
  StepUsageRecord,
} from "../types/telemetry";

/** 单步相邻间隔的缓存 TTL 判定结果（供明细弹窗折线图与明细表复用） */
export interface StepCacheTtlAnnotation {
  gapMs: number | null; // 距上一步的间隔毫秒数（首步或时间无效时为 null）
  modelSwitched: boolean; // 相对上一步是否发生模型家族切换
  status: "normal" | "kept" | "expired" | "model-switch" | "compacted"; // 缓存存活状态标注
}

/** 可跨会话/跨项目累加的单条有效间隔观测样本 */
export interface CacheTtlObservation {
  gapMs: number; // 相邻同模型调用的空闲间隔（毫秒，>= 30s）
  hitRate: number; // 本步缓存命中率（0 ~ 1）
  kept: boolean; // 是否判定为缓存保活（hitRate >= 50%）
  expired: boolean; // 是否判定为缓存 TTL 失效（hitRate < 30%）
  timestamp: string; // 本步发生时间 ISO-8601
}

const MIN_SAMPLE_GAP_MS = 30_000; // 纳入 TTL 衰减统计的最小间隔（30 秒，过滤连续工具调用噪声）
const EVENT_REPORT_GAP_MS = 120_000; // 记为“上次保活”展示事件的最小空闲间隔（2 分钟）
const MIN_PREV_PROMPT_TOKENS = 10_000; // 上一步最小可缓存 Prompt 规模（排除冷启动极短首轮）
const COMPACT_SHRINK_RATIO = 0.6; // 本步 Prompt 相对上步骤降超过 40% 视为上下文压缩（/compact），排除出 TTL 失效统计
const KEPT_HIT_THRESHOLD = 0.5; // 缓存保活命中率阈值
const EXPIRED_HIT_THRESHOLD = 0.3; // 缓存断崖失效命中率阈值

/** 固定的 6 档空闲间隔分桶定义（与实测 Claude 5m / Gemini 30~60m 拐点对齐） */
const TTL_BUCKET_DEFS: ReadonlyArray<{
  key: string;
  label: string;
  minMs: number;
  maxMs: number;
}> = [
  { key: "<2m", label: "<2m", minMs: 0, maxMs: 2 * 60_000 },
  { key: "2-5m", label: "2~5m", minMs: 2 * 60_000, maxMs: 5 * 60_000 },
  { key: "5-10m", label: "5~10m", minMs: 5 * 60_000, maxMs: 10 * 60_000 },
  { key: "10-30m", label: "10~30m", minMs: 10 * 60_000, maxMs: 30 * 60_000 },
  { key: "30-60m", label: "30~60m", minMs: 30 * 60_000, maxMs: 60 * 60_000 },
  { key: ">60m", label: ">60m", minMs: 60 * 60_000, maxMs: Number.POSITIVE_INFINITY },
];

/**
 * 职责：归一化模型家族名称，用于判断相邻两步是否切换了不同模型（排除切模型导致的误报掉缓存）。
 * 参数：modelName — 原始模型名称。
 * 返回值：小写模型家族键。
 */
function normalizeModelFamily(modelName: string): string {
  return (modelName || "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * 职责：将间隔毫秒数格式化为紧凑中文/短单位文本（如 45s、4m、18m、1.2h、2.5d）。
 * 参数：ms — 间隔毫秒数。
 * 返回值：紧凑可读时长字符串。
 */
export function formatCompactGap(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || ms === null || ms === undefined || ms < 0) return "-";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const mins = ms / 60_000;
  if (mins < 60) {
    return mins < 10 && !Number.isInteger(Math.round(mins * 10) / 10)
      ? `${mins.toFixed(1)}m`
      : `${Math.round(mins)}m`;
  }
  const hours = mins / 60;
  if (hours < 24) {
    return `${hours >= 10 ? Math.round(hours) : Number(hours.toFixed(1))}h`;
  }
  const days = hours / 24;
  return `${Number(days.toFixed(1))}d`;
}

/**
 * 职责：汇总一组有效空闲间隔观测样本，生成最长保活、最短失效、最近一次事件与可选 6 档衰减分桶。
 * 思路：按时间追踪最近一次 >=2m 的保活或任意 >=30s 的失效事件，并按 6 档空闲时长计算平均缓存命中率。
 * 参数：observations — 观测样本列表；includeBuckets — 是否生成 6 档衰减折线分桶。
 * 返回值：CacheTtlSummary 汇总对象。
 */
export function aggregateCacheTtlObservations(
  observations: CacheTtlObservation[],
  includeBuckets = false
): CacheTtlSummary {
  let expiredCount = 0;
  let maxKeptGapMs: number | null = null;
  let minExpiredGapMs: number | null = null;
  const expiredGaps: number[] = [];
  let lastEventKind: "kept" | "expired" | null = null;
  let lastEventGapMs: number | null = null;
  let lastEventAt = "";
  let lastEventMs = -1;

  const bucketAcc = includeBuckets
    ? TTL_BUCKET_DEFS.map((def) => ({
        key: def.key,
        label: def.label,
        sampleCount: 0,
        keptCount: 0,
        expiredCount: 0,
        hitRateSum: 0,
      }))
    : null;

  for (const obs of observations) {
    if (obs.kept) {
      if (maxKeptGapMs === null || obs.gapMs > maxKeptGapMs) {
        maxKeptGapMs = obs.gapMs;
      }
    }
    if (obs.expired) {
      expiredCount++;
      expiredGaps.push(obs.gapMs);
      if (minExpiredGapMs === null || obs.gapMs < minExpiredGapMs) {
        minExpiredGapMs = obs.gapMs;
      }
    }

    // 最近一次有意义的 TTL 事件（任意失效，或 >=2m 的有效保活）
    const eventKind: "kept" | "expired" | null = obs.expired
      ? "expired"
      : obs.kept && obs.gapMs >= EVENT_REPORT_GAP_MS
        ? "kept"
        : null;
    if (eventKind) {
      const tsMs = Date.parse(obs.timestamp) || 0;
      if (tsMs >= lastEventMs) {
        lastEventMs = tsMs;
        lastEventKind = eventKind;
        lastEventGapMs = obs.gapMs;
        lastEventAt = obs.timestamp;
      }
    }

    if (bucketAcc) {
      const idx = TTL_BUCKET_DEFS.findIndex(
        (d) => obs.gapMs >= d.minMs && obs.gapMs < d.maxMs
      );
      if (idx >= 0) {
        const b = bucketAcc[idx];
        b.sampleCount++;
        if (obs.kept) b.keptCount++;
        if (obs.expired) b.expiredCount++;
        b.hitRateSum += obs.hitRate;
      }
    }
  }

  const buckets: CacheTtlBucket[] | undefined = bucketAcc
    ? bucketAcc.map((b) => ({
        key: b.key,
        label: b.label,
        sampleCount: b.sampleCount,
        keptCount: b.keptCount,
        expiredCount: b.expiredCount,
        avgHitRate: b.sampleCount > 0 ? b.hitRateSum / b.sampleCount : 0,
      }))
    : undefined;

  let medianExpiredGapMs: number | null = null;
  if (expiredGaps.length > 0) {
    expiredGaps.sort((a, b) => a - b);
    const mid = Math.floor(expiredGaps.length / 2);
    medianExpiredGapMs =
      expiredGaps.length % 2 === 1
        ? expiredGaps[mid]
        : Math.round((expiredGaps[mid - 1] + expiredGaps[mid]) / 2);
  }

  return {
    sampleCount: observations.length,
    expiredCount,
    maxKeptGapMs,
    minExpiredGapMs,
    medianExpiredGapMs,
    lastEventKind,
    lastEventGapMs,
    lastEventAt,
    ...(buckets ? { buckets } : {}),
  };
}

/**
 * 职责：对单个会话的推理步骤序列执行逐轮缓存 TTL 实测分析，产出单步标注、观测样本与会话级汇总。
 * 思路：1) 仅对比有效 Prompt（input+cache>0）的相邻步骤；2) 排除模型切换干扰；3) 前步 >=10K 且间隔 >=30s 纳入统计。
 * 参数：steps — 会话内按轮次排列的步骤数组；includeBuckets — 汇总对象是否附带 6 档分桶。
 * 返回值：包含 annotations（与 steps 等长）、observations 与 summary 的对象。
 */
export function analyzeStepCacheTtl(
  steps: StepUsageRecord[],
  includeBuckets = false
): {
  annotations: StepCacheTtlAnnotation[];
  observations: CacheTtlObservation[];
  summary: CacheTtlSummary;
} {
  const annotations: StepCacheTtlAnnotation[] = [];
  const observations: CacheTtlObservation[] = [];

  let prevValid: {
    tsMs: number;
    family: string;
    promptTokens: number;
    hitRate: number;
  } | null = null;

  for (const step of steps) {
    const promptTokens =
      Math.max(0, step.inputTokens || 0) + Math.max(0, step.cacheReadTokens || 0);
    const tsMs = Date.parse(step.timestamp);
    if (promptTokens <= 0 || !Number.isFinite(tsMs) || tsMs <= 0) {
      annotations.push({ gapMs: null, modelSwitched: false, status: "normal" });
      continue;
    }

    const hitRate = Math.max(0, step.cacheReadTokens || 0) / promptTokens;
    const family = normalizeModelFamily(step.modelName || step.modelId);

    if (!prevValid) {
      annotations.push({ gapMs: null, modelSwitched: false, status: "normal" });
      prevValid = { tsMs, family, promptTokens, hitRate };
      continue;
    }

    const gapMs = tsMs - prevValid.tsMs;
    if (!Number.isFinite(gapMs) || gapMs < 0) {
      annotations.push({ gapMs: null, modelSwitched: false, status: "normal" });
      prevValid = { tsMs, family, promptTokens, hitRate };
      continue;
    }

    const modelSwitched = Boolean(family && prevValid.family && family !== prevValid.family);
    const isCompacted =
      !modelSwitched &&
      prevValid.promptTokens >= MIN_PREV_PROMPT_TOKENS &&
      promptTokens < prevValid.promptTokens * COMPACT_SHRINK_RATIO;
    let status: StepCacheTtlAnnotation["status"] = modelSwitched
      ? "model-switch"
      : isCompacted
        ? "compacted"
        : "normal";

    if (
      !modelSwitched &&
      !isCompacted &&
      prevValid.promptTokens >= MIN_PREV_PROMPT_TOKENS &&
      gapMs >= MIN_SAMPLE_GAP_MS
    ) {
      const kept = hitRate >= KEPT_HIT_THRESHOLD;
      const expired = hitRate < EXPIRED_HIT_THRESHOLD;
      observations.push({
        gapMs,
        hitRate,
        kept,
        expired,
        timestamp: step.timestamp,
      });
      if (expired) {
        status = "expired";
      } else if (kept && gapMs >= EVENT_REPORT_GAP_MS) {
        status = "kept";
      }
    }

    annotations.push({ gapMs, modelSwitched, status });
    prevValid = { tsMs, family, promptTokens, hitRate };
  }

  return {
    annotations,
    observations,
    summary: aggregateCacheTtlObservations(observations, includeBuckets),
  };
}

/**
 * 职责：根据最近活跃时间与模型池实测/先验 TTL，估算当前会话缓存是否大概率仍处于热态。
 * 参数：lastModifiedAt — 会话最新活跃时间 ISO；primaryModel — 主模型名；ttl — 会话或项目实测 TTL 汇总；nowMs — 参考当前时间。
 * 返回值：{ state: "warm" | "borderline" | "cold"; idleMs: number; refTtlMs: number } | null。
 */
export function resolveLiveCacheWarmth(
  lastModifiedAt: string,
  primaryModel: string,
  ttl?: CacheTtlSummary | null,
  nowMs = Date.now()
): { state: "warm" | "borderline" | "cold"; idleMs: number; refTtlMs: number } | null {
  const lastMs = Date.parse(lastModifiedAt);
  if (!Number.isFinite(lastMs) || lastMs <= 0) return null;
  const idleMs = Math.max(0, nowMs - lastMs);
  // 超过 24 小时视为历史静默会话，不再标红扰民
  if (idleMs > 24 * 3_600_000) return null;

  const isClaude = /claude/i.test(primaryModel || "");
  const priorMs = isClaude ? 5 * 60_000 : 12 * 60_000;
  let refTtlMs = priorMs;
  const robustExpireMs = ttl?.medianExpiredGapMs ?? ttl?.minExpiredGapMs ?? null;
  if (ttl?.maxKeptGapMs && robustExpireMs && ttl.maxKeptGapMs < robustExpireMs) {
    refTtlMs = Math.round((ttl.maxKeptGapMs + robustExpireMs) / 2);
  } else if (robustExpireMs && robustExpireMs > 0) {
    refTtlMs = Math.max(priorMs * 0.6, Math.min(robustExpireMs, isClaude ? 10 * 60_000 : 45 * 60_000));
  } else if (ttl?.maxKeptGapMs && ttl.maxKeptGapMs > 0) {
    refTtlMs = Math.min(Math.max(ttl.maxKeptGapMs, priorMs), isClaude ? 10 * 60_000 : 45 * 60_000);
  }

  const state: "warm" | "borderline" | "cold" =
    idleMs <= refTtlMs * 0.75 ? "warm" : idleMs <= refTtlMs * 1.15 ? "borderline" : "cold";
  return { state, idleMs, refTtlMs };
}
