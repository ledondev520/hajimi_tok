/**
 * Input: GlobalKpiTotals 与 ModelUsageBreakdown 类型、@/lib/format 格式化与周配额反算工具、@/components/ModelCallChart 模型配色解析器与 @/components/ui 基础组件。
 * Output: 导出 KpiCards 顶部单行四列紧凑型核心遥测指标卡片组件（第 4 卡支持按模型家族/档位拆解等效 API 成本及输入官方周剩余%反算周满额金额与总 Token）。
 * Pos: 看板首屏紧凑 KPI 概览层，单行并排展示四张高信息密度卡片（src/components/KpiCards.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BrainCircuit, Coins, Info, Layers, Zap } from "lucide-react";
import type {
  GlobalKpiTotals,
  LivePoolQuotaSnapshot,
  ModelUsageBreakdown,
  QuotaCycleInfo,
} from "@/types/telemetry";
import {
  computeWeeklyQuotaProjection,
  formatDateTime,
  formatDurationMs,
  formatExactNumber,
  formatPercent,
  formatTokens,
  formatUsd,
  readStoredJson,
  resolveWeeklyCalibration,
  writeStoredJson,
  type WeeklyQuotaCalibration,
} from "@/lib/format";
import { resolveModelStyle } from "@/components/ModelCallChart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const WEEKLY_CALIBRATION_STORAGE_KEY = "agy_weekly_quota_calibrations_v1"; // 本地持久化各池/周周期官方剩余%校准表

/** KpiCards 组件入参属性 */
export interface KpiCardsProps {
  totals: GlobalKpiTotals; // 全局聚合核心指标
  byModel?: ModelUsageBreakdown[]; // 按模型拆解的 Token 与等效 API 成本列表
  mainConversationCount: number; // 合并子代理后的顶层主会话数量
  activeModelLabel?: string; // 当前快捷选中的模型名称（为空表示全部模型）
  activePoolKey?: string; // 当前快捷选中的模型/配额池键（用于独立持久化周配额校准）
  quotaWindow?: QuotaCycleInfo; // 当前配额池的 5h/7d 周期窗口摘要
  liveQuota?: LivePoolQuotaSnapshot; // 可选：由 agy 官方 statusLine 桥接同步的实时官方周剩余
}

/**
 * 职责：紧凑渲染顶部四张核心指标卡片（总消耗、缓存命中率、输出拆解、等效成本与分模型拆解）。
 * 思路：采用 grid-cols-2 lg:grid-cols-4 保证宽屏一行四卡、分屏两列两行自适应，所有底栏支持 flex-wrap 防窄窗穿模溢出。
 * 参数：props — 包含 totals 核心统计、byModel 分模型拆解、mainConversationCount 主会话数及可选 activeModelLabel / quotaWindow。
 * 返回值：响应式四卡紧凑 KPI 网格节点。
 */
