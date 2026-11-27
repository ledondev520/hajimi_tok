/**
 * Input: @/types/telemetry 中的 DashboardSummaryPayload、ConversationDetail、StepUsageRecord 与 ModelPriceRate 类型定义。
 * Output: 导出 Token 数量、精确整数、USD 金额、百分比、耗时、本地时间格式化函数，会话单步缓存率序列构造、上下文水位评估、周配额满额反算，以及自定义单价持久化与全量重算纯函数。
 * Pos: 前端通用数值格式化与等效 API 成本实时重算核心工具模块（src/lib/format.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import type {
  ConversationDetail,
  DashboardSummaryPayload,
  ModelPriceRate,
  QuotaResetEvent,
  StepUsageRecord,
  WeeklyQuotaCalibration,
} from "@/types/telemetry";

export type { WeeklyQuotaCalibration };

/** 浏览器端持久化用户自定义单价表的 localStorage 键名 */
export const CUSTOM_PRICING_STORAGE_KEY = "agy_custom_pricing_v1";

/** 兜底默认单价配置（当单价列表为空时使用） */
const FALLBACK_PRICE_RATE: ModelPriceRate = {
  modelPattern: "*",
  label: "Default Fallback",
  inputPerMillion: 2.5,
  cacheReadPerMillion: 0.25,
  outputPerMillion: 10,
};

/**
 * 职责：将整数格式化为带千分位逗号的精确字符串。
 * 参数：n — 待格式化的 Token 或调用次数数值。
 * 返回值：带英文千分位分隔符的整数文本（如 "8,452,814"）。
 */
