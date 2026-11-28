/**
 * Input: ./scanner、./pricing、./quotaCycle 与 ../src/types/telemetry 类型契约。
 * Output: 导出 createTelemetryService() 及配额池匹配与周期切分重导出，实现 TelemetryProvider。
 * Pos: 服务端聚合计算层，衔接底层增量扫描器、配额周期引擎与上层 HTTP API / CLI。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import type {
  CallNodePoint,
  ConversationDetail,
  ConversationUsageSummary,
  DashboardSummaryPayload,
  GlobalKpiTotals,
  ModelPriceRate,
  ModelUsageBreakdown,
  QuotaCycleMode,
  StepUsageRecord,
  TelemetryFilterOptions,
  TelemetryProvider,
  ToolUsageBreakdown,
  UsageTimeBucket,
  WorkspaceUsageBreakdown,
} from "../src/types/telemetry";
import { DEFAULT_MODEL_PRICING } from "./pricing";
import {
  computeQuotaCycleWindow,
  getStepsTimestampMs,
  matchesModelQuery,
  resolveQuotaCycleBlocks,
} from "./quotaCycle";
import { createTelemetryScanner, TEMP_CHAT_WORKSPACE } from "./scanner";
import {
  createCalibrationStore,
  createResetStore,
  readLiveQuotaSnapshots,
} from "./resetStore";
import {
  aggregateCacheTtlObservations,
  analyzeStepCacheTtl,
  type CacheTtlObservation,
} from "../src/lib/cacheTtl";

export { matchesModelQuery, resolveQuotaCycleBlocks };

const MAX_CALL_TIMELINE_NODES = 5000; // 折线图返回的调用节点上限，确保几千轮长程工作也能完整查看全量节点曲线
const RAW_TTL_CACHE = new WeakMap<StepUsageRecord[], ReturnType<typeof analyzeStepCacheTtl>>(); // 按会话原始步骤引用缓存 TTL 解析结果

const BUCKET_KEY_CACHE = new Map<
  number,
  { dayKey: string; dayLabel: string; hourKey: string; hourLabel: string }
>(); // 半小时槽 -> 本地日/小时桶键缓存（消除数万步重复 new Date 分配）

/**
 * 职责：将毫秒时间戳转换为本地时区的 YYYY-MM-DD 日期键与小时键（带半小时槽缓存，兼容半小时偏移时区）。
 * 参数：tsMs — 毫秒时间戳（无效时回退当前时刻）。
 * 返回值：{ dayKey, dayLabel, hourKey, hourLabel }。
 */