export function KpiCards({
  totals,
  byModel = [],
  mainConversationCount,
  activeModelLabel,
  activePoolKey = "",
  quotaWindow,
  liveQuota,
}: KpiCardsProps) {
  // 0. 周配额剩余百分比校准态（优先同步本机 ~/.hamiji-sta/calibrations.json，支持同周期锚点微调自动承接）
  const isWeeklyPoolView = Boolean(
    activePoolKey &&
      quotaWindow?.windowStart &&
      (quotaWindow.mode === "7d" || quotaWindow.mode.startsWith("window:"))
  );
  const calibrationKey = isWeeklyPoolView
    ? `${activePoolKey}:${quotaWindow!.windowStart}`
    : "";
  const [calibrations, setCalibrations] = useState<Record<string, WeeklyQuotaCalibration>>(() =>
    readStoredJson<Record<string, WeeklyQuotaCalibration>>(WEEKLY_CALIBRATION_STORAGE_KEY, {})
  );
  const matchedCalibration = useMemo(
    () =>
      isWeeklyPoolView
        ? resolveWeeklyCalibration(
            calibrations,
            activePoolKey,
            quotaWindow?.windowStart,
            quotaWindow?.windowEnd
          )
        : null,
    [calibrations, isWeeklyPoolView, activePoolKey, quotaWindow?.windowStart, quotaWindow?.windowEnd]
  );
  const activeCalibration = matchedCalibration?.calibration ?? null;
  const [draftPct, setDraftPct] = useState<string>(() =>
    activeCalibration ? String(activeCalibration.remainingPct) : ""
  );
  const isUserEditingRef = useRef(false);
  const prevCalibrationKeyRef = useRef(calibrationKey);
  const syncTimerRef = useRef<number | null>(null);
  const appliedLiveAtRef = useRef<string>("");

  // 0.0.1. 若本机装有 agy CLI 并通过官方 statusLine 写入更新的周剩余快照，自动回填至校准表并落盘
  useEffect(() => {
    if (!isWeeklyPoolView || !calibrationKey || !liveQuota) return;
    if (liveQuota.remainingPct < 0 || liveQuota.remainingPct >= 100) return;
    if (totals.totalTokens <= 0) return;
    const liveMs = Date.parse(liveQuota.updatedAt);
    const startMs = quotaWindow?.windowStart ? Date.parse(quotaWindow.windowStart) : 0;
    if (!Number.isFinite(liveMs) || (startMs > 0 && liveMs < startMs)) return;
    const liveSig = `${calibrationKey}|${liveQuota.updatedAt}|${liveQuota.remainingPct}`;
    if (appliedLiveAtRef.current === liveSig) return;
    const curAtMs = activeCalibration ? Date.parse(activeCalibration.calibratedAt || "") : 0;
    if (Number.isFinite(curAtMs) && curAtMs >= liveMs) {
      appliedLiveAtRef.current = liveSig;
      return;
    }
    appliedLiveAtRef.current = liveSig;
    const entry: WeeklyQuotaCalibration = {
      remainingPct: liveQuota.remainingPct,
      calibratedCostUsd: totals.estimatedCostUsd,
      calibratedTokens: totals.totalTokens,
      calibratedAt: liveQuota.updatedAt,
    };
    setCalibrations((prev) => {
      const next = { ...prev, [calibrationKey]: entry };
      writeStoredJson(WEEKLY_CALIBRATION_STORAGE_KEY, next);
      return next;
    });
    void fetch("/api/calibrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: calibrationKey, ...entry }),
    }).catch(() => undefined);
  }, [
    isWeeklyPoolView,
    calibrationKey,
    liveQuota,
    quotaWindow?.windowStart,
    totals.estimatedCostUsd,
    totals.totalTokens,
    activeCalibration,
  ]);

  // 0.0. 挂载时拉取服务端持久化校准表，并将浏览器历史 localStorage 校准一次性回填至服务端
  useEffect(() => {
    let cancelled = false;
    fetch("/api/calibrations")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { calibrations?: Record<string, WeeklyQuotaCalibration> } | null) => {
        if (cancelled || !data || !data.calibrations) return;
        const remote = data.calibrations;
        const local = readStoredJson<Record<string, WeeklyQuotaCalibration>>(
          WEEKLY_CALIBRATION_STORAGE_KEY,
          {}
        );
        const merged: Record<string, WeeklyQuotaCalibration> = { ...remote };
        const toBackfill: Array<[string, WeeklyQuotaCalibration]> = [];
        for (const [k, localVal] of Object.entries(local)) {
          const remoteVal = remote[k];
          if (
            !remoteVal ||
            Date.parse(localVal.calibratedAt || "") > Date.parse(remoteVal.calibratedAt || "")
          ) {
            merged[k] = localVal;
            toBackfill.push([k, localVal]);
          }
        }
        setCalibrations(merged);
        writeStoredJson(WEEKLY_CALIBRATION_STORAGE_KEY, merged);
        for (const [k, val] of toBackfill) {
          void fetch("/api/calibrations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: k, ...val }),
          }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const keyChanged = prevCalibrationKeyRef.current !== calibrationKey;
    prevCalibrationKeyRef.current = calibrationKey;
    if (keyChanged) {
      isUserEditingRef.current = false;
      setDraftPct(activeCalibration ? String(activeCalibration.remainingPct) : "");
      return;
    }
    if (!isUserEditingRef.current) {
      setDraftPct(activeCalibration ? String(activeCalibration.remainingPct) : "");
    }
  }, [calibrationKey, matchedCalibration?.key, activeCalibration?.remainingPct]);

  const weeklyProjection = useMemo(
    () =>
      computeWeeklyQuotaProjection(
        activeCalibration,
        totals.estimatedCostUsd,
        totals.totalTokens
      ),
    [activeCalibration, totals.estimatedCostUsd, totals.totalTokens]
  );

  /**
   * 职责：响应用户输入的官方周剩余百分比，持久化当前周期校准快照至本地与服务端 ~/.hamiji-sta/calibrations.json。
   * 参数：raw — 输入框文本（0 ~ 99 或空串）。
   */
  const handleRemainingPctChange = (raw: string) => {
    isUserEditingRef.current = true;
    setDraftPct(raw);
    if (!calibrationKey) {
      isUserEditingRef.current = false;
      return;
    }
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      const keysToRemove = Array.from(
        new Set([calibrationKey, matchedCalibration?.key].filter((k): k is string => Boolean(k)))
      );
      setCalibrations((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const k of keysToRemove) {
          if (k in next) {
            delete next[k];
            changed = true;
          }
        }
        if (!changed) return prev;
        writeStoredJson(WEEKLY_CALIBRATION_STORAGE_KEY, next);
        return next;
      });
      syncTimerRef.current = window.setTimeout(() => {
        isUserEditingRef.current = false;
        for (const k of keysToRemove) {
          void fetch(`/api/calibrations?key=${encodeURIComponent(k)}`, {
            method: "DELETE",
          }).catch(() => undefined);
        }
      }, 250);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 100) return;
    const entry: WeeklyQuotaCalibration = {
      remainingPct: parsed,
      calibratedCostUsd: totals.estimatedCostUsd,
      calibratedTokens: totals.totalTokens,
      calibratedAt: new Date().toISOString(),
    };
    setCalibrations((prev) => {
      const next: Record<string, WeeklyQuotaCalibration> = {
        ...prev,
        [calibrationKey]: entry,
      };
      writeStoredJson(WEEKLY_CALIBRATION_STORAGE_KEY, next);
      return next;
    });
    syncTimerRef.current = window.setTimeout(() => {
      isUserEditingRef.current = false;
      void fetch("/api/calibrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: calibrationKey, ...entry }),
      }).catch(() => undefined);
    }, 300);
  };

  // 0.1. 计算输入/缓存/输出占比与思考占比，防止除零
  const safeTotal = Math.max(1, totals.totalTokens); // 总量安全分母
  const inputPct = (totals.inputTokens / safeTotal) * 100; // 新增输入占比
  const cachePct = (totals.cacheReadTokens / safeTotal) * 100; // 缓存读取占比
  const outputPct = (totals.outputTokens / safeTotal) * 100; // 输出占比

  const safeOut = Math.max(1, totals.outputTokens); // 输出安全分母
  const thinkingPct = (totals.thinkingTokens / safeOut) * 100; // 思考占输出比例
  const responsePct = Math.max(0, 100 - thinkingPct); // 回复占输出比例

  // 0.1. 按模型家族归并等效 API 成本（如 Gemini 4 Argon vs Gemini 4 Carbon vs Opus 5.5）
  const familyCostMap = new Map<
    string,
    { familyKey: string; label: string; compactLabel: string; color: string; costUsd: number; tokens: number; calls: number }
  >();
  byModel.forEach((m, idx) => {
    const style = resolveModelStyle(m.modelName, idx);
    const cur = familyCostMap.get(style.familyKey);
    const compactLabel = style.shortLabel
      .replace(/^Gemini\s+(4\s+)?/i, "")
      .replace(/\s+\d+(\.\d+)?$/i, "");
    if (cur) {
      cur.costUsd += m.estimatedCostUsd;
      cur.tokens += m.totalTokens;
      cur.calls += m.callCount;
    } else {
      familyCostMap.set(style.familyKey, {
        familyKey: style.familyKey,
        label: style.shortLabel,
        compactLabel,
        color: style.color,
        costUsd: m.estimatedCostUsd,
        tokens: m.totalTokens,
        calls: m.callCount,
      });
    }
  });
  const familyCostSlices = [...familyCostMap.values()].sort((a, b) => b.costUsd - a.costUsd);
  const rawModelCostSlices = [...byModel].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  // 若当前池仅含单一家族但存在多个推理档位（如 Claude 池内 Medium / High），底栏直接按具体档位拆解
  const displayCostItems =
    familyCostSlices.length === 1 && rawModelCostSlices.length > 1
      ? rawModelCostSlices.map((m, idx) => ({
          key: m.modelName,
          label: m.modelName.replace(/^Claude\s+|^Gemini\s+4\s+/i, ""),
          color: idx === 0 ? familyCostSlices[0].color : "#6366f1",
          costUsd: m.estimatedCostUsd,
        }))
      : familyCostSlices.map((f) => ({
          key: f.familyKey,
          label: f.compactLabel,
          color: f.color,
          costUsd: f.costUsd,
        }));
  const safeCostTotal = Math.max(0.000001, totals.estimatedCostUsd);

  // 1.1. 渲染宽屏一行四列、分屏/窄窗两列两行的高密度卡片网格（全卡 min-w-0 overflow-hidden 杜绝穿模）
  return (
    <section
      aria-label="核心 Token 消耗指标概览"
      className="grid grid-cols-2 gap-2.5 lg:grid-cols-4"
    >
      {/* Card 1: 总消耗 Token（同步对照 5h 短周期与 7d 周周期） */}
      <Card className="min-w-0 gap-0 overflow-hidden border-slate-200/80 bg-white py-2 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
        <CardContent className="space-y-1 px-3">
          <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span className="truncate">
              {activeModelLabel ? `${activeModelLabel}消耗` : "总消耗"}
            </span>
            <Layers className="size-3.5 shrink-0 text-indigo-500" />
          </div>

          <div className="flex items-baseline justify-between gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-lg font-bold tracking-tight text-slate-950 tabular-nums dark:text-slate-50">
                  {formatTokens(totals.totalTokens)}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                精确总计: {formatExactNumber(totals.totalTokens)} tokens
              </TooltipContent>
            </Tooltip>
            {quotaWindow ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="h-4 cursor-default border border-indigo-500/20 bg-indigo-500/10 px-1.5 text-[10px] text-indigo-700 tabular-nums dark:bg-indigo-500/15 dark:text-indigo-300"
                  >
                    {quotaWindow.mode === "5h" || quotaWindow.mode === "prev-5h"
                      ? `7d周池 ${formatTokens(quotaWindow.active7dTokens)}`
                      : `本轮5h ${formatTokens(quotaWindow.active5hTokens)}`}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {quotaWindow.mode === "5h" || quotaWindow.mode === "prev-5h"
                    ? `当前 7d 周周期累计 ${formatTokens(quotaWindow.active7dTokens)}${
                        quotaWindow.active7dResetsAt
                          ? `（预计 ${formatDateTime(quotaWindow.active7dResetsAt).slice(0, 11)} 重置）`
                          : "（待触发）"
                      }`
                    : `当前 5h 周期累计 ${formatTokens(quotaWindow.active5hTokens)}${
                        quotaWindow.active5hResetsAt
                          ? `（预计 ${formatDateTime(quotaWindow.active5hResetsAt).slice(0, 11)} 重置）`
                          : "（已满血重置待触发）"
                      }`}
                </TooltipContent>
              </Tooltip>
            ) : (
              <Badge
                variant="secondary"
                className="h-4 border border-indigo-500/20 bg-indigo-500/10 px-1.5 text-[10px] text-indigo-700 tabular-nums dark:bg-indigo-500/15 dark:text-indigo-300"
              >
                今日 {formatTokens(totals.todayTotalTokens)}
              </Badge>
            )}
          </div>

          <div className="flex h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div style={{ width: `${cachePct}%` }} className="bg-emerald-500" />
            <div style={{ width: `${inputPct}%` }} className="bg-indigo-500" />
            <div style={{ width: `${outputPct}%` }} className="bg-amber-500" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
            <span>缓 {formatTokens(totals.cacheReadTokens)}</span>
            <span>新 {formatTokens(totals.inputTokens)}</span>
            <span>出 {formatTokens(totals.outputTokens)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Card 2: Prompt 缓存命中率 */}
      <Card className="min-w-0 gap-0 overflow-hidden border-slate-200/80 bg-white py-2 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
        <CardContent className="space-y-1 px-3">
          <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span className="truncate">缓存命中</span>
            <Zap className="size-3.5 shrink-0 text-emerald-500" />
          </div>

          <div className="flex items-baseline justify-between gap-1.5">
            <span className="text-lg font-bold tracking-tight text-slate-950 tabular-nums dark:text-slate-50">
              {formatPercent(totals.cacheHitRate)}
            </span>
            <Badge
              variant="secondary"
              className="h-4 border border-emerald-500/20 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-700 tabular-nums dark:bg-emerald-500/15 dark:text-emerald-300"
            >
              省 {formatUsd(totals.cacheSavedUsd)}
            </Badge>
          </div>

          <Progress
            aria-label="全局 Prompt 缓存命中率"
            value={Math.min(100, Math.max(0, totals.cacheHitRate * 100))}
            className="h-1 bg-slate-100 dark:bg-slate-800 [&_[data-slot=progress-indicator]]:bg-emerald-500"
          />

          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
            <span>缓存 {formatTokens(totals.cacheReadTokens)}</span>
            <span>新输入 {formatTokens(totals.inputTokens)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Card 3: 输出与思考拆解及 TPS 速率 */}
      <Card className="min-w-0 gap-0 overflow-hidden border-slate-200/80 bg-white py-2 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
        <CardContent className="space-y-1 px-3">
          <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span className="truncate">输出与速率</span>
            <BrainCircuit className="size-3.5 shrink-0 text-violet-500" />
          </div>

          <div className="flex items-baseline justify-between gap-1.5">
            <span className="text-lg font-bold tracking-tight text-slate-950 tabular-nums dark:text-slate-50">
              {formatTokens(totals.outputTokens)}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="h-4 cursor-default border-violet-500/30 px-1.5 text-[10px] text-violet-700 tabular-nums dark:text-violet-300"
                >
                  {totals.avgStreamingTps > 0
                    ? `${totals.avgStreamingTps.toFixed(1)} tok/s`
                    : `思考 ${totals.outputTokens > 0 ? `${thinkingPct.toFixed(0)}%` : "0%"}`}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {totals.avgStreamingTps > 0
                  ? `流式吐字 TPS：${totals.avgStreamingTps.toFixed(1)} tok/s（扣除首包等待） · 端到端有效 TPS：${totals.avgOutputTps.toFixed(1)} tok/s（均首包 TTFT ${formatDurationMs(totals.avgTtftMs)}）`
                  : "暂无已完成耗时记录，待模型落盘 gen_metadata 后自动计算 TPS"}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              style={{ width: `${totals.outputTokens > 0 ? thinkingPct : 0}%` }}
              className="bg-violet-500"
            />
            <div
              style={{ width: `${totals.outputTokens > 0 ? responsePct : 0}%` }}
              className="bg-amber-500"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
            <span>
              思考 {formatTokens(totals.thinkingTokens)}
              {totals.outputTokens > 0 ? ` (${thinkingPct.toFixed(0)}%)` : ""}
            </span>
            <span>回复 {formatTokens(totals.responseTokens)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Card 4: 等效成本与分模型拆解 */}
      <Card className="min-w-0 gap-0 overflow-hidden border-slate-200/80 bg-white py-2 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
        <CardContent className="space-y-1 px-3">
          <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1 truncate">
              等效成本
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="查看等效 API 成本分模型拆解说明"
                    className="inline-flex text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    <Info className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-none space-y-1.5 p-2.5 whitespace-nowrap">
                  <div className="font-medium text-slate-100 dark:text-slate-900">
                    按模型拆解等效 API 成本
                  </div>
                  <div className="space-y-1">
                    {rawModelCostSlices.map((m, idx) => {
                      const st = resolveModelStyle(m.modelName, idx);
                      const pct = totals.estimatedCostUsd > 0 ? (m.estimatedCostUsd / totals.estimatedCostUsd) * 100 : 0;
                      return (
                        <div key={m.modelName} className="flex items-center justify-between gap-4 text-[11px] tabular-nums">
                          <span className="inline-flex items-center gap-1.5">
                            <span style={{ backgroundColor: st.color }} className="inline-block size-1.5 shrink-0 rounded-full" />
                            <span>{m.modelName}</span>
                          </span>
                          <span className="shrink-0 font-mono">
                            {formatUsd(m.estimatedCostUsd)} ({pct.toFixed(0)}%)
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="border-t border-slate-700/60 pt-1 text-[10px] opacity-80 dark:border-slate-300/60">
                    主会话 {mainConversationCount}
                    {totals.subagentCount > 0 ? ` (+${totals.subagentCount}子)` : ""} ·{" "}
                    {formatExactNumber(totals.callCount)} 轮 · 均 {formatDurationMs(totals.avgLatencyMs)}
                  </div>
                </TooltipContent>
              </Tooltip>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-slate-400 tabular-nums">
              <span>
                {mainConversationCount}会话 · {formatExactNumber(totals.callCount)}轮
              </span>
              <Coins className="size-3.5 text-amber-500" />
            </span>
          </div>

          <div className="flex items-baseline justify-between gap-1.5">
            <span className="text-lg font-bold tracking-tight text-slate-950 tabular-nums dark:text-slate-50">
              {formatUsd(totals.estimatedCostUsd)}
            </span>
            <Badge
              variant="secondary"
              className="h-4 border border-amber-500/20 bg-amber-500/10 px-1.5 text-[10px] text-amber-700 tabular-nums dark:bg-amber-500/15 dark:text-amber-300"
            >
              今日 {formatUsd(totals.todayEstimatedCostUsd)}
            </Badge>
          </div>

          <div className="flex h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            {displayCostItems.length > 0 ? (
              displayCostItems.map((item) => (
                <div
                  key={item.key}
                  style={{
                    width: `${(item.costUsd / safeCostTotal) * 100}%`,
                    backgroundColor: item.color,
                  }}
                />
              ))
            ) : (
              <div className="h-full w-full bg-amber-500/70" />
            )}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex cursor-default flex-wrap items-center justify-between gap-x-1.5 gap-y-0.5 text-[10.5px] leading-tight text-slate-500 tabular-nums dark:text-slate-400">
                {displayCostItems.length > 0 ? (
                  displayCostItems.slice(0, 3).map((item) => (
                    <span key={item.key} className="inline-flex items-center gap-0.5 whitespace-nowrap">
                      <span
                        style={{ backgroundColor: item.color }}
                        className="inline-block size-1.5 shrink-0 rounded-full"
                      />
                      <span>{item.label}</span>
                      <strong className="font-medium text-slate-700 dark:text-slate-200">
                        {formatUsd(item.costUsd)}
                      </strong>
                    </span>
                  ))
                ) : (
                  <span>
                    主会话 <strong className="text-slate-700 dark:text-slate-200">{mainConversationCount}</strong>
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-none space-y-1 p-2.5 whitespace-nowrap">
              {rawModelCostSlices.map((m, idx) => {
                const st = resolveModelStyle(m.modelName, idx);
                return (
                  <div key={m.modelName} className="flex items-center justify-between gap-3 text-[11px] tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <span style={{ backgroundColor: st.color }} className="inline-block size-1.5 rounded-full" />
                      <span>{m.modelName}</span>
                    </span>
                    <span className="font-mono">
                      {formatUsd(m.estimatedCostUsd)} · {formatTokens(m.totalTokens)}
                    </span>
                  </div>
                );
              })}
            </TooltipContent>
          </Tooltip>

          {/* 单池 7d 周周期下：输入官方 Usage 周剩余%，实时反算 100% 周满额 API 金额与总 Token */}
          {isWeeklyPoolView && (
            <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-100 pt-1 text-[10.5px] tabular-nums dark:border-slate-800/80">
              <label className="inline-flex shrink-0 items-center gap-1 text-slate-500 dark:text-slate-400">
                <span>周剩</span>
                <Input
                  type="number"
                  min={0}
                  max={99}
                  step={1}
                  inputMode="decimal"
                  aria-label="输入官方周剩余百分比以反算周满额"
                  placeholder="--"
                  value={draftPct}
                  onChange={(e) => handleRemainingPctChange(e.target.value)}
                  onBlur={() => {
                    isUserEditingRef.current = false;
                  }}
                  className="h-5 w-11 px-1 text-center font-mono text-[11px] tabular-nums"
                />
                <span>%</span>
              </label>
              {weeklyProjection && activeCalibration ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="truncate font-mono text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                      满额 ≈ {formatUsd(weeklyProjection.fullCostUsd)} ·{" "}
                      {formatTokens(weeklyProjection.fullTokens)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs space-y-1 p-2.5 text-[11px] tabular-nums">
                    <div className="font-medium">
                      按官方周剩 {activeCalibration.remainingPct}% 反算（已用{" "}
                      {(100 - activeCalibration.remainingPct).toFixed(0)}%）
                    </div>
                    <div>
                      100% 周满额：{formatUsd(weeklyProjection.fullCostUsd)} ·{" "}
                      {formatTokens(weeklyProjection.fullTokens)} tokens
                    </div>
                    <div>
                      当前推算剩余：约 {weeklyProjection.estimatedRemainingPct.toFixed(1)}%（
                      {formatUsd(weeklyProjection.estimatedRemainingCostUsd)} ·{" "}
                      {formatTokens(weeklyProjection.estimatedRemainingTokens)}）
                    </div>
                    <div className="text-[10px] opacity-75">
                      校准基准：{formatUsd(activeCalibration.calibratedCostUsd)} /{" "}
                      {formatTokens(activeCalibration.calibratedTokens)}（
                      {formatDateTime(activeCalibration.calibratedAt).slice(0, 11)}）
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="truncate text-[10px] text-slate-400 dark:text-slate-500">
                  填剩余%反算满额
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
