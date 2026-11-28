/**
 * Input: node:path、./sources、./scanner、./pricing、./aggregator、./resetStore、../src/lib/format 与 ../src/types/telemetry 类型契约。
 * Output: 导出 createMultiSourceTelemetryService()，统一管理本机原生与 T3 Code 多账号遥测聚合、同账号多目录合并、周剩余摘要及状态隔离。
 * Pos: 服务端多数据源编排层，对上透明实现 TelemetryProvider 接口，零重复扫盘并隔离各账号校准与重置记录。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import path from "node:path";
import { computeWeeklyQuotaProjection, resolveWeeklyCalibration } from "../src/lib/format";
import type {
  ConversationDetail,
  DashboardSummaryPayload,
  DataSourceHealth,
  DataSourceInfo,
  ModelPriceRate,
  QuotaCycleMode,
  SourcePoolQuotaBadge,
  TelemetryFilterOptions,
  TelemetryProvider,
} from "../src/types/telemetry";
import { createTelemetryService, type TelemetryServiceOptions } from "./aggregator";
import { DEFAULT_MODEL_PRICING } from "./pricing";
import { readLiveQuotaSnapshots, resolveSharedResetsPath } from "./resetStore";
import { createTelemetryScanner } from "./scanner";
import {
  discoverLocalDataSources,
  type DiscoveredDataSource,
  type DiscoverSourcesOptions,
} from "./sources";

/** 多数据源服务可选配置 */
export interface MultiSourceServiceOptions extends TelemetryServiceOptions, DiscoverSourcesOptions {
  sources?: DiscoveredDataSource[]; // 可选显式数据源列表（供单测注入）
}

type TelemetryScannerInstance = ReturnType<typeof createTelemetryScanner>;

interface SourceEntry {
  meta: DiscoveredDataSource;
  scanner: TelemetryScannerInstance;
  provider: TelemetryProvider;
  liveQuotaPath?: string;
}

/**
 * 职责：为单个逻辑账号合并多个本地数据目录（如 T3 ACP 目录 + 同 Google 账号的原生 ~/.gemini/antigravity 与 antigravity-cli）的增量扫描结果。
 * 参数：dirs — 属于同一账号的目录列表；pricing — 费率表。
 * 返回值：透明兼容 createTelemetryScanner 的组合扫描器（按 conversationId 自动去重）。
 */
function createAccountDirScanner(
  dirs: string[],
  pricing: ModelPriceRate[]
): TelemetryScannerInstance {
  const uniqueDirs = [...new Set(dirs.filter(Boolean))];
  if (uniqueDirs.length <= 1) {
    return createTelemetryScanner(uniqueDirs[0], pricing);
  }
  const subScanners = uniqueDirs.map((dir) => ({
    dir,
    scanner: createTelemetryScanner(dir, pricing),
  }));
  let compositeSig = "";
  let combinedVersion = 0;
  let lastCombined: ReturnType<TelemetryScannerInstance["scan"]> | null = null;

  return {
    scan(forceRefresh = false) {
      const snaps = subScanners.map((s) => ({ dir: s.dir, snap: s.scanner.scan(forceRefresh) }));
      const nextSig = snaps.map((x) => `${x.dir}:${x.snap.version}`).join("|");
      if (lastCombined && !forceRefresh && nextSig === compositeSig) {
        return lastCombined;
      }
      compositeSig = nextSig;
      combinedVersion += 1;

      const byConvId = new Map<string, ConversationDetail>();
      let exists = false;
      let summaryDbAvailable = false;
      let conversationDbCount = 0;
      let transcriptCount = 0;
      let scanDurationMs = 0;
      let sqliteReadMode: DataSourceHealth["sqliteReadMode"] = "none";
      const warnings: string[] = [];

      for (const { snap } of snaps) {
        if (snap.health.exists) exists = true;
        if (snap.health.summaryDbAvailable) summaryDbAvailable = true;
        conversationDbCount += snap.health.conversationDbCount;
        transcriptCount += snap.health.transcriptCount;
        scanDurationMs += snap.health.scanDurationMs;
        if (snap.health.sqliteReadMode === "wal-readonly") {
          sqliteReadMode = "wal-readonly";
        } else if (sqliteReadMode === "none" && snap.health.sqliteReadMode === "immutable-fallback") {
          sqliteReadMode = "immutable-fallback";
        }
        warnings.push(...snap.health.warnings);
        for (const c of snap.conversations) {
          const prev = byConvId.get(c.conversationId);
          if (
            !prev ||
            c.steps.length > prev.steps.length ||
            (c.steps.length === prev.steps.length && c.lastModifiedAt > prev.lastModifiedAt)
          ) {
            byConvId.set(c.conversationId, c);
          }
        }
      }

      lastCombined = {
        conversations: [...byConvId.values()],
        health: {
          dataDir: `${uniqueDirs[0]} (+${uniqueDirs.length - 1} 目录)`,
          exists,
          summaryDbAvailable,
          conversationDbCount,
          transcriptCount,
          sqliteReadMode,
          scanDurationMs,
          scannedAt: new Date().toISOString(),
          warnings,
        },
        version: combinedVersion,
      };
      return lastCombined;
    },
  };
}