function toLocalBucketKeys(tsMs: number): { dayKey: string; dayLabel: string; hourKey: string; hourLabel: string } {
  const safeMs = Number.isFinite(tsMs) && tsMs > 0 ? tsMs : Date.now();
  const slot = Math.floor(safeMs / 1_800_000);
  const hit = BUCKET_KEY_CACHE.get(slot);
  if (hit) return hit;

  // 0. 解析时间并补齐两位月、日、时
  const valid = new Date(safeMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = valid.getFullYear();
  const mm = pad(valid.getMonth() + 1);
  const dd = pad(valid.getDate());
  const hh = pad(valid.getHours());
  const out = {
    dayKey: `${yyyy}-${mm}-${dd}`,
    dayLabel: `${mm}-${dd}`,
    hourKey: `${yyyy}-${mm}-${dd} ${hh}:00`,
    hourLabel: `${hh}:00`,
  };
  if (BUCKET_KEY_CACHE.size >= 512) BUCKET_KEY_CACHE.clear();
  BUCKET_KEY_CACHE.set(slot, out);
  return out;
}

/**
 * 职责：剥离 steps 大数组生成轻量会话列表项。
 * 参数：detail — 完整会话详情对象。
 * 返回值：ConversationUsageSummary 汇总项。
 */
function stripSteps(detail: ConversationDetail): ConversationUsageSummary {
  // 0. 解构移除单步明细与工具计数字典
  const { steps: _steps, toolUsageCounts: _tools, ...summary } = detail;
  return summary;
}

/**
 * 职责：将会话按单步配额池窗口判定器精确裁剪，杜绝跨周期长会话把旧周期 Token 混入当前周期。
 * 思路：1) 筛选同时命中模型池与配额周期判定器的推理步；2) 重新累加全部 Token 与成本指标；3) 无命中时返回 null（或保留空壳父会话供子代理归并）。
 * 参数：conv — 原始完整会话详情；modelQuery — 模型过滤词；stepTimeFilter — 单步时间判定器；keepAsZeroShell — 是否保留空壳父会话。
 * 返回值：裁剪重算后的 ConversationDetail 或 null。
 */
function projectConversationSteps(
  conv: ConversationDetail,
  modelQuery: string,
  stepTimeFilter: ((modelName: string, modelId: string, tsMs: number) => boolean) | null,
  keepAsZeroShell = false
): ConversationDetail | null {
  // 0. 按模型池与单步配额池周期边界双重过滤推理步骤（复用预解析时间戳索引）
  const stepTsList = stepTimeFilter ? getStepsTimestampMs(conv.steps) : null;
  const matchedSteps = conv.steps.filter((s, idx) => {
    if (!matchesModelQuery(s.modelName, s.modelId, modelQuery)) return false;
    if (stepTimeFilter) {
      const ts = stepTsList![idx];
      if (ts <= 0 || !stepTimeFilter(s.modelName, s.modelId, ts)) return false;
    }
    return true;
  });

  // 1.1. 若无单步记录但无步骤空会话自身落在模型与时间窗内，则原样保留
  if (matchedSteps.length === 0) {
    if (conv.steps.length === 0 && matchesModelQuery(conv.primaryModel, "", modelQuery)) {
      const modTs = Date.parse(conv.lastModifiedAt);
      const inWindow =
        !stepTimeFilter || (!Number.isNaN(modTs) && stepTimeFilter(conv.primaryModel, "", modTs));
      if (inWindow) return conv;
    }
    if (!keepAsZeroShell) return null;
  }

  // 1.2. 基于命中的推理步骤重新汇总 Token 与成本指标
  const modelMap = new Map<string, number>();
  const toolUsageCounts: Record<string, number> = {};
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let peakContextUsed = 0;
  let contextLimit = 0;
  let totalLatencyMs = 0;
  let estimatedCostUsd = 0;
  let cacheSavedUsd = 0;

  for (const s of matchedSteps) {
    inputTokens += s.inputTokens;
    cacheReadTokens += s.cacheReadTokens;
    outputTokens += s.outputTokens;
    thinkingTokens += s.thinkingTokens;
    responseTokens += s.responseTokens;
    if (s.contextUsed > peakContextUsed) peakContextUsed = s.contextUsed;
    if (s.contextLimit > contextLimit) contextLimit = s.contextLimit;
    totalLatencyMs += s.latencyMs;
    estimatedCostUsd += s.estimatedCostUsd;
    cacheSavedUsd += s.cacheSavedUsd;
    modelMap.set(s.modelName, (modelMap.get(s.modelName) ?? 0) + s.totalTokens);
    for (const t of s.toolNames) {
      toolUsageCounts[t] = (toolUsageCounts[t] ?? 0) + 1;
    }
  }

  const models = [...modelMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  const promptSum = inputTokens + cacheReadTokens;
  const lastStep = matchedSteps[matchedSteps.length - 1];
  const lastStepTs = lastStep ? lastStep.timestamp : conv.lastModifiedAt;
  const latestContextUsed = lastStep
    ? lastStep.contextUsed > 0
      ? lastStep.contextUsed
      : lastStep.inputTokens + lastStep.cacheReadTokens
    : 0;

  return {
    ...conv,
    lastModifiedAt: lastStepTs || conv.lastModifiedAt,
    models: models.length > 0 ? models : conv.models,
    primaryModel: models[0] || conv.primaryModel,
    callCount: matchedSteps.length,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    totalTokens,
    cacheHitRate: promptSum > 0 ? cacheReadTokens / promptSum : 0,
    peakContextUsed,
    latestContextUsed,
    contextLimit,
    totalLatencyMs,
    estimatedCostUsd,
    cacheSavedUsd,
    steps: matchedSteps,
    toolUsageCounts,
  };
}

/** createTelemetryService 可选隔离与存储配置（解耦生产自定义数据目录与单测隔离） */
export interface TelemetryServiceOptions {
  isolated?: boolean; // 单测隔离模式：不读取宿主机默认 resets / calibrations / env 锚点 / live-quota
  resetsPath?: string | null; // 可选自定义 resets.json 路径（null 表示仅读公共重置）
  sharedResetsPath?: string; // 可选公共强制重置种子文件路径（多账号模式下显式透传仓库 shared-resets.json）
  calibrationsPath?: string; // 可选自定义 calibrations.json 路径
  liveQuotaPath?: string; // 可选自定义 live-quota.json 路径
  expectedAccountEmail?: string; // 可选预期账号邮箱（防 live-quota.json 串号）
  useEnvAnchors?: boolean; // 是否读取环境变量锚点（默认非隔离态启用）
  t3UserdataDir?: string | null; // 可选 T3 userdata 目录（null 表示禁用 statev2 线程归并）
  scanner?: ReturnType<typeof createTelemetryScanner>; // 可选外部注入扫描器（供多源聚合复用缓存避免重复扫盘）
}

/**
 * 职责：构建符合 TelemetryProvider 接口的聚合查询服务。
 * 思路：调用增量扫描器获取全量会话详情，提取下拉可选项后执行多条件筛选，一次遍历汇总全局 KPI、模型/项目拆解与时间桶。
 * 参数：customDataDir — 可选数据目录；customRates — 可选模型费率表；resetsPathOrOptions — 可选配置对象或兼容旧签名的重置文件路径；customCalibrationsPath — 兼容旧签名的校准文件路径。
 * 返回值：TelemetryProvider 实例。
 */
export function createTelemetryService(
  customDataDir?: string,
  customRates?: ModelPriceRate[],
  resetsPathOrOptions?: string | TelemetryServiceOptions,
  customCalibrationsPath?: string
): TelemetryProvider {
  const serviceOpts: TelemetryServiceOptions =
    typeof resetsPathOrOptions === "string"
      ? { resetsPath: resetsPathOrOptions, calibrationsPath: customCalibrationsPath }
      : {
          ...(resetsPathOrOptions ?? {}),
          ...(customCalibrationsPath && !resetsPathOrOptions?.calibrationsPath
            ? { calibrationsPath: customCalibrationsPath }
            : {}),
        };
  const isolated = Boolean(serviceOpts.isolated);
  const useEnvAnchors = serviceOpts.useEnvAnchors ?? !isolated;
  const pricing = customRates && customRates.length > 0 ? customRates : DEFAULT_MODEL_PRICING; // 生效费率配置
  const t3Dir = serviceOpts.t3UserdataDir !== undefined ? serviceOpts.t3UserdataDir : isolated ? null : undefined;
  const scanner = serviceOpts.scanner ?? createTelemetryScanner(customDataDir, pricing, t3Dir); // 增量扫描器实例
  const resetStore =
    !isolated || serviceOpts.resetsPath || serviceOpts.sharedResetsPath
      ? createResetStore(serviceOpts.resetsPath, serviceOpts.sharedResetsPath)
      : null;
  const calibrationStore =
    !isolated || serviceOpts.calibrationsPath
      ? createCalibrationStore(serviceOpts.calibrationsPath)
      : null;
  const SUMMARY_CACHE_TTL_MS = 15_000; // 同一数据版本下聚合结果缓存有效期（毫秒）
  const SUMMARY_CACHE_MAX = 16; // 最多缓存的筛选组合数
  let cachedScanVersion = -1; // 当前聚合缓存对应的扫描数据版本号
  const summaryCache = new Map<string, { payload: DashboardSummaryPayload; expiresAt: number }>();

  return {
    /**
     * 职责：按过滤条件返回会话列表与顶部统计汇总。
     * 参数：options — 时间窗、工作区、模型、关键词、归档与强制刷新选项。
     * 返回值：DashboardSummaryPayload。
     */
    getSummary(options: TelemetryFilterOptions = {}): DashboardSummaryPayload {
      // 0. 扫描本地数据；若扫描版本号未变且命中同条件缓存，直接 O(1) 返回避免切池重算
      const { conversations: allDetails, health, version } = scanner.scan(Boolean(options.forceRefresh));
      if (version !== cachedScanVersion) {
        summaryCache.clear();
        cachedScanVersion = version;
      }
      const includeArchived = options.includeArchived !== false;
      const nowMs = options.nowMs ?? Date.now();
      const cycleMode: QuotaCycleMode = options.cycle ?? "all";
      const q = options.search?.trim().toLowerCase() || "";
      const modelQuery = options.model?.trim() || "";
      const registeredResets = resetStore ? resetStore.list() : [];
      const resetsSig = registeredResets.map((r) => `${r.timestamp}:${r.pool}`).join(",");
      const cacheKey = JSON.stringify([
        cycleMode,
        options.days ?? 0,
        options.workspace ?? "",
        modelQuery,
        q,
        includeArchived,
        options.nodeLimit ?? -1,
        options.nowMs ?? 0,
        resetsSig,
      ]);
      if (!options.forceRefresh) {
        const cached = summaryCache.get(cacheKey);
        if (cached && nowMs < cached.expiresAt) {
          return cached.payload;
        }
      }

      const wsSet = new Set<string>();
      const modelSet = new Set<string>();
      for (const c of allDetails) {
        if (c.workspaceName) wsSet.add(c.workspaceName);
        for (const m of c.models) if (m) modelSet.add(m);
        if (c.primaryModel) modelSet.add(c.primaryModel);
      }

      // 1.1. 计算配额周期边界与基础筛选条件（归档、工作区、关键词）
      const { quotaWindow, stepTimeFilter } = computeQuotaCycleWindow(
        allDetails,
        modelQuery,
        cycleMode,
        options.days,
        nowMs,
        useEnvAnchors,
        registeredResets
      );

      const baseFiltered = allDetails.filter((c) => {
        if (!includeArchived && c.archived) return false;
        if (options.workspace && c.workspaceName !== options.workspace && c.workspacePath !== options.workspace) return false;
        if (q) {
          const hay = `${c.title} ${c.firstPromptPreview} ${c.conversationId} ${c.workspaceName}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      // 1.2. 若启用了模型筛选或配额周期时间窗，按单步级别精确裁剪，并保留有匹配子代理的顶层父会话壳
      let filtered: ConversationDetail[];
      if (!modelQuery && !stepTimeFilter) {
        filtered = baseFiltered;
      } else {
        const baseById = new Map(baseFiltered.map((c) => [c.conversationId, c]));
        const projectedMap = new Map<string, ConversationDetail>();
        for (const c of baseFiltered) {
          const proj = projectConversationSteps(c, modelQuery, stepTimeFilter, false);
          if (proj) projectedMap.set(c.conversationId, proj);
        }
        for (const proj of [...projectedMap.values()]) {
          let curParentId = proj.parentConversationId;
          const seen = new Set<string>([proj.conversationId]);
          while (curParentId && !seen.has(curParentId)) {
            seen.add(curParentId);
            if (!projectedMap.has(curParentId) && baseById.has(curParentId)) {
              const shell = projectConversationSteps(
                baseById.get(curParentId)!,
                modelQuery,
                stepTimeFilter,
                true
              );
              if (shell) projectedMap.set(curParentId, shell);
            }
            curParentId = baseById.get(curParentId)?.parentConversationId || "";
          }
        }
        filtered = [...projectedMap.values()];
      }

      // 2. 聚合全局 KPI、增量调用节点序列、时间桶、模型、工作区与工具频次
      const allById = new Map(allDetails.map((c) => [c.conversationId, c]));
      const resolveRootConv = (conv: ConversationDetail): ConversationDetail => {
        let cur = conv;
        const seen = new Set<string>([cur.conversationId]);
        while (cur.parentConversationId && allById.has(cur.parentConversationId)) {
          if (seen.has(cur.parentConversationId)) break;
          seen.add(cur.parentConversationId);
          cur = allById.get(cur.parentConversationId)!;
        }
        return cur;
      };

      const rawStepEntries: Array<{
        conv: ConversationDetail;
        rootConv: ConversationDetail;
        step: StepUsageRecord;
        tsMs: number;
      }> = [];
      const todayKey = toLocalBucketKeys(nowMs).dayKey;
      const dayMap = new Map<string, UsageTimeBucket>();
      const hourMap = new Map<string, UsageTimeBucket>();
      const modelAgg = new Map<
        string,
        ModelUsageBreakdown & { convIds: Set<string>; latencySum: number; timedCalls: number; timedOut: number; timedLatMs: number; streamOut: number; streamMs: number }
      >();
      const wsAgg = new Map<string, WorkspaceUsageBreakdown>();
      const wsTtlObsMap = new Map<string, CacheTtlObservation[]>();
      const allTtlObs: CacheTtlObservation[] = [];
      const convTtlMap = new Map<string, ReturnType<typeof analyzeStepCacheTtl>["summary"]>();
      const toolAgg = new Map<string, ToolUsageBreakdown>();

      let subagentCount = 0, callCount = 0, inputTokens = 0, cacheReadTokens = 0, outputTokens = 0;
      let thinkingTokens = 0, responseTokens = 0, latencySum = 0, estimatedCostUsd = 0, cacheSavedUsd = 0;
      let todayTotalTokens = 0, todayEstimatedCostUsd = 0;
      let timedCalls = 0, ttftSum = 0, timedOut = 0, timedLatMs = 0, streamOut = 0, streamMs = 0;

      for (const conv of filtered) {
        if (conv.nestingDepth > 0 || conv.parentConversationId) subagentCount++;
        callCount += conv.callCount;
        inputTokens += conv.inputTokens;
        cacheReadTokens += conv.cacheReadTokens;
        outputTokens += conv.outputTokens;
        thinkingTokens += conv.thinkingTokens;
        responseTokens += conv.responseTokens;
        latencySum += conv.totalLatencyMs;
        estimatedCostUsd += conv.estimatedCostUsd;
        cacheSavedUsd += conv.cacheSavedUsd;

        // 2.1. 工作区维度累加
        const wk = conv.workspaceName || TEMP_CHAT_WORKSPACE;
        const curWs = wsAgg.get(wk) ?? {
          workspaceName: wk, workspacePath: conv.workspacePath, conversationCount: 0, subagentCount: 0,
          callCount: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0,
          cacheHitRate: 0, estimatedCostUsd: 0, lastActiveAt: conv.lastModifiedAt, shareOfTotalTokens: 0,
        };
        curWs.conversationCount++;
        if (conv.nestingDepth > 0 || conv.parentConversationId) curWs.subagentCount++;
        curWs.callCount += conv.callCount;
        curWs.inputTokens += conv.inputTokens;
        curWs.cacheReadTokens += conv.cacheReadTokens;
        curWs.outputTokens += conv.outputTokens;
        curWs.totalTokens += conv.totalTokens;
        curWs.estimatedCostUsd += conv.estimatedCostUsd;
        if (conv.lastModifiedAt > curWs.lastActiveAt) curWs.lastActiveAt = conv.lastModifiedAt;
        wsAgg.set(wk, curWs);

        // 2.1.1. 基于会话未过滤原始步序判定缓存 TTL（避免筛选单模型后把隔着模型切换的两步误判为连续），再按当前视图过滤观测样本
        const rawConv = allById.get(conv.conversationId) ?? conv;
        if (rawConv.steps.length >= 2) {
          let ttlRes = RAW_TTL_CACHE.get(rawConv.steps);
          if (!ttlRes) { ttlRes = analyzeStepCacheTtl(rawConv.steps, false); RAW_TTL_CACHE.set(rawConv.steps, ttlRes); }
          const matchedObs = ttlRes.observations.filter((obs) => {
            const mName = obs.modelName ?? "";
            const mId = obs.modelId ?? "";
            if (modelQuery && !matchesModelQuery(mName, mId, modelQuery)) return false;
            if (stepTimeFilter) {
              const ts = Date.parse(obs.timestamp);
              if (Number.isNaN(ts) || !stepTimeFilter(mName, mId, ts)) return false;
            }
            return true;
          });
          if (matchedObs.length > 0) {
            convTtlMap.set(conv.conversationId, aggregateCacheTtlObservations(matchedObs, false));
            const wsObs = wsTtlObsMap.get(wk) ?? [];
            wsObs.push(...matchedObs);
            wsTtlObsMap.set(wk, wsObs);
            allTtlObs.push(...matchedObs);
          }
        }

        const rootConv = resolveRootConv(conv);

        // 2.2. 逐推理步累加模型、时间桶、今日指标与工具关联（复用预解析毫秒时间戳）
        const convTsList = getStepsTimestampMs(conv.steps);
        for (let stepIdx = 0; stepIdx < conv.steps.length; stepIdx++) {
          const s = conv.steps[stepIdx];
          const safeTsMs = convTsList[stepIdx];
          rawStepEntries.push({
            conv,
            rootConv,
            step: s,
            tsMs: safeTsMs,
          });
          const bk = toLocalBucketKeys(safeTsMs);
          if (bk.dayKey === todayKey) {
            todayTotalTokens += s.totalTokens;
            todayEstimatedCostUsd += s.estimatedCostUsd;
          }

          const mk = s.modelName || "Unknown Model";
          for (const [map, key, label] of [[dayMap, bk.dayKey, bk.dayLabel], [hourMap, bk.hourKey, bk.hourLabel]] as const) {
            const b = map.get(key) ?? {
              bucketKey: key, label, callCount: 0, inputTokens: 0, cacheReadTokens: 0,
              outputTokens: 0, thinkingTokens: 0, totalTokens: 0, estimatedCostUsd: 0, models: [],
            };
            b.callCount++;
            b.inputTokens += s.inputTokens;
            b.cacheReadTokens += s.cacheReadTokens;
            b.outputTokens += s.outputTokens;
            b.thinkingTokens += s.thinkingTokens;
            b.totalTokens += s.totalTokens;
            b.estimatedCostUsd += s.estimatedCostUsd;
            const bmList = b.models ?? (b.models = []);
            let bm = bmList.find((m) => m.modelName === mk);
            if (!bm) {
              bm = {
                modelName: mk, modelId: s.modelId || mk, callCount: 0,
                inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
              };
              bmList.push(bm);
            }
            bm.callCount++;
            bm.inputTokens += s.inputTokens;
            bm.cacheReadTokens += s.cacheReadTokens;
            bm.outputTokens += s.outputTokens;
            bm.totalTokens += s.totalTokens;
            bm.estimatedCostUsd += s.estimatedCostUsd;
            map.set(key, b);
          }
          const mItem = modelAgg.get(mk) ?? {
            modelName: mk, modelId: s.modelId || mk, conversationCount: 0, callCount: 0,
            inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, responseTokens: 0,
            totalTokens: 0, cacheHitRate: 0, avgLatencyMs: 0, avgOutputTps: 0, avgStreamingTps: 0,
            estimatedCostUsd: 0, cacheSavedUsd: 0, shareOfTotalTokens: 0, convIds: new Set<string>(),
            latencySum: 0, timedCalls: 0, timedOut: 0, timedLatMs: 0, streamOut: 0, streamMs: 0,
          };
          mItem.convIds.add(conv.conversationId);
          mItem.callCount++;
          mItem.inputTokens += s.inputTokens;
          mItem.cacheReadTokens += s.cacheReadTokens;
          mItem.outputTokens += s.outputTokens;
          mItem.thinkingTokens += s.thinkingTokens;
          mItem.responseTokens += s.responseTokens;
          mItem.totalTokens += s.totalTokens;
          mItem.latencySum += s.latencyMs;
          if (s.latencyMs > 0 && s.outputTokens > 0) {
            const sDur = Math.max(0, s.latencyMs - s.ttftMs);
            timedCalls++;
            ttftSum += s.ttftMs;
            timedOut += s.outputTokens;
            timedLatMs += s.latencyMs;
            mItem.timedCalls++;
            mItem.timedOut += s.outputTokens;
            mItem.timedLatMs += s.latencyMs;
            if (sDur >= 3000) {
              streamOut += s.outputTokens;
              streamMs += sDur;
              mItem.streamOut += s.outputTokens;
              mItem.streamMs += sDur;
            }
          }
          mItem.estimatedCostUsd += s.estimatedCostUsd;
          mItem.cacheSavedUsd += s.cacheSavedUsd;
          modelAgg.set(mk, mItem);

          for (const tName of s.toolNames) {
            const tItem = toolAgg.get(tName) ?? { toolName: tName, invocationCount: 0, associatedOutputTokens: 0 };
            tItem.invocationCount++;
            tItem.associatedOutputTokens += s.outputTokens;
            toolAgg.set(tName, tItem);
          }
        }
      }

      // 3. 归一化比例、生成速率 TPS 并排序返回
      const totalTokens = inputTokens + cacheReadTokens + outputTokens;
      const promptTotal = inputTokens + cacheReadTokens;
      const avgOutputTps = timedLatMs > 0 ? Number((timedOut / (timedLatMs / 1000)).toFixed(1)) : 0;
      const avgStreamingTps =
        streamMs > 0 ? Number((streamOut / (streamMs / 1000)).toFixed(1)) : avgOutputTps;
      const totals: GlobalKpiTotals = {
        conversationCount: filtered.length, subagentCount, callCount,
        inputTokens, cacheReadTokens, outputTokens, thinkingTokens, responseTokens, totalTokens,
        cacheHitRate: promptTotal > 0 ? cacheReadTokens / promptTotal : 0,
        avgLatencyMs:
          timedCalls > 0
            ? Math.round(timedLatMs / timedCalls)
            : callCount > 0
              ? Math.round(latencySum / callCount)
              : 0,
        avgTtftMs: timedCalls > 0 ? Math.round(ttftSum / timedCalls) : 0,
        avgOutputTps,
        avgStreamingTps,
        estimatedCostUsd, cacheSavedUsd, todayTotalTokens, todayEstimatedCostUsd,
      };

      const byModel: ModelUsageBreakdown[] = [...modelAgg.values()]
        .map(({ convIds, latencySum: lSum, timedCalls: mTc, timedOut: mOut, timedLatMs: mLat, streamOut: mSOut, streamMs: mSMs, ...rest }) => {
          const pSum = rest.inputTokens + rest.cacheReadTokens;
          const mE2eTps = mLat > 0 ? Number((mOut / (mLat / 1000)).toFixed(1)) : 0;
          const mStreamTps = mSMs > 0 ? Number((mSOut / (mSMs / 1000)).toFixed(1)) : mE2eTps;
          return {
            ...rest,
            conversationCount: convIds.size,
            cacheHitRate: pSum > 0 ? rest.cacheReadTokens / pSum : 0,
            avgLatencyMs:
              mTc > 0 ? Math.round(mLat / mTc) : rest.callCount > 0 ? Math.round(lSum / rest.callCount) : 0,
            avgOutputTps: mE2eTps,
            avgStreamingTps: mStreamTps,
            shareOfTotalTokens: totalTokens > 0 ? rest.totalTokens / totalTokens : 0,
          };
        })
        .sort((a, b) => b.totalTokens - a.totalTokens);

      const byWorkspace: WorkspaceUsageBreakdown[] = [...wsAgg.values()]
        .map((w) => {
          const pSum = w.inputTokens + w.cacheReadTokens;
          const wsObs = wsTtlObsMap.get(w.workspaceName);
          return {
            ...w,
            cacheHitRate: pSum > 0 ? w.cacheReadTokens / pSum : 0,
            shareOfTotalTokens: totalTokens > 0 ? w.totalTokens / totalTokens : 0,
            ...(wsObs && wsObs.length > 0
              ? { cacheTtl: aggregateCacheTtlObservations(wsObs, true) }
              : {}),
          };
        })
        .sort((a, b) => b.totalTokens - a.totalTokens);

      const conversations = filtered
        .slice()
        .sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt))
        .map((c) => {
          const stripped = stripSteps(c);
          const ttl = convTtlMap.get(c.conversationId);
          return ttl ? { ...stripped, cacheTtl: ttl } : stripped;
        });

      // 3.1. 按时间升序生成逐次调用增量节点序列（严格遵守 nodeLimit 上限，避免高活跃日单次响应膨胀至 MB 级；今日全量汇总由 dailyTrend 今日桶提供）
      let callTimeline: CallNodePoint[] = [];
      if (options.nodeLimit !== 0) {
        rawStepEntries.sort((a, b) => {
          if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
          if (a.conv.conversationId !== b.conv.conversationId) {
            return a.conv.conversationId.localeCompare(b.conv.conversationId);
          }
          return a.step.callIndex - b.step.callIndex;
        });
        const effLimit =
          options.nodeLimit && options.nodeLimit > 0
            ? Math.min(MAX_CALL_TIMELINE_NODES, options.nodeLimit)
            : MAX_CALL_TIMELINE_NODES;
        const sliceStart = Math.max(0, rawStepEntries.length - effLimit);
        let runningAllTokens = 0;
        const runningByFamily = new Map<string, number>();
        for (let idx = 0; idx < rawStepEntries.length; idx++) {
          const { conv, rootConv, step } = rawStepEntries[idx];
          const modelLabel = step.modelName || "Unknown Model";
          const familyKey = modelLabel.replace(/\s*\([^)]*\)\s*$/g, "").trim().toLowerCase();
          runningAllTokens += step.totalTokens;
          const nextModelCum = (runningByFamily.get(familyKey) ?? 0) + step.totalTokens;
          runningByFamily.set(familyKey, nextModelCum);
          if (idx < sliceStart) continue;
          const outputTps =
            step.latencyMs > 0 && step.outputTokens > 0
              ? Number((step.outputTokens / (step.latencyMs / 1000)).toFixed(1))
              : 0;
          callTimeline.push({
            seq: idx + 1,
            conversationId: conv.conversationId,
            conversationTitle: conv.title || `会话 ${conv.conversationId.slice(0, 8)}`,
            rootConversationId: rootConv.conversationId,
            rootConversationTitle: rootConv.title || `会话 ${rootConv.conversationId.slice(0, 8)}`,
            callIndex: step.callIndex,
            timestamp: step.timestamp,
            modelName: modelLabel,
            inputTokens: step.inputTokens,
            cacheReadTokens: step.cacheReadTokens,
            outputTokens: step.outputTokens,
            totalTokens: step.totalTokens,
            cumulativeTokens: runningAllTokens,
            modelCumulativeTokens: nextModelCum,
            latencyMs: step.latencyMs,
            ttftMs: step.ttftMs,
            outputTps,
            estimatedCostUsd: step.estimatedCostUsd,
          });
        }
      }

      // 3.2. 读取官方 statusLine 实时周剩余快照，并在服务端对齐“采样时刻的整池累计消耗”作为校准分母
      const rawLiveQuota =
        !isolated || serviceOpts.liveQuotaPath
          ? readLiveQuotaSnapshots(serviceOpts.liveQuotaPath, nowMs, serviceOpts.expectedAccountEmail)
          : {};
      const liveQuota: typeof rawLiveQuota = {};
      for (const [poolKey, snap] of Object.entries(rawLiveQuota)) {
        const liveMs = Date.parse(snap.updatedAt);
        if (!Number.isFinite(liveMs) || liveMs <= 0) continue;
        const poolWin = computeQuotaCycleWindow(
          allDetails,
          poolKey,
          "7d",
          undefined,
          nowMs,
          useEnvAnchors,
          registeredResets
        ).quotaWindow;
        const winStartMs = poolWin.windowStart ? Date.parse(poolWin.windowStart) : 0;
        const winEndMs = poolWin.windowEnd ? Date.parse(poolWin.windowEnd) : 0;
        if (!poolWin.windowStart || winStartMs <= 0 || winEndMs <= winStartMs) continue;
        if (liveMs < winStartMs || liveMs >= winEndMs) continue;
        let poolCostUsdAtSample = 0;
        let poolTokensAtSample = 0;
        for (const c of allDetails) {
          const tsList = getStepsTimestampMs(c.steps);
          for (let i = 0; i < c.steps.length; i++) {
            const st = c.steps[i];
            const stMs = tsList[i];
            if (stMs < winStartMs || stMs > liveMs) continue;
            if (!matchesModelQuery(st.modelName, st.modelId, poolKey)) continue;
            poolCostUsdAtSample += st.estimatedCostUsd;
            poolTokensAtSample += st.totalTokens;
          }
        }
        liveQuota[poolKey] = {
          ...snap,
          windowStart: poolWin.windowStart,
          poolCostUsdAtSample,
          poolTokensAtSample,
        };
      }
      const payload: DashboardSummaryPayload = {
        health,
        totals,
        quotaWindow,
        callTimeline,
        dailyTrend: [...dayMap.values()]
          .map((b) => ({
            ...b,
            models: b.models
              ?.slice()
              .sort((a, m2) => m2.estimatedCostUsd - a.estimatedCostUsd || m2.totalTokens - a.totalTokens),
          }))
          .sort((a, b) => a.bucketKey.localeCompare(b.bucketKey)),
        hourlyTrend: [...hourMap.values()].sort((a, b) => a.bucketKey.localeCompare(b.bucketKey)).slice(-24),
        byModel,
        byWorkspace,
        topTools: [...toolAgg.values()].sort((a, b) => b.invocationCount - a.invocationCount).slice(0, 15),
        conversations,
        availableWorkspaces: [...wsSet].sort(),
        availableModels: [...modelSet].sort(),
        defaultPricing: pricing,
        cacheTtl: aggregateCacheTtlObservations(allTtlObs, true),
        ...(Object.keys(liveQuota).length > 0 ? { liveQuota } : {}),
      };
      if (summaryCache.size >= SUMMARY_CACHE_MAX) {
        const oldestKey = summaryCache.keys().next().value;
        if (oldestKey !== undefined) summaryCache.delete(oldestKey);
      }
      summaryCache.set(cacheKey, { payload, expiresAt: nowMs + SUMMARY_CACHE_TTL_MS });
      return payload;
    },

    /**
     * 职责：按会话 UUID 查询包含全量推理步的时间线详情。
     * 参数：conversationId — 会话唯一标识。
     * 返回值：匹配时返回 ConversationDetail，否则返回 null。
     */
    getConversationDetail(conversationId: string): ConversationDetail | null {
      // 0. 扫描缓存并精确匹配会话 ID
      const { conversations } = scanner.scan(false);
      return conversations.find((c) => c.conversationId === conversationId) ?? null;
    },

    /**
     * 职责：获取数据源健康检查摘要。
     * 返回值：DataSourceHealth。
     */
    getHealth() {
      // 0. 触发轻量增量扫描并返回健康对象
      return scanner.scan(false).health;
    },

    /** 职责：读取全部已登记的配额重置时间记录。 */
    getResets() {
      return resetStore ? resetStore.list() : [];
    },

    /** 职责：新增一条配额重置时间记录并立即失效聚合缓存。 */
    addReset(input) {
      if (!resetStore) throw new Error("当前测试上下文未启用重置记录存储");
      const next = resetStore.add(input);
      summaryCache.clear();
      return next;
    },

    /** 职责：按 ID 删除一条已登记的配额重置记录并立即失效聚合缓存。 */
    deleteReset(id) {
      if (!resetStore) throw new Error("当前测试上下文未启用重置记录存储");
      const next = resetStore.remove(id);
      summaryCache.clear();
      return next;
    },

    /** 职责：读取全部已持久化的周剩余%校准快照。 */
    getCalibrations() {
      return calibrationStore ? calibrationStore.list() : {};
    },

    /** 职责：严格读取周校准存储状态，文件损坏时明确返回错误而非折成已初始化空表。 */
    getCalibrationsState() {
      if (!calibrationStore) return { ok: true as const, calibrations: {}, initialized: false };
      return calibrationStore.readState();
    },

    /** 职责：判断服务端周校准存储文件是否已初始化（用于阻止旧客户端回填复活已删除记录）。 */
    isCalibrationsInitialized() {
      return calibrationStore ? calibrationStore.isInitialized() : false;
    },

    /** 职责：写入或更新一条周剩余%校准快照（服务端按时间戳保护较新校准）。 */
    setCalibration(key, value, options) {
      if (!calibrationStore) throw new Error("当前测试上下文未启用周校准存储");
      return calibrationStore.set(key, value, options);
    },

    /** 职责：首次迁移时整批原子验证落盘；若服务端已初始化则返回 conflict 保留权威状态。 */
    migrateCalibrationsBatch(entries) {
      if (!calibrationStore) throw new Error("当前测试上下文未启用周校准存储");
      return calibrationStore.migrateBatch(entries);
    },

    /** 职责：删除一条周剩余%校准快照（记录删除时间戳防旧采样复活，并拒绝早于当前值的迟到删除）。 */
    deleteCalibration(key, deletedAt) {
      if (!calibrationStore) throw new Error("当前测试上下文未启用周校准存储");
      return calibrationStore.remove(key, deletedAt);
    },
  };
}
