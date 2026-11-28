/**
 * Input: node:path、./sources、./scanner、./pricing、./aggregator 与 ../src/types/telemetry 类型契约。
 * Output: 导出 createMultiSourceTelemetryService()，统一管理本机原生与 T3 Code 多账号遥测聚合与状态隔离。
 * Pos: 服务端多数据源编排层，对上透明实现 TelemetryProvider 接口，零重复扫盘并隔离各账号校准与重置记录。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import path from "node:path";
import type {
  ConversationDetail,
  DashboardSummaryPayload,
  DataSourceHealth,
  DataSourceInfo,
  ModelPriceRate,
  QuotaCycleMode,
  TelemetryFilterOptions,
  TelemetryProvider,
} from "../src/types/telemetry";
import { createTelemetryService, type TelemetryServiceOptions } from "./aggregator";
import { DEFAULT_MODEL_PRICING } from "./pricing";
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
 * 职责：根据单源摘要结果构建对外展示的 DataSourceInfo 账单行。
 * 参数：meta — 数据源元信息；summary — 该数据源在同筛选条件下的汇总结果。
 * 返回值：DataSourceInfo 对象。
 */
function buildSourceInfo(
  meta: DiscoveredDataSource,
  summary: DashboardSummaryPayload
): DataSourceInfo {
  const lastActiveAt = summary.conversations.reduce(
    (latest, conv) => (conv.lastModifiedAt > latest ? conv.lastModifiedAt : latest),
    ""
  );
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
  };
}

/**
 * 职责：构建自动兼容原生 Antigravity 与 T3 Code 多账号的统一遥测服务。
 * 思路：1) 仅发现 1 个源时直接委托标准 createTelemetryService，保持零开销与完全向后兼容；
 *      2) 发现 >=2 个源时为各源建立独立重置/校准存储，并提供 "all" 合并总览与单账号精准切换。
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

  // 0. 单源退化路径：与历史单源行为完全一致，不引入多余 UI 与状态目录
  if (discovered.length <= 1) {
    const only = discovered[0];
    return createTelemetryService(only?.dataDir ?? customDataDir, pricing, options);
  }

  // 1.1. 为每个数据源创建共享扫描器与独立校准/重置存储的单源服务
  const entries: SourceEntry[] = discovered.map((meta) => {
    const rawScanner = createTelemetryScanner(meta.dataDir, pricing);
    const taggedScanner = createTaggedScanner(rawScanner, meta);
    const isolatedState = Boolean(options.isolated);
    const sourceOpts: TelemetryServiceOptions = {
      ...options,
      scanner: taggedScanner,
      ...(meta.stateDir && !isolatedState
        ? {
            resetsPath: path.join(meta.stateDir, "resets.json"),
            calibrationsPath: path.join(meta.stateDir, "calibrations.json"),
            liveQuotaPath: path.join(meta.stateDir, "live-quota.json"),
          }
        : {}),
    };
    return {
      meta,
      scanner: rawScanner,
      provider: createTelemetryService(meta.dataDir, pricing, sourceOpts),
    };
  });

  const entryById = new Map<string, SourceEntry>(entries.map((e) => [e.meta.id, e]));
  const mergedScanner = createMergedScanner(entries);
  const mergedProvider = createTelemetryService(undefined, pricing, {
    ...options,
    isolated: true,
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
    const perSourceOpts: TelemetryFilterOptions = { ...filterOpts, source: undefined };
    return entries
      .map((entry) => buildSourceInfo(entry.meta, entry.provider.getSummary(perSourceOpts)))
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