/**
 * 职责：将单个数据源的增量扫描器包装为自动附加 sourceId / sourceLabel 的代理扫描器。
 * 参数：scanner — 底层目录扫描器；meta — 数据源元信息。
 * 返回值：兼容 createTelemetryScanner 返回签名的代理扫描器。
 */
function createTaggedScanner(
  scanner: TelemetryScannerInstance,
  meta: DiscoveredDataSource
): TelemetryScannerInstance {
  let lastVersion = -1;
  let cachedTagged: ReturnType<TelemetryScannerInstance["scan"]> | null = null;
  return {
    scan(forceRefresh = false) {
      const snap = scanner.scan(forceRefresh);
      if (cachedTagged && !forceRefresh && snap.version === lastVersion) {
        return cachedTagged;
      }
      lastVersion = snap.version;
      cachedTagged = {
        ...snap,
        conversations: snap.conversations.map((c) => ({
          ...c,
          sourceId: meta.id,
          sourceLabel: meta.label,
        })),
      };
      return cachedTagged;
    },
  };
}

/**
 * 职责：构造跨数据源合并扫描器，复用各单源增量缓存并将全部会话与健康指标合并输出。
 * 参数：entries — 各数据源及其共享扫描器列表。
 * 返回值：供合并态 "all" TelemetryProvider 使用的扫描器。
 */
function createMergedScanner(entries: SourceEntry[]): TelemetryScannerInstance {
  let compositeSig = "";
  let mergedVersion = 0;
  let lastMerged: ReturnType<TelemetryScannerInstance["scan"]> | null = null;

  return {
    scan(forceRefresh = false) {
      const snaps = entries.map((e) => ({
        meta: e.meta,
        snap: e.scanner.scan(forceRefresh),
      }));
      const nextSig = snaps.map((x) => `${x.meta.id}:${x.snap.version}`).join("|");
      if (lastMerged && !forceRefresh && nextSig === compositeSig) {
        return lastMerged;
      }
      compositeSig = nextSig;
      mergedVersion += 1;

      const conversations: ConversationDetail[] = [];
      let exists = false;
      let summaryDbAvailable = false;
      let conversationDbCount = 0;
      let transcriptCount = 0;
      let scanDurationMs = 0;
      let sqliteReadMode: DataSourceHealth["sqliteReadMode"] = "none";
      const warnings: string[] = [];

      for (const { meta, snap } of snaps) {
        if (snap.health.exists) exists = true;
        if (snap.health.summaryDbAvailable) summaryDbAvailable = true;
        conversationDbCount += snap.health.conversationDbCount;
        transcriptCount += snap.health.transcriptCount;
        scanDurationMs += snap.health.scanDurationMs;
        if (snap.health.sqliteReadMode === "wal-readonly") {
          sqliteReadMode = "wal-readonly";
        } else if (sqliteReadMode === "none" && snap.health.sqliteReadMode === "immutable-fallback") {
          sqliteReadMode = "immutable-fallback";
        }
        for (const w of snap.health.warnings) warnings.push(`[${meta.label}] ${w}`);
        for (const c of snap.conversations) {
          conversations.push({
            ...c,
            sourceId: meta.id,
            sourceLabel: meta.label,
          });
        }
      }

      lastMerged = {
        conversations,
        health: {
          dataDir: `本机多账号合并 (${entries.length} 个数据源)`,
          exists,
          summaryDbAvailable,
          conversationDbCount,
          transcriptCount,
          sqliteReadMode,
          scanDurationMs,
          scannedAt: new Date().toISOString(),
          warnings,
        },
        version: mergedVersion,
      };
      return lastMerged;
    },
  };
}

