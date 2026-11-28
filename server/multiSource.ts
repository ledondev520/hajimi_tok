/**
 * Input: node:path、./sources、./scanner、./pricing、./aggregator、./resetStore、../src/lib/format 与 ../src/types/telemetry 类型契约。
 * Output: 导出 createMultiSourceTelemetryService()，统一管理本机原生与 T3 Code 多账号遥测聚合、同账号多目录合并、周剩余摘要及状态隔离。
 * Pos: 服务端多数据源编排层，对上透明实现 TelemetryProvider 接口，零重复扫盘并隔离各账号校准与重置记录。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import fs from "node:fs";
import os from "node:os";
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
import { resolveScanCachePath } from "./scanCache";
import { createTelemetryScanner, openSqliteSafe } from "./scanner";
import { createT3ThreadIndex, type T3ThreadIndex } from "./t3Threads";
import {
  discoverLocalDataSources,
  type DiscoveredDataSource,
  type DiscoverSourcesOptions,
} from "./sources";

/** 多数据源服务可选配置 */
export interface MultiSourceServiceOptions
  extends TelemetryServiceOptions, Omit<DiscoverSourcesOptions, "t3UserdataDir"> {
  sources?: DiscoveredDataSource[]; // 可选显式数据源列表（供单测注入）
}

type TelemetryScannerInstance = ReturnType<typeof createTelemetryScanner>;

interface SourceEntry {
  meta: DiscoveredDataSource;
  scanner: TelemetryScannerInstance;
  provider: TelemetryProvider;
  liveQuotaPath?: string;
}

/** 判定跨目录/跨源同 conversationId 的两条快照哪条更完整（优先步数更多、Token 更多、状态明确与更新时间更新） */
function isBetterConversationRecord(next: ConversationDetail, prev: ConversationDetail): boolean {
  if (next.steps.length !== prev.steps.length) return next.steps.length > prev.steps.length;
  if (next.totalTokens !== prev.totalTokens) return next.totalTokens > prev.totalTokens;
  const nextKnown = Boolean(next.status && next.status !== "unknown");
  const prevKnown = Boolean(prev.status && prev.status !== "unknown");
  if (nextKnown !== prevKnown) return nextKnown;
  return next.lastModifiedAt > prev.lastModifiedAt;
}

/**
 * 职责：通用组合扫描器——复用各子扫描器增量缓存，按 conversationId 去重择优，并汇总健康状态与告警。
 * 思路：同时服务于「同账号多目录合并」与「跨账号合并态 all」两类场景，消除重复合并状态机。
 */