export function formatExactNumber(n: number): string {
  // 0. 过滤非有限数值并取整输出
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

/**
 * 职责：将大额 Token 数值格式化为紧凑可读单位（B / M / K 或精确整数）。
 * 思路：>=1B 保留两位小数，>=1M 保留两位小数，>=1K 保留一位小数，<1000 直接展示整数。
 * 参数：n — Token 数量。
 * 返回值：紧凑格式化字符串（如 "8.45M"、"429.5K"、"512"）。
 */
export function formatTokens(n: number): string {
  // 0. 处理异常值与负数边界
  if (!Number.isFinite(n) || n <= 0) return "0";
  // 1.1. 按十亿、百万、千三级量纲缩放
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * 职责：将美元金额格式化为标准可读文本，兼顾微额调用成本精度。
 * 参数：usd — 美元金额（USD）。
 * 返回值：带 $ 前缀的金额字符串（如 "$12.48"、"$0.0042"、"$0.00"）。
 */
export function formatUsd(usd: number): string {
  // 0. 零值或异常值统一返回 $0.00
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  // 1.1. 极小正数与分以下金额保留高精度
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  // 1.2. 大额带千分位逗号，常规金额保留两位小数
  if (usd >= 1_000) {
    return `$${usd.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * 职责：将 0~1 比例值格式化为保留一位小数的百分比文本。
 * 参数：ratio — 比例值（如 0.948）。
 * 返回值：百分比字符串（如 "94.8%"）。
 */
export function formatPercent(ratio: number): string {
  // 0. 非有限值归零处理
  if (!Number.isFinite(ratio) || ratio <= 0) return "0.0%";
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * 职责：根据未命中缓存输入与缓存读取 Token 计算 Prompt 缓存命中率（0 ~ 1）。
 * 参数：inputTokens — 新增未缓存输入 Token；cacheReadTokens — 命中缓存读取 Token。
 * 返回值：0 ~ 1 之间的命中率比例，总输入为 0 时返回 0。
 */
export function calcCacheHitRate(inputTokens: number, cacheReadTokens: number): number {
  const safeInput = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeCache = Number.isFinite(cacheReadTokens) && cacheReadTokens > 0 ? cacheReadTokens : 0;
  const promptTotal = safeInput + safeCache;
  return promptTotal > 0 ? safeCache / promptTotal : 0;
}

/** 单个会话逐轮缓存命中率折线数据点 */
export interface StepCacheRatePoint {
  step: StepUsageRecord; // 原始单步遥测记录
  stepRate: number; // 本步 Prompt 缓存命中率（0 ~ 1）
  cumulativeRate: number; // 截至本步的会话累计缓存命中率（0 ~ 1）
}

/**
 * 职责：将单个会话的单步推理序列转换为逐轮与累计缓存命中率折线数据。
 * 思路：按步骤顺序计算每步独立缓存率，并同步累加输入与缓存读取 Token 以推导会话累计缓存率曲线及极值。
 * 参数：steps — 会话内按轮次升序排列的推理步骤数组。
 * 返回值：包含逐轮节点列表 points 与步级极值 minRate / maxRate 的序列结构。
 */
export function buildStepCacheRateSeries(steps: StepUsageRecord[]): {
  points: StepCacheRatePoint[];
  minRate: number;
  maxRate: number;
} {
  // 0. 空步骤返回空序列
  if (steps.length === 0) {
    return { points: [], minRate: 0, maxRate: 0 };
  }

  let cumInput = 0; // 截至当前步的累计未缓存输入 Token
  let cumCache = 0; // 截至当前步的累计缓存读取 Token
  let minRate = 1; // 步级最低缓存命中率
  let maxRate = 0; // 步级最高缓存命中率

  // 1.1. 遍历每步计算单步与累计命中率（跳过尚无输入 Token 的在途/空步骤，避免 0/0 伪造 0% 跌零）
  const points: StepCacheRatePoint[] = [];
  for (const step of steps) {
    const safeIn = Number.isFinite(step.inputTokens) && step.inputTokens > 0 ? step.inputTokens : 0;
    const safeCache =
      Number.isFinite(step.cacheReadTokens) && step.cacheReadTokens > 0 ? step.cacheReadTokens : 0;
    if (safeIn + safeCache <= 0) continue;
    const stepRate = calcCacheHitRate(safeIn, safeCache);
    cumInput += safeIn;
    cumCache += safeCache;
    const cumulativeRate = calcCacheHitRate(cumInput, cumCache);
    if (stepRate < minRate) minRate = stepRate;
    if (stepRate > maxRate) maxRate = stepRate;
    points.push({ step, stepRate, cumulativeRate });
  }

  return points.length === 0 ? { points: [], minRate: 0, maxRate: 0 } : { points, minRate, maxRate };
}

/** 会话上下文水位健康评估结果 */
export interface ContextHealthInfo {
  level: "ok" | "warn" | "high"; // ok: 正常；warn: >=250K 或 >=50%；high: >=350K 或 >=70%
  used: number; // 当前上下文 Token 数
  limit: number; // 上下文窗口上限（未知为 0）
  ratio: number; // 占用比例（0 ~ 1，无上限时为 0）
}

/**
 * 职责：评估单个会话当前上下文是否偏胖，用于看板列表与详情弹窗提示 /compact 或开新会话。
 * 参数：used — 当前上下文占用 Token；limit — 模型上下文上限。
 * 返回值：ContextHealthInfo 水位等级与占用比例。
 */
export function resolveContextHealth(used: number, limit: number): ContextHealthInfo {
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  const ratio = safeLimit > 0 ? safeUsed / safeLimit : 0;
  if (safeUsed >= 350_000 || ratio >= 0.7) {
    return { level: "high", used: safeUsed, limit: safeLimit, ratio };
  }
  if (safeUsed >= 250_000 || ratio >= 0.5) {
    return { level: "warn", used: safeUsed, limit: safeLimit, ratio };
  }
  return { level: "ok", used: safeUsed, limit: safeLimit, ratio };
}

/** 周满额反算与实时剩余推算结果 */
export interface WeeklyQuotaProjection {
  fullCostUsd: number; // 反算 100% 周满额等效 API 金额（USD）
  fullTokens: number; // 反算 100% 周满额总 Token
  estimatedRemainingPct: number; // 基于当前实时消耗推算的剩余百分比（0 ~ 100）
  estimatedRemainingCostUsd: number; // 推算剩余等效 API 金额（USD）
  estimatedRemainingTokens: number; // 推算剩余可用 Token
}

const ANCHOR_DRIFT_TOLERANCE_MS = 24 * 3_600_000; // 同周期锚点微调承接窗口（±24 小时）

/**
 * 职责：在精确匹配失败时，于同配额池、同周期锚点微调范围内（±24h 且校准时刻落在本周期窗口内）承接已有周剩余%校准。
 * 思路：1) 优先命中 `${poolKey}:${windowStart}` 精确键；2) 否则筛同池下起点偏差 <=24h 且 calibratedAt 落于 [windowStart, windowEnd] 的最新校准，既防止微调锚点丢值，又杜绝跨新重置污染。
 * 参数：calibrations — 全量校准字典；poolKey — 配额池键；windowStart — 当前周期起点 ISO；windowEnd — 当前周期终点 ISO（可选）。
 * 返回值：命中的 `{ key, calibration }`，无匹配返回 null。
 */
export function resolveWeeklyCalibration(
  calibrations: Record<string, WeeklyQuotaCalibration>,
  poolKey: string,
  windowStart?: string,
  windowEnd?: string
): { key: string; calibration: WeeklyQuotaCalibration } | null {
  if (!poolKey || !windowStart) return null;
  const exactKey = `${poolKey}:${windowStart}`;
  if (calibrations[exactKey]) {
    return { key: exactKey, calibration: calibrations[exactKey] };
  }
  const startMs = Date.parse(windowStart);
  if (!Number.isFinite(startMs) || startMs <= 0) return null;
  const parsedEnd = windowEnd ? Date.parse(windowEnd) : NaN;
  const endMs = Number.isFinite(parsedEnd) && parsedEnd > startMs ? parsedEnd : startMs + 7 * 86_400_000;
  const prefix = `${poolKey}:`;

  let best: { key: string; calibration: WeeklyQuotaCalibration; atMs: number } | null = null;
  for (const [key, cal] of Object.entries(calibrations)) {
    if (!key.startsWith(prefix)) continue;
    const entryStartMs = Date.parse(key.slice(prefix.length));
    const calAtMs = Date.parse(cal.calibratedAt);
    if (!Number.isFinite(entryStartMs) || !Number.isFinite(calAtMs)) continue;
    if (Math.abs(entryStartMs - startMs) > ANCHOR_DRIFT_TOLERANCE_MS) continue;
    if (calAtMs < startMs || calAtMs > endMs) continue;
    if (!best || calAtMs > best.atMs) {
      best = { key, calibration: cal, atMs: calAtMs };
    }
  }
  return best ? { key: best.key, calibration: best.calibration } : null;
}

/**
 * 职责：根据官方周剩余百分比与校准时刻消耗反算 100% 周满额 API 金额与总 Token，并结合当前实时消耗推算最新剩余量。
 * 思路：usedRatio = (100 - remainingPct) / 100；满额 = 校准消耗 / usedRatio；实时剩余按当前等效成本相对满额比例动态扣减。
 * 参数：calibration — 用户输入的校准快照；currentCostUsd — 当前周期累计等效成本；currentTokens — 当前周期累计总 Token。
 * 返回值：有效的 WeeklyQuotaProjection 对象；若剩余百分比非法（>=100 或 <0）或校准消耗为 0 则返回 null。
 */
export function computeWeeklyQuotaProjection(
  calibration: WeeklyQuotaCalibration | null | undefined,
  currentCostUsd: number,
  currentTokens: number
): WeeklyQuotaProjection | null {
  if (!calibration) return null;
  const rem = calibration.remainingPct;
  if (!Number.isFinite(rem) || rem < 0 || rem >= 100) return null;
  const baseCost =
    Number.isFinite(calibration.calibratedCostUsd) && calibration.calibratedCostUsd > 0
      ? calibration.calibratedCostUsd
      : 0;
  const baseTokens =
    Number.isFinite(calibration.calibratedTokens) && calibration.calibratedTokens > 0
      ? calibration.calibratedTokens
      : 0;
  if (baseCost <= 0 && baseTokens <= 0) return null;

  const usedRatio = (100 - rem) / 100;
  const fullCostUsd = baseCost > 0 ? baseCost / usedRatio : 0;
  const fullTokens = baseTokens > 0 ? baseTokens / usedRatio : 0;
  const safeCurCost = Number.isFinite(currentCostUsd) && currentCostUsd > 0 ? currentCostUsd : 0;
  const safeCurTokens = Number.isFinite(currentTokens) && currentTokens > 0 ? currentTokens : 0;
  const liveUsedRatio =
    fullCostUsd > 0 ? safeCurCost / fullCostUsd : fullTokens > 0 ? safeCurTokens / fullTokens : 1;

  return {
    fullCostUsd,
    fullTokens,
    estimatedRemainingPct: Math.max(0, Math.min(100, (1 - liveUsedRatio) * 100)),
    estimatedRemainingCostUsd: Math.max(0, fullCostUsd - safeCurCost),
    estimatedRemainingTokens: Math.max(0, fullTokens - safeCurTokens),
  };
}

const SEVEN_DAYS_MS = 7 * 86_400_000; // 官方自然周周期跨度（7 天毫秒数）

/** 重置日历单条展示项（区分实际登记重置与 +7 天自然重置） */
export interface ResetCalendarItem {
  key: string; // 唯一渲染键
  resetId: string; // 关联的原始登记事件 ID
  kind: "actual" | "natural"; // actual: 实际登记重置；natural: +7 天推算自然重置
  timestampMs: number; // 发生/预计时刻毫秒时间戳
  dayKey: string; // 本地 YYYY-MM-DD 日期键
  timeText: string; // 本地 HH:mm 时刻文本
  pool: QuotaResetEvent["pool"]; // 影响配额池
  note: string; // 备注
  supersededByMs: number | null; // 仅 natural：若在到期前已被更早一次实际重置覆盖，记录覆盖时刻
  actualDurationMs: number | null; // 仅 actual：距下一次同池重置或自然到期的周期时长
}

/**
 * 职责：根据已登记的重置事件列表，生成用于月历渲染的「实际重置 + 对应 7 天自然重置」双轨事件序列。
 * 思路：按时间升序扫描每次实际重置，生成自身 actual 节点及其 +7 天 natural 节点；若同池在 +7 天内再次出现实际重置，则标记该 natural 节点为已被提前覆盖。
 * 参数：resets — 登记的重置事件数组；nowMs — 当前参考时间戳（默认 Date.now()）。
 * 返回值：按时间升序排列的 ResetCalendarItem 数组。
 */
export function buildResetCalendarItems(
  resets: QuotaResetEvent[],
  nowMs = Date.now()
): ResetCalendarItem[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const toLocalParts = (ms: number) => {
    const d = new Date(ms);
    return {
      dayKey: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      timeText: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  };

  const sorted = resets
    .map((r) => ({ ...r, tsMs: Date.parse(r.timestamp) }))
    .filter((r) => Number.isFinite(r.tsMs) && r.tsMs > 0)
    .sort((a, b) => a.tsMs - b.tsMs);

  const items: ResetCalendarItem[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const naturalMs = cur.tsMs + SEVEN_DAYS_MS;
    const nextOverlap = sorted.find(
      (other, j) =>
        j > i &&
        other.tsMs > cur.tsMs &&
        other.tsMs < naturalMs &&
        (cur.pool === "all" || other.pool === "all" || other.pool === cur.pool)
    );
    const actualParts = toLocalParts(cur.tsMs);
    items.push({
      key: `actual-${cur.id}`,
      resetId: cur.id,
      kind: "actual",
      timestampMs: cur.tsMs,
      dayKey: actualParts.dayKey,
      timeText: actualParts.timeText,
      pool: cur.pool,
      note: cur.note,
      supersededByMs: null,
      actualDurationMs: nextOverlap
        ? nextOverlap.tsMs - cur.tsMs
        : nowMs >= naturalMs
          ? SEVEN_DAYS_MS
          : null,
    });

    const natParts = toLocalParts(naturalMs);
    items.push({
      key: `natural-${cur.id}`,
      resetId: cur.id,
      kind: "natural",
      timestampMs: naturalMs,
      dayKey: natParts.dayKey,
      timeText: natParts.timeText,
      pool: cur.pool,
      note: cur.note,
      supersededByMs: nextOverlap ? nextOverlap.tsMs : null,
      actualDurationMs: null,
    });
  }

  return items.sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * 职责：根据百分比数值列表（0~100）计算自适应 5% 步进的 Y 轴上下界。
 * 参数：values — 可见数据点的百分比数值数组（0~100）。
 * 返回值：对齐 5% 刻度且保证 minY < maxY 的 { minY, maxY }。
 */
export function computeAdaptivePercentBounds(values: number[]): { minY: number; maxY: number } {
  if (values.length === 0) return { minY: 0, maxY: 100 };
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < rawMin) rawMin = v;
    if (v > rawMax) rawMax = v;
  }
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return { minY: 0, maxY: 100 };
  let minY = Math.max(0, Math.floor(rawMin / 5) * 5);
  let maxY = Math.min(100, Math.ceil(rawMax / 5) * 5);
  if (maxY <= minY) {
    minY = Math.max(0, minY - 5);
    maxY = Math.min(100, minY + 10);
  }
  return { minY, maxY };
}

/**
 * 职责：根据非负连续指标列表（如 Token 数量、费用、TPS）计算自适应 Y 轴上下界。
 * 参数：values — 可见数据点数值数组；fallbackMax — 空数据时默认上界。
 * 返回值：包含下界 minY 与上界 maxY 的范围对象。
 */
export function computeAdaptiveLinearBounds(
  values: number[],
  fallbackMax: number
): { minY: number; maxY: number } {
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) continue;
    if (v < rawMin) rawMin = v;
    if (v > rawMax) rawMax = v;
  }
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    return { minY: 0, maxY: fallbackMax };
  }
  if (rawMax === rawMin) {
    if (rawMax <= 0) return { minY: 0, maxY: fallbackMax };
    const pad = rawMax * 0.1;
    return { minY: Math.max(0, rawMin - pad), maxY: rawMax + pad };
  }
  const pad = (rawMax - rawMin) * 0.08;
  const minY = rawMin <= pad ? 0 : Math.max(0, rawMin - pad);
  return { minY, maxY: rawMax + pad };
}

/**
 * 职责：安全读取 localStorage 中的 JSON 配置，异常或无浏览器环境时回退默认值。
 * 参数：key — localStorage 键名；fallback — 兜底默认值。
 * 返回值：反序列化后的配置值或 fallback。
 */
export function readStoredJson<T>(key: string, fallback: T): T {
  try {
    if (typeof window === "undefined" || !window.localStorage) return fallback;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 职责：安全将配置值序列化写入 localStorage，忽略隐私模式或配额异常。
 * 参数：key — localStorage 键名；value — 待持久化的可序列化数据。
 */
export function writeStoredJson(key: string, value: unknown): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略无痕模式或存储受限错误
  }
}

/**
 * 职责：将毫秒级耗时格式化为 ms / s / m 分段可读文本。
 * 参数：ms — 毫秒数。
 * 返回值：可读耗时字符串（如 "480ms"、"15.5s"、"2m 10s"）。
 */
export function formatDurationMs(ms: number): string {
  // 0. 零或负耗时返回 0ms
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  // 1.1. 小于 1 秒直接显示毫秒，小于 1 分钟显示一位小数秒
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000); // 完整分钟数
  const secs = Math.round((ms % 60_000) / 1_000); // 剩余秒数
  return `${mins}m ${secs}s`;
}

/**
 * 职责：将 ISO-8601 时间戳转换为本地可读的 MM-DD HH:mm:ss 格式。
 * 参数：iso — UTC 或本地 ISO 时间字符串。
 * 返回值：本地化时间文本（无效时间返回 "-"）。
 */
export function formatDateTime(iso: string): string {
  // 0. 校验输入并解析 Date 实例
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  // 1.1. 补零拼接月-日 时:分:秒
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 职责：将 ISO-8601 时间戳转换为相对当前时间的友好短文本。
 * 参数：iso — ISO 时间字符串。
 * 返回值：相对时间描述（如 "刚刚"、"12 分钟前"、"3 小时前"）。
 */
export function formatRelativeTime(iso: string): string {
  // 0. 解析时间并计算与当前时刻的秒差
  if (!iso) return "-";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "-";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1_000)); // 距离当前的秒数
  // 1.1. 按分钟、小时、天分级展示
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3_600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3_600)} 小时前`;
  if (diffSec < 86_400 * 30) return `${Math.floor(diffSec / 86_400)} 天前`;
  return formatDateTime(iso).slice(0, 5);
}

/**
 * 职责：将配额周期剩余毫秒数格式化为紧凑倒计时文本（如 "4h26m"、"4天6h"）。
 * 参数：ms — 距离周期重置的剩余毫秒数。
 * 返回值：紧凑倒计时字符串（<=0 时返回空字符串）。
 */
export function formatCycleCountdown(ms: number): string {
  // 0. 非正数表示已重置或非倒计时态
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMins = Math.max(1, Math.ceil(ms / 60_000)); // 向上取整至分钟
  const days = Math.floor(totalMins / 1_440); // 剩余整天数
  const hours = Math.floor((totalMins % 1_440) / 60); // 剩余小时数
  const mins = totalMins % 60; // 剩余分钟数
  // 1.1. 大于 1 天显示天+时，否则显示时+分或纯分钟
  if (days > 0) return `${days}天${hours}h`;
  if (hours > 0) return `${hours}h${String(mins).padStart(2, "0")}m`;
  return `${mins}m`;
}

/**
 * 职责：根据模型标识文本匹配最具体的单价规则（优先最长子串匹配，兜底通配规则）。
 * 参数：modelText — 模型名称或 ID 组合字符串；rates — 候选单价表。
 * 返回值：命中的 ModelPriceRate 配置项。
 */
export function matchModelPriceRate(
  modelText: string,
  rates: ModelPriceRate[]
): ModelPriceRate {
  // 0. 空表直接返回内置兜底费率
  if (!rates || rates.length === 0) return FALLBACK_PRICE_RATE;
  const normalized = (modelText || "").toLowerCase(); // 统一转小写便于子串匹配
  let bestMatch: ModelPriceRate | null = null; // 记录最长模式命中的具体规则
  let wildcardMatch: ModelPriceRate | null = null; // 记录通配兜底规则

  // 1.1. 遍历单价表区分通配符与具体关键字规则
  for (const rate of rates) {
    const pattern = (rate.modelPattern || "").trim().toLowerCase();
    if (!pattern || pattern === "*" || pattern === "default") {
      wildcardMatch = rate;
      continue;
    }
    if (
      normalized.includes(pattern) &&
      (!bestMatch || pattern.length > bestMatch.modelPattern.trim().length)
    ) {
      bestMatch = rate;
    }
  }
  return bestMatch ?? wildcardMatch ?? rates[rates.length - 1] ?? FALLBACK_PRICE_RATE;
}

/**
 * 职责：依据单模型费率计算等效 API 调用成本与缓存节省金额。
 * 参数：inputTokens — 未缓存输入；cacheReadTokens — 缓存读取；outputTokens — 总输出；rate — 单价项。
 * 返回值：包含 estimatedCostUsd 与 cacheSavedUsd 的计算结果。
 */
export function calculateTokenCost(
  inputTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
  rate: ModelPriceRate
): { estimatedCostUsd: number; cacheSavedUsd: number } {
  // 0. 按百万 Token 线性折算输入、缓存读取与输出费用
  const estimatedCostUsd =
    (Math.max(0, inputTokens) * Math.max(0, rate.inputPerMillion) +
      Math.max(0, cacheReadTokens) * Math.max(0, rate.cacheReadPerMillion) +
      Math.max(0, outputTokens) * Math.max(0, rate.outputPerMillion)) /
    1_000_000;
  // 1.1. 缓存节省金额 = 缓存读取量 × max(0, 未缓存单价 - 缓存读取单价)
  const unitSaved = Math.max(0, rate.inputPerMillion - rate.cacheReadPerMillion);
  const cacheSavedUsd = (Math.max(0, cacheReadTokens) * unitSaved) / 1_000_000;
  return { estimatedCostUsd, cacheSavedUsd };
}

/**
 * 职责：使用自定义每百万 Token 单价实时重算完整看板载荷中的成本与缓存节省指标。
 * 思路：1) 重算 byModel 并求加权混合费率；2) 重算 conversations 并按项目汇总更新 byWorkspace；3) 重算趋势桶与顶部 KPI。
 * 参数：summary — 原始服务端汇总载荷；customRates — 用户自定义单价列表。
 * 返回值：更新成本与节省金额后的新 DashboardSummaryPayload 对象。
 */
export function recalculateSummaryWithCustomRates(
  summary: DashboardSummaryPayload,
  customRates: ModelPriceRate[] | null
): DashboardSummaryPayload {
  // 0. 未开启自定义单价时原样返回，避免多余对象拷贝
  if (!customRates || customRates.length === 0) return summary;

  // 1.1. 逐模型精确重算成本并统计全局加权费率分子
  let weightedInSum = 0; // 加权输入单价累计分子
  let weightedCacheSum = 0; // 加权缓存单价累计分子
  let weightedOutSum = 0; // 加权输出单价累计分子
  let modelCostSum = 0; // 模型维度总等效成本
  let modelSavedSum = 0; // 模型维度总缓存节省

  const byModel = summary.byModel.map((m) => {
    const rate = matchModelPriceRate(`${m.modelName} ${m.modelId}`, customRates);
    const { estimatedCostUsd, cacheSavedUsd } = calculateTokenCost(
      m.inputTokens,
      m.cacheReadTokens,
      m.outputTokens,
      rate
    );
    weightedInSum += m.inputTokens * rate.inputPerMillion;
    weightedCacheSum += m.cacheReadTokens * rate.cacheReadPerMillion;
    weightedOutSum += m.outputTokens * rate.outputPerMillion;
    modelCostSum += estimatedCostUsd;
    modelSavedSum += cacheSavedUsd;
    return { ...m, estimatedCostUsd, cacheSavedUsd };
  });

  // 1.2. 构造全局混合费率供无模型拆分的趋势桶使用
  const defaultRate = matchModelPriceRate("*", customRates);
  const blendedRate: ModelPriceRate = {
    modelPattern: "*",
    label: "Blended",
    inputPerMillion:
      summary.totals.inputTokens > 0
        ? weightedInSum / summary.totals.inputTokens
        : defaultRate.inputPerMillion,
    cacheReadPerMillion:
      summary.totals.cacheReadTokens > 0
        ? weightedCacheSum / summary.totals.cacheReadTokens
        : defaultRate.cacheReadPerMillion,
    outputPerMillion:
      summary.totals.outputTokens > 0
        ? weightedOutSum / summary.totals.outputTokens
        : defaultRate.outputPerMillion,
  };

  // 2.1. 重算会话列表并按工作区聚合精确项目成本
  const workspaceCostMap = new Map<string, number>(); // 工作区键 -> 汇总成本
  let convCostSum = 0; // 会话维度累计成本（供空模型表时兜底）
  let convSavedSum = 0; // 会话维度累计节省

  const conversations = summary.conversations.map((conv) => {
    const rate = matchModelPriceRate(
      `${conv.primaryModel} ${conv.models.join(" ")}`,
      customRates
    );
    const { estimatedCostUsd, cacheSavedUsd } = calculateTokenCost(
      conv.inputTokens,
      conv.cacheReadTokens,
      conv.outputTokens,
      rate
    );
    const wsKey = conv.workspacePath || conv.workspaceName;
    workspaceCostMap.set(wsKey, (workspaceCostMap.get(wsKey) ?? 0) + estimatedCostUsd);
    convCostSum += estimatedCostUsd;
    convSavedSum += cacheSavedUsd;
    return { ...conv, estimatedCostUsd, cacheSavedUsd };
  });

  // 2.2. 更新工作区拆解与日/小时趋势序列
  const byWorkspace = summary.byWorkspace.map((ws) => {
    const wsKey = ws.workspacePath || ws.workspaceName;
    const mapped = workspaceCostMap.get(wsKey);
    const fallback = calculateTokenCost(
      ws.inputTokens,
      ws.cacheReadTokens,
      ws.outputTokens,
      blendedRate
    ).estimatedCostUsd;
    return { ...ws, estimatedCostUsd: mapped ?? fallback };
  });

  const dailyTrend = summary.dailyTrend.map((b) => {
    const models = b.models
      ?.map((m) => {
        const mRate = matchModelPriceRate(`${m.modelName} ${m.modelId}`, customRates);
        const { estimatedCostUsd } = calculateTokenCost(
          m.inputTokens,
          m.cacheReadTokens,
          m.outputTokens,
          mRate
        );
        return { ...m, estimatedCostUsd };
      })
      .sort((a, m2) => m2.estimatedCostUsd - a.estimatedCostUsd || m2.totalTokens - a.totalTokens);
    const estimatedCostUsd =
      models && models.length > 0
        ? models.reduce((acc, m) => acc + m.estimatedCostUsd, 0)
        : calculateTokenCost(b.inputTokens, b.cacheReadTokens, b.outputTokens, blendedRate)
            .estimatedCostUsd;
    return {
      ...b,
      estimatedCostUsd,
      models,
    };
  });

  const hourlyTrend = summary.hourlyTrend.map((b) => ({
    ...b,
    estimatedCostUsd: calculateTokenCost(
      b.inputTokens,
      b.cacheReadTokens,
      b.outputTokens,
      blendedRate
    ).estimatedCostUsd,
  }));

  // 3.1. 更新顶部全局汇总指标与今日估算成本
  const totalEstimatedCostUsd = byModel.length > 0 ? modelCostSum : convCostSum;
  const totalCacheSavedUsd = byModel.length > 0 ? modelSavedSum : convSavedSum;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; // 本地今日日期键
  const todayBucket = dailyTrend.find((b) => b.bucketKey === todayKey);
  const costScale =
    summary.totals.estimatedCostUsd > 0
      ? totalEstimatedCostUsd / summary.totals.estimatedCostUsd
      : 1;
  const todayEstimatedCostUsd =
    summary.totals.todayTotalTokens <= 0
      ? 0
      : todayBucket
        ? todayBucket.estimatedCostUsd
        : summary.totals.todayEstimatedCostUsd * costScale;

  return {
    ...summary,
    totals: {
      ...summary.totals,
      estimatedCostUsd: totalEstimatedCostUsd,
      cacheSavedUsd: totalCacheSavedUsd,
      todayEstimatedCostUsd,
    },
    dailyTrend,
    hourlyTrend,
    byModel,
    byWorkspace,
    conversations,
  };
}

/**
 * 职责：使用自定义单价重算单个会话详情弹窗内的单步成本与汇总成本。
 * 参数：detail — 会话详情数据；customRates — 自定义单价表。
 * 返回值：重算后的 ConversationDetail。
 */
export function recalculateDetailWithCustomRates(
  detail: ConversationDetail,
  customRates: ModelPriceRate[] | null
): ConversationDetail {
  // 0. 无自定义单价直接返回原详情
  if (!customRates || customRates.length === 0) return detail;
  let sumCost = 0; // 单步成本累计
  let sumSaved = 0; // 单步节省累计
  // 1.1. 逐个推理步骤匹配单价并重算
  const steps = detail.steps.map((step) => {
    const rate = matchModelPriceRate(`${step.modelName} ${step.modelId}`, customRates);
    const { estimatedCostUsd, cacheSavedUsd } = calculateTokenCost(
      step.inputTokens,
      step.cacheReadTokens,
      step.outputTokens,
      rate
    );
    sumCost += estimatedCostUsd;
    sumSaved += cacheSavedUsd;
    return { ...step, estimatedCostUsd, cacheSavedUsd };
  });
  return {
    ...detail,
    steps,
    estimatedCostUsd: steps.length > 0 ? sumCost : detail.estimatedCostUsd,
    cacheSavedUsd: steps.length > 0 ? sumSaved : detail.cacheSavedUsd,
  };
}

/**
 * 职责：从浏览器 localStorage 安全读取用户自定义单价配置。
 * 参数：无。
 * 返回值：有效的 ModelPriceRate 数组，未设置或解析失败时返回 null。
 */
export function loadCustomPricingFromStorage(): ModelPriceRate[] | null {
  // 0. 捕获隐私模式或 JSON 损坏异常
  try {
    const raw = window.localStorage.getItem(CUSTOM_PRICING_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as ModelPriceRate[];
  } catch {
    return null;
  }
}

/**
 * 职责：将自定义单价写入或清除出浏览器 localStorage。
 * 参数：rates — 待保存的单价数组，传入 null 时清空自定义配置并恢复默认。
 * 返回值：无。
 */
export function saveCustomPricingToStorage(rates: ModelPriceRate[] | null): void {
  // 0. 写入或移除键值并忽略存储配额异常
  try {
    if (!rates || rates.length === 0) {
      window.localStorage.removeItem(CUSTOM_PRICING_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CUSTOM_PRICING_STORAGE_KEY, JSON.stringify(rates));
    }
  } catch {
    // 忽略受限浏览器环境下的存储异常
  }
}