/**
 * 职责：计算单个账号当前 7d 周周期下 Gemini / Claude 两池的周剩余百分比摘要（优先采用较新的 agy 官方实时值，其次采用手工校准实时推算值）。
 * 参数：entry — 数据源条目；explicitNowMs — 可选确定性基准时间戳（仅单测传入，避免击穿 15s 聚合缓存）。
 * 返回值：包含 gemini / claude 徽章的对象，均无数据时返回 undefined。
 */
function resolveSourceWeeklyQuota(
  entry: SourceEntry,
  explicitNowMs?: number
): DataSourceInfo["weeklyQuota"] {
  const rawLive = entry.liveQuotaPath
    ? readLiveQuotaSnapshots(entry.liveQuotaPath, explicitNowMs ?? Date.now(), entry.meta.accountEmail)
    : {};
  const calibrations = entry.provider.getCalibrations?.() ?? {};
  const out: NonNullable<DataSourceInfo["weeklyQuota"]> = {};

  for (const [badgeKey, poolKey] of [
    ["gemini", "pool:gemini"],
    ["claude", "pool:claude"],
  ] as const) {
    const poolSummary = entry.provider.getSummary({
      cycle: "7d",
      model: poolKey,
      nodeLimit: 0,
      ...(explicitNowMs !== undefined ? { nowMs: explicitNowMs } : {}),
    });
    const live = poolSummary.liveQuota?.[poolKey] ?? rawLive[poolKey];
    const matchedCal = resolveWeeklyCalibration(
      calibrations,
      poolKey,
      poolSummary.quotaWindow?.windowStart,
      poolSummary.quotaWindow?.windowEnd
    )?.calibration;

    const liveMs = live ? Date.parse(live.updatedAt) : 0;
    const calMs = matchedCal ? Date.parse(matchedCal.calibratedAt) : 0;
    let badge: SourcePoolQuotaBadge | undefined;

    if (live && (!matchedCal || (Number.isFinite(liveMs) && liveMs >= (Number.isFinite(calMs) ? calMs : 0)))) {
      badge = {
        remainingPct: Math.round(live.remainingPct * 10) / 10,
        source: "live",
        ...(live.resetTime ? { resetTime: live.resetTime } : {}),
        ...(live.updatedAt ? { updatedAt: live.updatedAt } : {}),
      };
    } else if (matchedCal) {
      const proj = computeWeeklyQuotaProjection(
        matchedCal,
        poolSummary.totals.estimatedCostUsd,
        poolSummary.totals.totalTokens
      );
      if (proj) {
        badge = {
          remainingPct: Math.round(proj.estimatedRemainingPct * 10) / 10,
          source: "calibrated",
          ...(poolSummary.quotaWindow?.windowEnd ? { resetTime: poolSummary.quotaWindow.windowEnd } : {}),
          ...(matchedCal.calibratedAt ? { updatedAt: matchedCal.calibratedAt } : {}),
        };
      }
    }

    if (badge) {
      out[badgeKey] = badge;
    }
  }

  return out.gemini || out.claude ? out : undefined;
}

/**
 * 职责：根据单源摘要结果构建对外展示的 DataSourceInfo 账单行（附带同账号归并端标记与 7d 周剩余摘要）。
 * 参数：entry — 数据源条目；summary — 该数据源在同筛选条件下的汇总结果；explicitNowMs — 可选单测时间戳。
 * 返回值：DataSourceInfo 对象。
 */
function buildSourceInfo(
  entry: SourceEntry,
  summary: DashboardSummaryPayload,
  explicitNowMs?: number
): DataSourceInfo {
  const { meta } = entry;
  const lastActiveAt = summary.conversations.reduce(
    (latest, conv) => (conv.lastModifiedAt > latest ? conv.lastModifiedAt : latest),
    ""
  );
  const weeklyQuota = resolveSourceWeeklyQuota(entry, explicitNowMs);
  return {
    id: meta.id,
    label: meta.label,
    kind: meta.kind,
    dataDir: meta.dataDir,
    exists: summary.health.exists,
    conversationCount: summary.totals.conversationCount,
    callCount: summary.totals.callCount,
    totalTokens: summary.totals.totalTokens,
    todayTotalTokens: summary.totals.todayTotalTokens,
    todayEstimatedCostUsd: summary.totals.todayEstimatedCostUsd,
    estimatedCostUsd: summary.totals.estimatedCostUsd,
    cacheHitRate: summary.totals.cacheHitRate,
    lastActiveAt,
    ...(meta.mergedKinds && meta.mergedKinds.length > 1 ? { mergedKinds: meta.mergedKinds } : {}),
    ...(weeklyQuota ? { weeklyQuota } : {}),
  };
}

