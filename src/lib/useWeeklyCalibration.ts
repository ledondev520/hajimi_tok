/**
 * Input: React 钩子、GlobalKpiTotals/LivePoolQuotaSnapshot/QuotaCycleInfo 类型与 @/lib/format 周校准计算工具。
 * Output: 导出 useWeeklyCalibration Hook，封装周配额剩余%读取、服务端同步、官方 statusLine 自动回填与防抖写回逻辑。
 * Pos: 看板周配额校准状态逻辑层（src/lib/useWeeklyCalibration.ts），解耦 KpiCards 展示组件与网络同步细节。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GlobalKpiTotals, LivePoolQuotaSnapshot, QuotaCycleInfo } from "@/types/telemetry";
import {
  computeWeeklyQuotaProjection,
  readStoredJson,
  resolveWeeklyCalibration,
  writeStoredJson,
  type WeeklyQuotaCalibration,
} from "@/lib/format";

const WEEKLY_CALIBRATION_STORAGE_KEY = "agy_weekly_quota_calibrations_v1";

interface UseWeeklyCalibrationArgs {
  totals: GlobalKpiTotals;
  activePoolKey: string;
  quotaWindow?: QuotaCycleInfo;
  liveQuota?: LivePoolQuotaSnapshot;
  isWorkspaceFiltered: boolean;
  activeSource: string;
}

export function useWeeklyCalibration({
  totals,
  activePoolKey,
  quotaWindow,
  liveQuota,
  isWorkspaceFiltered,
  activeSource,
}: UseWeeklyCalibrationArgs) {
  const srcQ = activeSource && activeSource !== "all" ? `source=${encodeURIComponent(activeSource)}` : "";
  const calUrl = srcQ ? `/api/calibrations?${srcQ}` : "/api/calibrations";
  const calStoreKey = srcQ ? `${WEEKLY_CALIBRATION_STORAGE_KEY}:${activeSource}` : WEEKLY_CALIBRATION_STORAGE_KEY;

  const isWeeklyPoolView = Boolean(
    activePoolKey &&
      !isWorkspaceFiltered &&
      quotaWindow?.windowStart &&
      (quotaWindow.mode === "7d" || quotaWindow.mode.startsWith("window:"))
  );
  const [calibrationsSynced, setCalibrationsSynced] = useState(false);
  const [calibrationSyncError, setCalibrationSyncError] = useState("");
  const canWriteWeeklyCalibration = Boolean(calibrationsSynced && isWeeklyPoolView && quotaWindow?.mode === "7d");
  const calibrationKey = isWeeklyPoolView ? `${activePoolKey}:${quotaWindow!.windowStart}` : "";
  const [calibrations, setCalibrations] = useState<Record<string, WeeklyQuotaCalibration>>(() =>
    readStoredJson<Record<string, WeeklyQuotaCalibration>>(calStoreKey, {})
  );
  const matchedCalibration = useMemo(
    () =>
      isWeeklyPoolView
        ? resolveWeeklyCalibration(calibrations, activePoolKey, quotaWindow?.windowStart, quotaWindow?.windowEnd)
        : null,
    [calibrations, isWeeklyPoolView, activePoolKey, quotaWindow?.windowStart, quotaWindow?.windowEnd]
  );
  const activeCalibration = matchedCalibration?.calibration ?? null;
  const [draftPct, setDraftPct] = useState<string>(() => (activeCalibration ? String(activeCalibration.remainingPct) : ""));

  const userTouchedKeysRef = useRef<Set<string>>(new Set());
  const keyMutationSeqRef = useRef<Map<string, number>>(new Map());
  const deletedAtByKeyRef = useRef<Map<string, number>>(new Map());
  const isUserEditingRef = useRef(false);
  const prevCalibrationKeyRef = useRef(calibrationKey);
  const syncTimerRef = useRef<number | null>(null);
  const appliedLiveAtRef = useRef("");

  const bumpKeySeq = (k: string): number => {
    const next = (keyMutationSeqRef.current.get(k) ?? 0) + 1;
    keyMutationSeqRef.current.set(k, next);
    return next;
  };
  const syncAuthoritativeKey = (
    reqKey: string,
    reqSeq: number | undefined,
    payload: { calibrations?: Record<string, WeeklyQuotaCalibration> } | null
  ) => {
    if (!payload?.calibrations || keyMutationSeqRef.current.get(reqKey) !== reqSeq) return;
    const authoritative = payload.calibrations[reqKey];
    setCalibrations((prev) => {
      const next = { ...prev };
      if (authoritative) next[reqKey] = authoritative;
      else delete next[reqKey];
      writeStoredJson(calStoreKey, next);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(calUrl);
        if (!res.ok) {
          if (!cancelled) {
            const errJson = (await res.json().catch(() => null)) as { error?: string } | null;
            setCalibrationSyncError(errJson?.error || "周校准读取异常");
          }
          return;
        }
        const data = (await res.json()) as { calibrations?: Record<string, WeeklyQuotaCalibration>; initialized?: boolean } | null;
        if (cancelled || !data?.calibrations) return;

        if (data.initialized) {
          setCalibrations((prev) => {
            const next = { ...data.calibrations! };
            for (const k of userTouchedKeysRef.current) {
              if (k in prev) next[k] = prev[k];
              else delete next[k];
            }
            writeStoredJson(calStoreKey, next);
            return next;
          });
          setCalibrationSyncError("");
          setCalibrationsSynced(true);
          return;
        }

        const local = readStoredJson<Record<string, WeeklyQuotaCalibration>>(calStoreKey, {});
        if (Object.keys(local).length === 0) {
          setCalibrations(data.calibrations);
          writeStoredJson(calStoreKey, data.calibrations);
          setCalibrationSyncError("");
          setCalibrationsSynced(true);
          return;
        }

        const postRes = await fetch(calUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch: local }),
        });
        if (cancelled) return;
        const payload = (await postRes.json().catch(() => null)) as { calibrations?: Record<string, WeeklyQuotaCalibration>; error?: string } | null;
        if ((postRes.ok || postRes.status === 409) && payload?.calibrations) {
          setCalibrations(payload.calibrations);
          writeStoredJson(calStoreKey, payload.calibrations);
          setCalibrationSyncError("");
          setCalibrationsSynced(true);
        } else if (!cancelled) {
          setCalibrationSyncError(payload?.error || "历史校准迁移失败");
        }
      } catch {
        if (!cancelled) setCalibrationSyncError("周校准同步失败");
      }
    })();
    return () => {
      cancelled = true;
      if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
    };
  }, [calUrl, calStoreKey]);

  useEffect(() => {
    if (!calibrationsSynced || !canWriteWeeklyCalibration || !calibrationKey || !liveQuota) return;
    if (liveQuota.remainingPct < 0 || liveQuota.remainingPct >= 100) return;
    if (liveQuota.windowStart && liveQuota.windowStart !== quotaWindow?.windowStart) return;
    const liveMs = Date.parse(liveQuota.updatedAt);
    const startMs = quotaWindow?.windowStart ? Date.parse(quotaWindow.windowStart) : 0;
    const endMs = quotaWindow?.windowEnd ? Date.parse(quotaWindow.windowEnd) : 0;
    if (!Number.isFinite(liveMs) || (startMs > 0 && liveMs < startMs) || (endMs > 0 && liveMs >= endMs)) return;
    const sampleCostUsd = typeof liveQuota.poolCostUsdAtSample === "number" && liveQuota.poolCostUsdAtSample >= 0 ? liveQuota.poolCostUsdAtSample : totals.estimatedCostUsd;
    const sampleTokens = typeof liveQuota.poolTokensAtSample === "number" && liveQuota.poolTokensAtSample >= 0 ? liveQuota.poolTokensAtSample : totals.totalTokens;
    if (sampleTokens <= 0) return;
    const liveSig = `${calibrationKey}|${liveQuota.updatedAt}|${liveQuota.remainingPct}|${sampleTokens}`;
    if (appliedLiveAtRef.current === liveSig) return;
    const deletedMs = deletedAtByKeyRef.current.get(calibrationKey) ?? 0;
    const activeAtMs = activeCalibration ? Date.parse(activeCalibration.calibratedAt || "") : 0;
    if (Math.max(Number.isFinite(activeAtMs) ? activeAtMs : 0, deletedMs) >= liveMs) {
      appliedLiveAtRef.current = liveSig;
      return;
    }
    appliedLiveAtRef.current = liveSig;
    const reqKey = calibrationKey;
    const reqSeq = bumpKeySeq(reqKey);
    const entry: WeeklyQuotaCalibration = {
      remainingPct: liveQuota.remainingPct,
      calibratedCostUsd: sampleCostUsd,
      calibratedTokens: sampleTokens,
      calibratedAt: liveQuota.updatedAt,
    };
    void fetch(calUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: reqKey, source: "auto", ...entry }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => syncAuthoritativeKey(reqKey, reqSeq, payload))
      .catch(() => undefined);
  }, [calibrationsSynced, canWriteWeeklyCalibration, calibrationKey, liveQuota, quotaWindow?.windowStart, quotaWindow?.windowEnd, totals.estimatedCostUsd, totals.totalTokens, activeCalibration, calUrl]);

  useEffect(() => {
    const keyChanged = prevCalibrationKeyRef.current !== calibrationKey;
    prevCalibrationKeyRef.current = calibrationKey;
    if (keyChanged || !isUserEditingRef.current) {
      if (keyChanged) isUserEditingRef.current = false;
      setDraftPct(activeCalibration ? String(activeCalibration.remainingPct) : "");
    }
  }, [calibrationKey, matchedCalibration?.key, activeCalibration?.remainingPct]);

  const weeklyProjection = useMemo(
    () => computeWeeklyQuotaProjection(activeCalibration, totals.estimatedCostUsd, totals.totalTokens),
    [activeCalibration, totals.estimatedCostUsd, totals.totalTokens]
  );

  const handleRemainingPctChange = (raw: string) => {
    if (!canWriteWeeklyCalibration || !calibrationKey) return;
    isUserEditingRef.current = true;
    userTouchedKeysRef.current.add(calibrationKey);
    setDraftPct(raw);
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      const keysToRemove = Array.from(new Set([calibrationKey, matchedCalibration?.key].filter((k): k is string => Boolean(k))));
      const delSeqMap = new Map<string, number>();
      const deletedAtMs = Date.now();
      const deletedAtIso = new Date(deletedAtMs).toISOString();
      for (const k of keysToRemove) {
        delSeqMap.set(k, bumpKeySeq(k));
        deletedAtByKeyRef.current.set(k, deletedAtMs);
      }
      setCalibrations((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const k of keysToRemove) {
          if (k in next) { delete next[k]; changed = true; }
        }
        if (!changed) return prev;
        writeStoredJson(calStoreKey, next);
        return next;
      });
      syncTimerRef.current = window.setTimeout(() => {
        isUserEditingRef.current = false;
        for (const k of keysToRemove) {
          const reqSeq = delSeqMap.get(k);
          void fetch(`/api/calibrations?${srcQ ? `${srcQ}&` : ""}key=${encodeURIComponent(k)}&at=${encodeURIComponent(deletedAtIso)}`, { method: "DELETE" })
            .then((res) => (res.ok ? res.json() : null))
            .then((payload) => syncAuthoritativeKey(k, reqSeq, payload))
            .catch(() => undefined);
        }
      }, 250);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 100) return;
    const reqKey = calibrationKey;
    const reqSeq = bumpKeySeq(reqKey);
    deletedAtByKeyRef.current.delete(reqKey);
    const entry: WeeklyQuotaCalibration = {
      remainingPct: parsed,
      calibratedCostUsd: totals.estimatedCostUsd,
      calibratedTokens: totals.totalTokens,
      calibratedAt: new Date().toISOString(),
    };
    setCalibrations((prev) => {
      const next = { ...prev, [reqKey]: entry };
      writeStoredJson(calStoreKey, next);
      return next;
    });
    syncTimerRef.current = window.setTimeout(() => {
      isUserEditingRef.current = false;
      void fetch(calUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: reqKey, source: "manual", ...entry }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((payload) => syncAuthoritativeKey(reqKey, reqSeq, payload))
        .catch(() => undefined);
    }, 300);
  };

  return {
    isWeeklyPoolView,
    canWriteWeeklyCalibration,
    calibrationSyncError,
    activeCalibration,
    weeklyProjection,
    draftPct,
    handleRemainingPctChange,
    onDraftBlur: () => { isUserEditingRef.current = false; },
  };
}
