/**
 * Input: ../src/types/telemetry 中的 ConversationDetail、QuotaCycleInfo 与 QuotaCycleMode 类型契约。
 * Output: 导出 matchesModelQuery、resolveQuotaCycleBlocks 与 computeQuotaCycleWindow 分池配额周期推算模块。
 * Pos: 服务端配额池归类与 5h / 7d 双层配额周期时间窗计算核心模块（server/quotaCycle.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import type {
  ConversationDetail,
  QuotaCycleInfo,
  QuotaCycleMode,
  QuotaCycleOption,
  QuotaResetEvent,
} from "../src/types/telemetry";

const FIVE_HOURS_MS = 5 * 3_600_000; // 官方短窗口：首条调用起 5 小时刷新周期（毫秒）
const SEVEN_DAYS_MS = 7 * 86_400_000; // 官方长窗口：首条调用锚定 7 天周上限周期（毫秒）

/**
 * 职责：从环境变量读取可选的配额周期校准时间戳（ISO-8601 或毫秒时间戳），未配置时返回 undefined 走自动推算。
 * 参数：envKey — 环境变量名（如 AGY_GEMINI_7D_ANCHOR / AGY_CLAUDE_7D_ANCHOR / AGY_GEMINI_5H_ANCHOR）。
 * 返回值：有效毫秒时间戳或 undefined。
 */