function combineScanners(
  items: Array<{ key: string; scanner: TelemetryScannerInstance; tag?: DiscoveredDataSource }>,
  dataDirLabel: string
): TelemetryScannerInstance {
  let compositeSig = "";
  let combinedVersion = 0;
  let lastCombined: ReturnType<TelemetryScannerInstance["scan"]> | null = null;

  return {
    scan(forceRefresh = false) {
      const snaps = items.map((item) => ({ item, snap: item.scanner.scan(forceRefresh) }));
      const nextSig = snaps.map((x) => `${x.item.key}:${x.snap.version}`).join("|");
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

      for (const { item, snap } of snaps) {
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
        if (item.tag) {
          for (const w of snap.health.warnings) warnings.push(`[${item.tag.label}] ${w}`);
        } else {
          warnings.push(...snap.health.warnings);
        }
        for (const c of snap.conversations) {
          const rec: ConversationDetail = item.tag
            ? { ...c, sourceId: item.tag.id, sourceLabel: item.tag.label }
            : c;
          const prev = byConvId.get(rec.conversationId);
          if (!prev || isBetterConversationRecord(rec, prev)) {
            byConvId.set(rec.conversationId, rec);
          }
        }
      }

      lastCombined = {
        conversations: [...byConvId.values()],
        health: {
          dataDir: dataDirLabel,
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

/** 为单个逻辑账号合并多个本地数据目录（如 T3 ACP 目录 + 同 Google 账号的原生 ~/.gemini/antigravity 与 antigravity-cli） */
function createAccountDirScanner(
  dirs: string[],
  pricing: ModelPriceRate[],
  t3UserdataDir?: string | null,
  sharedT3ThreadIndex?: T3ThreadIndex,
  scanCacheRootDir?: string | null
): TelemetryScannerInstance {
  const uniqueDirs = [...new Set(dirs.filter(Boolean))];
  const toCachePath = (dir?: string) =>
    scanCacheRootDir && dir ? resolveScanCachePath(scanCacheRootDir, dir) : undefined;
  if (uniqueDirs.length <= 1) {
    return createTelemetryScanner(uniqueDirs[0], pricing, t3UserdataDir, sharedT3ThreadIndex, toCachePath(uniqueDirs[0]));
  }
  return combineScanners(
    uniqueDirs.map((dir) => ({
      key: dir,
      scanner: createTelemetryScanner(dir, pricing, t3UserdataDir, sharedT3ThreadIndex, toCachePath(dir)),
    })),
    `${uniqueDirs[0]} (+${uniqueDirs.length - 1} 目录)`
  );
}

/** 将单个数据源的增量扫描器包装为自动附加 sourceId / sourceLabel 的代理扫描器 */
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

/** 构造跨数据源合并扫描器，供合并态 "all" TelemetryProvider 使用 */
function createMergedScanner(entries: SourceEntry[]): TelemetryScannerInstance {
  return combineScanners(
    entries.map((e) => ({ key: e.meta.id, scanner: e.scanner, tag: e.meta })),
    `本机多账号合并 (${entries.length} 个数据源)`
  );
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
          t3UserdataDir: options.t3UserdataDir || undefined,
          stateRootDir: options.stateRootDir,
        });

  const isolatedState = Boolean(options.isolated);
  const resolvedStateRoot =
    options.stateRootDir ||
    process.env.AGY_STATE_DIR?.trim() ||
    path.join(options.homeDir ?? os.homedir(), ".hamiji-sta");
  const scanCacheRootDir = !isolatedState && !options.sources ? resolvedStateRoot : null;
  const t3DirForScanner =
    options.t3UserdataDir !== undefined ? options.t3UserdataDir : options.isolated ? null : undefined;
  const sharedT3ThreadIndex =
    t3DirForScanner === null ? undefined : createT3ThreadIndex(openSqliteSafe, t3DirForScanner);

  // 0. 单账号退化路径：与历史单源行为完全一致；若单账号自动归并了多个本地目录（如原生 App + CLI）则注入组合扫描器
  if (discovered.length <= 1) {
    const only = discovered[0];
    const targetDirs = only ? [only.dataDir, ...(only.extraDataDirs ?? [])] : [];
    const singleOpts: TelemetryServiceOptions = {
      ...options,
      t3UserdataDir: t3DirForScanner,
      ...(targetDirs.length > 0 && (targetDirs.length > 1 || scanCacheRootDir)
        ? {
            scanner: createAccountDirScanner(
              targetDirs,
              pricing,
              t3DirForScanner,
              sharedT3ThreadIndex,
              scanCacheRootDir
            ),
          }
        : {}),
      ...(only?.liveQuotaPath && !options.liveQuotaPath ? { liveQuotaPath: only.liveQuotaPath } : {}),
    };
    return createTelemetryService(only?.dataDir ?? customDataDir, pricing, singleOpts);
  }

  // 1.1. 为每个逻辑账号创建组合扫描器与独立校准/重置存储的单源服务（同时继承仓库公共强制重置日历 shared-resets.json）
  const sharedResetsPath =
    options.sharedResetsPath ?? (!isolatedState ? (resolveSharedResetsPath() ?? undefined) : undefined);
  const entries: SourceEntry[] = discovered.map((meta) => {
    const dirs = [meta.dataDir, ...(meta.extraDataDirs ?? [])];
    const rawScanner = createAccountDirScanner(dirs, pricing, t3DirForScanner, sharedT3ThreadIndex, scanCacheRootDir);
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

  // 多源组合响应缓存：数据版本、重置/校准代际与 live-quota 文件指纹均未变时直接复用同一对象引用（让 HTTP 层 ETag/gzip 零序列化命中）
  const MULTI_CACHE_TTL_MS = 15_000;
  const MULTI_CACHE_MAX = 24;
  let stateMutationGen = 0;
  const multiSummaryCache = new Map<string, { payload: DashboardSummaryPayload; expiresAt: number }>();

  const getLiveQuotaFilesSig = (): string =>
    entries
      .map((e) => {
        if (!e.liveQuotaPath) return "";
        try {
          const st = fs.statSync(e.liveQuotaPath);
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return "0";
        }
      })
      .join("|");

  const invalidateMultiCache = () => {
    stateMutationGen += 1;
    multiSummaryCache.clear();
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
        multiSummaryCache.clear();
      }
      const baseOpts: TelemetryFilterOptions = { ...filterOpts, source: undefined, forceRefresh: false };
      const scanSig = entries.map((e) => e.scanner.scan(false).version).join(",");
      const nowMs = filterOpts.nowMs ?? Date.now();
      const multiKey = JSON.stringify([
        activeSource,
        baseOpts.cycle ?? "all",
        baseOpts.days ?? 0,
        baseOpts.workspace ?? "",
        baseOpts.model ?? "",
        baseOpts.search ?? "",
        baseOpts.includeArchived !== false,
        baseOpts.nodeLimit ?? -1,
        baseOpts.nowMs ?? 0,
        scanSig,
        stateMutationGen,
        getLiveQuotaFilesSig(),
      ]);
      if (!filterOpts.forceRefresh) {
        const hit = multiSummaryCache.get(multiKey);
        if (hit && nowMs < hit.expiresAt) {
          return hit.payload;
        }
      }

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
      const assembled: DashboardSummaryPayload = {
        ...payload,
        activeSource,
        sources,
      };
      if (multiSummaryCache.size >= MULTI_CACHE_MAX) {
        const oldest = multiSummaryCache.keys().next().value;
        if (oldest !== undefined) multiSummaryCache.delete(oldest);
      }
      multiSummaryCache.set(multiKey, { payload: assembled, expiresAt: nowMs + MULTI_CACHE_TTL_MS });
      return assembled;
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
      const res = target.addReset(input);
      invalidateMultiCache();
      return res;
    },

    deleteReset(id: string, source?: string) {
      const target = resolveMutableEntry(source).provider;
      if (!target.deleteReset) throw new Error("当前数据源未启用重置记录存储");
      const res = target.deleteReset(id);
      invalidateMultiCache();
      return res;
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
      const res = target.setCalibration(key, value, opts);
      invalidateMultiCache();
      return res;
    },

    migrateCalibrationsBatch(entriesMap, sourceId?: string) {
      const target = resolveMutableEntry(sourceId).provider;
      if (!target.migrateCalibrationsBatch) throw new Error("当前数据源未启用周校准批量迁移");
      const res = target.migrateCalibrationsBatch(entriesMap);
      invalidateMultiCache();
      return res;
    },

    deleteCalibration(key, deletedAt, sourceId?: string) {
      const target = resolveMutableEntry(sourceId).provider;
      if (!target.deleteCalibration) throw new Error("当前数据源未启用周校准存储");
      const res = target.deleteCalibration(key, deletedAt);
      invalidateMultiCache();
      return res;
    },
  };
}