/**
 * 职责：构建自动兼容原生 Antigravity 与 T3 Code 多账号的统一遥测服务。
 * 思路：1) 仅发现 1 个逻辑账号时直接委托标准 createTelemetryService（支持单账号多目录透明合并），保持零开销与向后兼容；
 *      2) 发现 >=2 个逻辑账号时为各账号建立独立重置/校准存储，按账号精准绑定官方 live-quota.json，并提供 "all" 合并总览与单账号精准切换。
 * 参数：customDataDir — 可选自定义目录；customRates — 可选模型单价表；options — 可选隔离与路径覆盖项。
 * 返回值：实现 TelemetryProvider 契约的服务实例。
 */
export function createMultiSourceTelemetryService(
  customDataDir?: string,
  customRates?: ModelPriceRate[],
  options: MultiSourceServiceOptions = {}
): TelemetryProvider {
  const pricing = customRates && customRates.length > 0 ? customRates : DEFAULT_MODEL_PRICING;
  const discovered =
    options.sources && options.sources.length > 0
      ? options.sources
      : discoverLocalDataSources({
          customDataDir,
          homeDir: options.homeDir,
          t3UserdataDir: options.t3UserdataDir,
          stateRootDir: options.stateRootDir,
        });

  // 0. 单账号退化路径：与历史单源行为完全一致；若单账号自动归并了多个本地目录（如原生 App + CLI）则注入组合扫描器
  if (discovered.length <= 1) {
    const only = discovered[0];
    const singleOpts: TelemetryServiceOptions = {
      ...options,
      ...(only?.extraDataDirs && only.extraDataDirs.length > 0
        ? { scanner: createAccountDirScanner([only.dataDir, ...only.extraDataDirs], pricing) }
        : {}),
      ...(only?.liveQuotaPath && !options.liveQuotaPath ? { liveQuotaPath: only.liveQuotaPath } : {}),
    };
    return createTelemetryService(only?.dataDir ?? customDataDir, pricing, singleOpts);
  }

  // 1.1. 为每个逻辑账号创建组合扫描器与独立校准/重置存储的单源服务（同时继承仓库公共强制重置日历 shared-resets.json）
  const isolatedState = Boolean(options.isolated);
  const sharedResetsPath =
    options.sharedResetsPath ?? (!isolatedState ? (resolveSharedResetsPath() ?? undefined) : undefined);
  const entries: SourceEntry[] = discovered.map((meta) => {
    const dirs = [meta.dataDir, ...(meta.extraDataDirs ?? [])];
    const rawScanner = createAccountDirScanner(dirs, pricing);
    const taggedScanner = createTaggedScanner(rawScanner, meta);
    const resolvedLiveQuotaPath =
      meta.liveQuotaPath ??
      (meta.stateDir && !isolatedState ? path.join(meta.stateDir, "live-quota.json") : undefined);
    const sourceOpts: TelemetryServiceOptions = {
      ...options,
      scanner: taggedScanner,
      ...(sharedResetsPath ? { sharedResetsPath } : {}),
      ...(meta.stateDir && !isolatedState
        ? {
            resetsPath: path.join(meta.stateDir, "resets.json"),
            calibrationsPath: path.join(meta.stateDir, "calibrations.json"),
          }
        : {}),
      ...(resolvedLiveQuotaPath ? { liveQuotaPath: resolvedLiveQuotaPath } : {}),
      ...(meta.accountEmail ? { expectedAccountEmail: meta.accountEmail } : {}),
    };
    return {
      meta,
      scanner: rawScanner,
      provider: createTelemetryService(meta.dataDir, pricing, sourceOpts),
      liveQuotaPath: resolvedLiveQuotaPath,
    };
  });

  const entryById = new Map<string, SourceEntry>(entries.map((e) => [e.meta.id, e]));
  const mergedScanner = createMergedScanner(entries);
  const mergedProvider = createTelemetryService(undefined, pricing, {
    ...options,
    isolated: true,
    resetsPath: null,
    ...(sharedResetsPath ? { sharedResetsPath } : {}),
    useEnvAnchors: false,
    scanner: mergedScanner,
  });

  const resolveMutableEntry = (sourceId?: string): SourceEntry => {
    const trimmed = sourceId?.trim();
    if (trimmed && trimmed !== "all") {
      const hit = entryById.get(trimmed);
      if (hit) return hit;
    }
    return entryById.get("native") ?? entries[0];
  };

  const buildSourcesList = (filterOpts: TelemetryFilterOptions = {}): DataSourceInfo[] => {
    const perSourceOpts: TelemetryFilterOptions = { ...filterOpts, source: undefined, nodeLimit: 0 };
    return entries
      .map((entry) => buildSourceInfo(entry, entry.provider.getSummary(perSourceOpts), filterOpts.nowMs))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalTokens - a.totalTokens);
  };

  return {
    getSources() {
      return buildSourcesList({ cycle: "all" });
    },

    getSummary(filterOpts: TelemetryFilterOptions = {}): DashboardSummaryPayload {
      const requested = filterOpts.source?.trim();
      const targetEntry = requested && requested !== "all" ? entryById.get(requested) : undefined;
      const activeSource = targetEntry ? targetEntry.meta.id : "all";
      if (filterOpts.forceRefresh) {
        for (const entry of entries) entry.scanner.scan(true);
      }
      const baseOpts: TelemetryFilterOptions = { ...filterOpts, source: undefined, forceRefresh: false };
      const payload = targetEntry
        ? targetEntry.provider.getSummary(baseOpts)
        : mergedProvider.getSummary(baseOpts);
      // 合并视图下按主视图同一时间窗口切分各账号分摊，确保「全部账号」卡片金额/Token 与下方 KPI 完全一致
      const startMs = payload.quotaWindow?.windowStart ? Date.parse(payload.quotaWindow.windowStart) : NaN;
      const endMs = payload.quotaWindow?.windowEnd ? Date.parse(payload.quotaWindow.windowEnd) : NaN;
      const alignedCycle: QuotaCycleMode | undefined =
        activeSource === "all" &&
        baseOpts.cycle &&
        baseOpts.cycle !== "all" &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        endMs > startMs
          ? (`window:${startMs}:${endMs}` as QuotaCycleMode)
          : undefined;
      const sources = buildSourcesList(
        alignedCycle ? { ...baseOpts, cycle: alignedCycle } : baseOpts
      );
      return {
        ...payload,
        activeSource,
        sources,
      };
    },

    getConversationDetail(conversationId: string, source?: string): ConversationDetail | null {
      const trimmed = source?.trim();
      if (trimmed && trimmed !== "all") {
        const hit = entryById.get(trimmed);
        if (hit) {
          const detail = hit.provider.getConversationDetail(conversationId);
          if (detail) return detail;
        }
      }
      for (const entry of entries) {
        const detail = entry.provider.getConversationDetail(conversationId);
        if (detail) return detail;
      }
      return null;
    },

    getHealth(source?: string): DataSourceHealth {
      const trimmed = source?.trim();
      if (trimmed && trimmed !== "all") {
        const hit = entryById.get(trimmed);
        if (hit) return hit.provider.getHealth();
      }
      return mergedProvider.getHealth();
    },

    getResets(source?: string) {
      return resolveMutableEntry(source).provider.getResets?.() ?? [];
    },

    addReset(input, source?: string) {
      const target = resolveMutableEntry(source).provider;
      if (!target.addReset) throw new Error("当前数据源未启用重置记录存储");
      return target.addReset(input);
    },

    deleteReset(id: string, source?: string) {
      const target = resolveMutableEntry(source).provider;
      if (!target.deleteReset) throw new Error("当前数据源未启用重置记录存储");
      return target.deleteReset(id);
    },

    getCalibrations(source?: string) {
      return resolveMutableEntry(source).provider.getCalibrations?.() ?? {};
    },

    getCalibrationsState(source?: string) {
      const target = resolveMutableEntry(source).provider;
      if (target.getCalibrationsState) return target.getCalibrationsState();
      return { ok: true as const, calibrations: {}, initialized: false };
    },

    isCalibrationsInitialized(source?: string) {
      return resolveMutableEntry(source).provider.isCalibrationsInitialized?.() ?? false;
    },

    setCalibration(key, value, opts, sourceId?: string) {
      const target = resolveMutableEntry(sourceId).provider;
      if (!target.setCalibration) throw new Error("当前数据源未启用周校准存储");
      return target.setCalibration(key, value, opts);
    },

    migrateCalibrationsBatch(entriesMap, sourceId?: string) {
      const target = resolveMutableEntry(sourceId).provider;
      if (!target.migrateCalibrationsBatch) throw new Error("当前数据源未启用周校准批量迁移");
      return target.migrateCalibrationsBatch(entriesMap);
    },

    deleteCalibration(key, deletedAt, sourceId?: string) {
      const target = resolveMutableEntry(sourceId).provider;
      if (!target.deleteCalibration) throw new Error("当前数据源未启用周校准存储");
      return target.deleteCalibration(key, deletedAt);
    },
  };
}