function resolveEnvAnchorMs(envKey: string): number | undefined {
  const raw = process.env[envKey]?.trim();
  if (!raw) return undefined;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 读取可选环境变量覆盖的官方配额重置锚点（默认留空，按各人本地首次调用自动推算） */
function getCalibratedAnchors(): {
  gemini7dMs?: number;
  gemini5hMs?: number;
  claude7dMs?: number;
} {
  return {
    gemini7dMs: resolveEnvAnchorMs("AGY_GEMINI_7D_ANCHOR"),
    gemini5hMs: resolveEnvAnchorMs("AGY_GEMINI_5H_ANCHOR"),
    claude7dMs: resolveEnvAnchorMs("AGY_CLAUDE_7D_ANCHOR"),
  };
}

/** 单个推算配额周期块 */
export interface CycleBlock {
  startMs: number; // 周期起点毫秒时间戳
  endMs: number; // 周期重置终点毫秒时间戳
  totalTokens: number; // 落入该周期内的总消耗 Token
  isIdleReset: boolean; // 是否已过重置时刻处于满血待触发态
}

/**
 * 职责：判断模型名称或模型 ID 是否命中配额池（pool:claude / pool:gemini）或关键字过滤。
 * 思路：pool:claude 归并全部 Claude 系列（Opus / Sonnet / Haiku 等同池模型），pool:gemini 归并全部 Gemini 系列独立池，其余走子串匹配。
 * 参数：modelName — 可读模型名；modelId — 原始模型标识；query — 过滤词或池标识。
 * 返回值：命中返回 true，否则返回 false。
 */
export function matchesModelQuery(modelName: string, modelId: string, query: string): boolean {
  // 0. 归一化小写并识别双配额池前缀
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${modelName} ${modelId}`.toLowerCase();
  if (needle === "pool:claude") {
    return (
      hay.includes("claude") ||
      hay.includes("opus") ||
      hay.includes("sonnet") ||
      hay.includes("haiku") ||
      hay.includes("anthropic")
    );
  }
  if (needle === "pool:gemini") {
    return (
      hay.includes("gemini") ||
      hay.includes("argon") ||
      hay.includes("carbon") ||
      hay.includes("flash")
    );
  }
  return hay.includes(needle);
}

/**
 * 职责：基于按时间升序排列的调用序列与可选官方/人工登记的多个重置锚点，切分固定时长（5h 或 7d）的配额周期链。
 * 思路：1) 将所有 <= nowMs 的锚点去重升序排列；2) 每跨过一个锚点即截断封口前一个周期块并开启新的 [anchor, anchor + durationMs) 周期块；3) 无锚点或到期后的后续调用继续按自然 durationMs 自动顺推。
 * 参数：entries — 池内升序步骤数组；durationMs — 周期毫秒跨度；nowMs — 当前基准时间；seedAnchorMs — 可选单个或多个校准重置时间戳。
 * 返回值：{ active, prev, blocks } 当前周期、上一周期与全量周期块。
 */
export function resolveQuotaCycleBlocks(
  entries: Array<{ tsMs: number; totalTokens: number }>,
  durationMs: number,
  nowMs: number,
  seedAnchorMs?: number | number[]
): { active: CycleBlock; prev: CycleBlock | null; blocks: CycleBlock[] } {
  // 0. 归一化并排序所有已生效的重置锚点（<= nowMs），过滤重复点
  const rawAnchors = Array.isArray(seedAnchorMs)
    ? seedAnchorMs
    : seedAnchorMs !== undefined
      ? [seedAnchorMs]
      : [];
  const anchors = [
    ...new Set(rawAnchors.filter((a) => Number.isFinite(a) && a > 0 && a <= nowMs)),
  ].sort((a, b) => a - b);
  let anchorCursor = 0;

  const blocks: Array<{ startMs: number; endMs: number; totalTokens: number }> = [];

  // 将所有 <= upToMs 的锚点依次落盘为新周期起点，并截断前序未到期周期
  const flushAnchorsUpTo = (upToMs: number) => {
    while (anchorCursor < anchors.length && anchors[anchorCursor] <= upToMs) {
      const a = anchors[anchorCursor++];
      const prev = blocks[blocks.length - 1];
      if (prev && prev.endMs > a) {
        prev.endMs = a;
      }
      blocks.push({ startMs: a, endMs: a + durationMs, totalTokens: 0 });
    }
  };

  for (const item of entries) {
    flushAnchorsUpTo(item.tsMs);
    const nextAnchor = anchorCursor < anchors.length ? anchors[anchorCursor] : undefined;
    const last = blocks[blocks.length - 1];
    if (!last || item.tsMs >= last.endMs) {
      const rawEnd = item.tsMs + durationMs;
      const cappedEnd = nextAnchor !== undefined && item.tsMs < nextAnchor ? Math.min(rawEnd, nextAnchor) : rawEnd;
      blocks.push({
        startMs: item.tsMs,
        endMs: cappedEnd,
        totalTokens: item.totalTokens,
      });
    } else {
      last.totalTokens += item.totalTokens;
    }
  }
  flushAnchorsUpTo(nowMs);

  // 1.1. 无任何历史调用且无有效锚点时处于满血待触发态
  if (blocks.length === 0) {
    const idleActive: CycleBlock = {
      startMs: nowMs,
      endMs: nowMs + durationMs,
      totalTokens: 0,
      isIdleReset: true,
    };
    return { active: idleActive, prev: null, blocks: [] };
  }

  // 1.2. 对比末个周期块终点与当前时间，判定是否仍在周期内或已完成重置
  const normalizedBlocks: CycleBlock[] = blocks.map((b) => ({ ...b, isIdleReset: false }));
  const last = normalizedBlocks[normalizedBlocks.length - 1];
  if (nowMs < last.endMs) {
    const prevRaw = normalizedBlocks.length >= 2 ? normalizedBlocks[normalizedBlocks.length - 2] : null;
    return {
      active: last,
      prev: prevRaw,
      blocks: normalizedBlocks,
    };
  }

  const idleActive: CycleBlock = {
    startMs: nowMs,
    endMs: nowMs + durationMs,
    totalTokens: 0,
    isIdleReset: true,
  };
  return {
    active: idleActive,
    prev: last,
    blocks: [...normalizedBlocks, idleActive],
  };
}

/**
 * 职责：结合当前选中的模型池与周期模式，分池校准计算截断判定器与双层配额周期摘要（确保「全部 = Claude 池 + Gemini 池」）。
 * 参数：allDetails — 全量会话；modelQuery — 池/模型过滤词；mode — 周期模式；days — CLI 天数；nowMs — 基准时间；useCalibration — 是否启用本机官方快照锚点。
 * 返回值：包含 quotaWindow 元信息与 stepTimeFilter 单步时间判定函数（null 表示不限时间）。
 */
export function computeQuotaCycleWindow(
  allDetails: ConversationDetail[],
  modelQuery: string,
  mode: QuotaCycleMode,
  days: number | undefined,
  nowMs: number,
  useCalibration: boolean,
  registeredResets: QuotaResetEvent[] = []
): {
  quotaWindow: QuotaCycleInfo;
  stepTimeFilter: ((modelName: string, modelId: string, tsMs: number) => boolean) | null;
} {
  // 0. 按配额池分别收集全工作区调用序列，使 Claude 池与 Gemini 池各自遵守独立重置钟
  const claudeEntries: Array<{ tsMs: number; totalTokens: number }> = [];
  const geminiEntries: Array<{ tsMs: number; totalTokens: number }> = [];
  const otherEntries: Array<{ tsMs: number; totalTokens: number }> = [];

  for (const conv of allDetails) {
    for (const step of conv.steps) {
      if (modelQuery && !matchesModelQuery(step.modelName, step.modelId, modelQuery)) continue;
      const tsMs = Date.parse(step.timestamp);
      if (Number.isNaN(tsMs) || tsMs <= 0) continue;
      const entry = { tsMs, totalTokens: step.totalTokens };
      if (matchesModelQuery(step.modelName, step.modelId, "pool:claude")) {
        claudeEntries.push(entry);
      } else if (matchesModelQuery(step.modelName, step.modelId, "pool:gemini")) {
        geminiEntries.push(entry);
      } else {
        otherEntries.push(entry);
      }
    }
  }
  claudeEntries.sort((a, b) => a.tsMs - b.tsMs);
  geminiEntries.sort((a, b) => a.tsMs - b.tsMs);
  otherEntries.sort((a, b) => a.tsMs - b.tsMs);

  // 1.1. 分池推算各自的 5h 与 7d 周期块（融合可选环境变量锚点与用户登记的历史重置时间）
  const anchors = useCalibration ? getCalibratedAnchors() : {};
  const collect7dAnchors = (pool: "claude" | "gemini" | "all"): number[] => {
    const list: number[] = [];
    if (pool === "claude" && anchors.claude7dMs) list.push(anchors.claude7dMs);
    if (pool === "gemini" && anchors.gemini7dMs) list.push(anchors.gemini7dMs);
    if (pool === "all") {
      if (anchors.gemini7dMs) list.push(anchors.gemini7dMs);
      if (anchors.claude7dMs) list.push(anchors.claude7dMs);
    }
    for (const r of registeredResets) {
      if (pool === "all" || r.pool === "all" || r.pool === pool) {
        const ms = Date.parse(r.timestamp);
        if (Number.isFinite(ms) && ms > 0) list.push(ms);
      }
    }
    return list;
  };
  const claude7dAnchors = collect7dAnchors("claude");
  const gemini7dAnchors = collect7dAnchors("gemini");
  const all7dAnchors = collect7dAnchors("all");

  const claude5h = resolveQuotaCycleBlocks(claudeEntries, FIVE_HOURS_MS, nowMs);
  const claude7d = resolveQuotaCycleBlocks(claudeEntries, SEVEN_DAYS_MS, nowMs, claude7dAnchors);
  const gemini5h = resolveQuotaCycleBlocks(
    geminiEntries,
    FIVE_HOURS_MS,
    nowMs,
    anchors.gemini5hMs
  );
  const gemini7d = resolveQuotaCycleBlocks(geminiEntries, SEVEN_DAYS_MS, nowMs, gemini7dAnchors);
  const other5h = resolveQuotaCycleBlocks(otherEntries, FIVE_HOURS_MS, nowMs);
  const other7d = resolveQuotaCycleBlocks(otherEntries, SEVEN_DAYS_MS, nowMs);

  const labelMap: Record<string, string> = {
    "5h": "当前 5h 周期",
    "prev-5h": "上一 5h 周期",
    "7d": "当前 7d 周周期",
    "prev-7d": "上一 7d 周周期",
    today: "自然今日",
    all: "全部历史",
  };
  const modeLabel = labelMap[mode] ?? "指定 7d 周周期";

  // 1.1.1. 汇总当前选中池/模型的完整 7 天周期链（按时间倒序排列供前端展示所有历史账期）
  const merged7dEntries =
    modelQuery.toLowerCase() === "pool:claude"
      ? claudeEntries
      : modelQuery.toLowerCase() === "pool:gemini"
        ? geminiEntries
        : [...claudeEntries, ...geminiEntries, ...otherEntries].sort((a, b) => a.tsMs - b.tsMs);
  const merged7dAnchors =
    modelQuery.toLowerCase() === "pool:claude"
      ? claude7dAnchors
      : modelQuery.toLowerCase() === "pool:gemini"
        ? gemini7dAnchors
        : all7dAnchors;
  const merged7d = resolveQuotaCycleBlocks(merged7dEntries, SEVEN_DAYS_MS, nowMs, merged7dAnchors);
  const available7dCycles: QuotaCycleOption[] = [...merged7d.blocks]
    .reverse()
    .map((b, idx) => ({
      key: idx === 0 ? "7d" : (`window:${b.startMs}:${b.endMs}` as QuotaCycleMode),
      startMs: b.startMs,
      endMs: b.endMs,
      totalTokens: b.totalTokens,
      isCurrent: idx === 0,
    }));

  // 1.2. 提取指定池在目标周期模式下的 [startMs, endMs) 区间
  const rangeForPool = (
    c5: { active: CycleBlock; prev: CycleBlock | null },
    c7: { active: CycleBlock; prev: CycleBlock | null }
  ): { startMs: number; endMs: number; isIdleReset: boolean } => {
    if (mode === "5h") {
      return c5.active.isIdleReset
        ? { startMs: 0, endMs: 0, isIdleReset: true }
        : { startMs: c5.active.startMs, endMs: c5.active.endMs, isIdleReset: false };
    }
    if (mode === "prev-5h") {
      return c5.prev
        ? { startMs: c5.prev.startMs, endMs: c5.prev.endMs, isIdleReset: false }
        : { startMs: 0, endMs: 0, isIdleReset: false };
    }
    if (mode === "7d") {
      return c7.active.isIdleReset
        ? { startMs: 0, endMs: 0, isIdleReset: true }
        : { startMs: c7.active.startMs, endMs: c7.active.endMs, isIdleReset: false };
    }
    return c7.prev
      ? { startMs: c7.prev.startMs, endMs: c7.prev.endMs, isIdleReset: false }
      : { startMs: 0, endMs: 0, isIdleReset: false };
  };

  const needle = modelQuery.toLowerCase();
  const isSinglePool = needle === "pool:claude" || needle === "pool:gemini";
  const activePools =
    needle === "pool:claude"
      ? [{ c5: claude5h, c7: claude7d }]
      : needle === "pool:gemini"
        ? [{ c5: gemini5h, c7: gemini7d }]
        : [
            { c5: claude5h, c7: claude7d },
            { c5: gemini5h, c7: gemini7d },
            ...(otherEntries.length > 0 ? [{ c5: other5h, c7: other7d }] : []),
          ];

  const active5hTokens = activePools.reduce((s, p) => s + p.c5.active.totalTokens, 0);
  // 全部/非单池视图统一以 merged7d 切分口径汇总当前 7d 与历史周选项，确保各期加总不重不漏且与选择器数字完全一致
  const active7dTokens = isSinglePool
    ? activePools.reduce((s, p) => s + p.c7.active.totalTokens, 0)
    : merged7d.active.totalTokens;
  const live5hEnds = activePools.filter((p) => !p.c5.active.isIdleReset).map((p) => p.c5.active.endMs);
  const live7dEnds = isSinglePool
    ? activePools.filter((p) => !p.c7.active.isIdleReset).map((p) => p.c7.active.endMs)
    : !merged7d.active.isIdleReset
      ? [merged7d.active.endMs]
      : [];
  const active5hResetsAt = live5hEnds.length > 0 ? new Date(Math.min(...live5hEnds)).toISOString() : "";
  const active7dResetsAt = live7dEnds.length > 0 ? new Date(Math.min(...live7dEnds)).toISOString() : "";

  if (mode === "all") {
    if (days && days > 0) {
      const cutoff = nowMs - days * 86_400_000;
      return {
        quotaWindow: {
          mode,
          label: modeLabel,
          windowStart: new Date(cutoff).toISOString(),
          windowEnd: "",
          resetsInMs: 0,
          isIdleReset: false,
          active5hTokens,
          active5hResetsAt,
          active7dTokens,
          active7dResetsAt,
          available7dCycles,
        },
        stepTimeFilter: (_mName, _mId, tsMs) => tsMs >= cutoff,
      };
    }
    return {
      quotaWindow: {
        mode,
        label: modeLabel,
        windowStart: "",
        windowEnd: "",
        resetsInMs: 0,
        isIdleReset: false,
        active5hTokens,
        active5hResetsAt,
        active7dTokens,
        active7dResetsAt,
        available7dCycles,
      },
      stepTimeFilter: null,
    };
  }

  if (mode === "today") {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    const startMs = d.getTime();
    const endMs = startMs + 86_400_000;
    return {
      quotaWindow: {
        mode,
        label: modeLabel,
        windowStart: new Date(startMs).toISOString(),
        windowEnd: new Date(endMs).toISOString(),
        resetsInMs: Math.max(0, endMs - nowMs),
        isIdleReset: false,
        active5hTokens,
        active5hResetsAt,
        active7dTokens,
        active7dResetsAt,
        available7dCycles,
      },
      stepTimeFilter: (_mName, _mId, tsMs) => tsMs >= startMs && tsMs < endMs,
    };
  }

  if (mode.startsWith("window:")) {
    const [, startStr, endStr] = mode.split(":");
    const startMs = Number(startStr);
    const endMs = Number(endStr);
    const valid = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
    return {
      quotaWindow: {
        mode,
        label: modeLabel,
        windowStart: valid ? new Date(startMs).toISOString() : "",
        windowEnd: valid ? new Date(endMs).toISOString() : "",
        resetsInMs: valid && nowMs < endMs ? Math.max(0, endMs - nowMs) : 0,
        isIdleReset: false,
        active5hTokens,
        active5hResetsAt,
        active7dTokens,
        active7dResetsAt,
        available7dCycles,
      },
      stepTimeFilter: valid ? (_mName, _mId, tsMs) => tsMs >= startMs && tsMs < endMs : null,
    };
  }

  // 1.3. 7d / prev-7d 在「全部」视图与 available7dCycles 共享 merged7d 单一分区口径；单池与 5h/prev-5h 按池独立窗口截断
  if (!isSinglePool && (mode === "7d" || mode === "prev-7d")) {
    const blk = mode === "7d" ? merged7d.active : merged7d.prev;
    const isIdleReset = mode === "7d" && (!blk || blk.isIdleReset);
    const hasWindow = Boolean(blk && !isIdleReset && blk.endMs > blk.startMs);
    const startMs = hasWindow ? blk!.startMs : 0;
    const endMs = hasWindow ? blk!.endMs : 0;
    return {
      quotaWindow: {
        mode,
        label: modeLabel,
        windowStart: hasWindow ? new Date(startMs).toISOString() : "",
        windowEnd: hasWindow ? new Date(endMs).toISOString() : "",
        resetsInMs: mode === "7d" && hasWindow ? Math.max(0, endMs - nowMs) : 0,
        isIdleReset,
        active5hTokens,
        active5hResetsAt,
        active7dTokens,
        active7dResetsAt,
        available7dCycles,
      },
      stepTimeFilter: (_mName, _mId, tsMs) => hasWindow && tsMs >= startMs && tsMs < endMs,
    };
  }

  const rClaude = rangeForPool(claude5h, claude7d);
  const rGemini = rangeForPool(gemini5h, gemini7d);
  const rOther = rangeForPool(other5h, other7d);
  const selectedRanges = activePools.map((p) => rangeForPool(p.c5, p.c7));
  const nonEmpty = selectedRanges.filter((r) => r.endMs > r.startMs);
  const isIdleReset = (mode === "5h" || mode === "7d") && nonEmpty.length === 0;
  const minStart = nonEmpty.length > 0 ? Math.min(...nonEmpty.map((r) => r.startMs)) : 0;
  const minEnd = nonEmpty.length > 0 ? Math.min(...nonEmpty.map((r) => r.endMs)) : 0;
  const resetsInMs =
    (mode === "5h" || mode === "7d") && nonEmpty.length > 0 ? Math.max(0, minEnd - nowMs) : 0;

  return {
    quotaWindow: {
      mode,
      label: modeLabel,
      windowStart: nonEmpty.length > 0 ? new Date(minStart).toISOString() : "",
      windowEnd: nonEmpty.length > 0 ? new Date(minEnd).toISOString() : "",
      resetsInMs,
      isIdleReset,
      active5hTokens,
      active5hResetsAt,
      active7dTokens,
      active7dResetsAt,
      available7dCycles,
    },
    stepTimeFilter: (modelName, modelId, tsMs) => {
      const r = matchesModelQuery(modelName, modelId, "pool:claude")
        ? rClaude
        : matchesModelQuery(modelName, modelId, "pool:gemini")
          ? rGemini
          : rOther;
      return r.endMs > r.startMs && tsMs >= r.startMs && tsMs < r.endMs;
    },
  };
}
