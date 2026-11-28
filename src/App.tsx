/**
 * Input: React 状态/副作用/记忆化钩子、@/types/telemetry 类型、@/components 业务组件、@/components/ui 基础组件与 lucide-react 图标。
 * Output: 导出 App 紧凑高密度版统计主界面与 buildModelShortcuts 动态模型家族快捷项生成器。
 * Pos: 前端单页根组件，自动识别本机已用模型生成顶栏快捷切换并展示单行四卡与主会话折叠表。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, CalendarDays, Moon, Sun } from "lucide-react";
import type {
  ConversationUsageSummary,
  DashboardSummaryPayload,
  QuotaCycleMode,
} from "@/types/telemetry";
import {
  formatCycleCountdown,
  formatDateTime,
  formatTokens,
  readStoredJson,
  writeStoredJson,
} from "@/lib/format";
import { CacheHitRateCard } from "@/components/CacheHitRateCard";
import { DailyUsageCard } from "@/components/DailyUsageCard";
import { KpiCards } from "@/components/KpiCards";
import { ModelCallChart, type NodeWindowKey } from "@/components/ModelCallChart";
import {
  ConversationExplorer,
  groupByMainConversation,
} from "@/components/ConversationExplorer";
import { ConversationDetailDialog } from "@/components/ConversationDetailDialog";
import { ResetCalendarPage } from "@/components/ResetCalendarPage";
import { SourceSwitcherBar } from "@/components/SourceSwitcherBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const THEME_STORAGE_KEY = "agy_theme_mode"; // 本地持久化白天/深色主题偏好的键名
const CYCLE_STORAGE_KEY = "agy_quota_cycle_v2"; // 本地持久化配额周期选择偏好的键名（默认 7d 周周期）
const VALID_CYCLE_SET = new Set<QuotaCycleMode>(["7d", "prev-7d", "all"]); // 固定枚举周期集合
const WINDOW_CYCLE_RE = /^window:\d+:\d+$/; // 任意历史 7 天周期窗口标识正则

/** 顶栏配额池快捷切换项结构 */
export interface ModelShortcutItem {
  tabValue: string; // Tabs 唯一值
  modelQuery: string; // 传给 /api/summary?model= 的配额池标识（如 pool:claude / pool:gemini）
  label: string; // 顶栏紧凑展示名称（如 Claude 池 / Gemini 池）
  tooltip: string; // 悬停说明当前池涵盖的具体模型列表
  hotkey: string; // 数字快捷键（1~9）
}

/** 主题模式枚举（默认 light 白天模式） */
type ThemeMode = "light" | "dark";

/**
 * 职责：按 AntiGravity 配额池规则生成顶栏快捷切换项，将 Opus 5.5 与后续 Sonnet 5.5 等归入同一「Claude 池」，Gemini 全系归入独立「Gemini 池」。
 * 思路：1) 扫描本机已出现的模型并归类到 Claude 池、Gemini 池或第三方池；2) 始终保持「全部 [1] / Claude 池 [2] / Gemini 池 [3]」双池清晰区分，池内新增同系模型（如 Sonnet 5.5）自动合并进同池页面而非拆散新标签。
 * 参数：availableModels — 服务端扫描出的本机全部已出现模型名称数组。
 * 返回值：配额池快捷切换项数组。
 */
export function buildModelShortcuts(availableModels: string[]): ModelShortcutItem[] {
  // 0. 清洗已出现的模型短名并按配额池归类展示在悬停说明中
  const claudeModels = new Set<string>();
  const geminiModels = new Set<string>();
  const otherFamilies = new Map<string, string>();

  for (const raw of availableModels) {
    const base = raw.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    const lower = base.toLowerCase();
    if (!base || lower === "unknown model" || lower.includes("gpt-oss")) continue;

    if (
      lower.includes("claude") ||
      lower.includes("opus") ||
      lower.includes("sonnet") ||
      lower.includes("haiku") ||
      lower.includes("anthropic")
    ) {
      claudeModels.add(base.replace(/^claude\s+/i, "").trim());
    } else if (
      lower.includes("gemini") ||
      lower.includes("argon") ||
      lower.includes("carbon") ||
      lower.includes("flash")
    ) {
      geminiModels.add(base);
    } else if (!otherFamilies.has(lower)) {
      otherFamilies.set(lower, base);
    }
  }

  // 1.1. 固定生成「全部 [1]」「Claude 池 [2]」「Gemini 池 [3]」三大核心视图
  const claudeDesc =
    claudeModels.size > 0
      ? `同池共享配额（当前已含：${[...claudeModels].join("、")}；新增 Sonnet / Opus 自动归入本页）`
      : "Claude 系列共享配额池（Opus 5.5 / Sonnet 5.5 等自动归入本页）";
  const geminiDesc =
    geminiModels.size > 0
      ? `Gemini 系列独立配额池（当前已含：${[...geminiModels].join("、")}）`
      : "Gemini 全系列独立配额池";

  const items: ModelShortcutItem[] = [
    {
      tabValue: "all",
      modelQuery: "",
      label: "全部",
      tooltip: "汇总全部配额池的总体消耗",
      hotkey: "1",
    },
    {
      tabValue: "pool:claude",
      modelQuery: "pool:claude",
      label: "Claude 池",
      tooltip: claudeDesc,
      hotkey: "2",
    },
    {
      tabValue: "pool:gemini",
      modelQuery: "pool:gemini",
      label: "Gemini 池",
      tooltip: geminiDesc,
      hotkey: "3",
    },
  ];

  // 1.2. 若未来出现非 Claude / 非 Gemini 的其他独立模型池，从快捷键 4 起顺延追加
  let nextKey = 4;
  for (const [query, label] of otherFamilies.entries()) {
    items.push({
      tabValue: query,
      modelQuery: query,
      label,
      tooltip: `${label} 独立模型统计`,
      hotkey: nextKey <= 9 ? String(nextKey) : "",
    });
    nextKey += 1;
  }

  return items;
}

/**
 * 职责：读取初始主题偏好，默认使用清爽的白天（light）模式。
 * 返回值："light" 或 "dark"。
 */
function resolveInitialTheme(): ThemeMode {
  // 0. 优先读取 localStorage，未设置时默认返回白天模式
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * 职责：读取初始配额周期模式，默认选中「当前 7d 周周期」。
 * 返回值：QuotaCycleMode 枚举值。
 */
function resolveInitialCycle(): QuotaCycleMode {
  // 0. 优先读取 localStorage，未设置或非法时默认返回 "7d"
  try {
    const saved = window.localStorage.getItem(CYCLE_STORAGE_KEY);
    return saved && (VALID_CYCLE_SET.has(saved as QuotaCycleMode) || WINDOW_CYCLE_RE.test(saved))
      ? (saved as QuotaCycleMode)
      : "7d";
  } catch {
    return "7d";
  }
}

/**
 * 职责：渲染高密度紧凑版 AntiGravity 会话 Token 统计主视图。
 * 思路：1) 顶部紧凑单行四卡；2) 下方仅按主会话行展示（Subagent 自动合并折叠在对应主会话下）；3) 支持白天/深色一键切换。
 * 参数：无。
 * 返回值：React 根视图节点。
 */
export function App() {
  // 0. 独立重置日历页面路由（支持新标签页直开 /calendar）
  if (typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/calendar") {
    return <ResetCalendarPage />;
  }

  // 0.1. 筛选、主题与详情弹窗状态（配额池、项目、节点窗口与周期均持久化至 localStorage）
  const initViewPrefs = useMemo(
    () =>
      readStoredJson<{
        selectedSource?: string;
        selectedModel?: string;
        selectedWorkspace?: string;
        chartWindow?: NodeWindowKey;
      }>("agy_dashboard_view_prefs_v1", {}),
    []
  );
  const [selectedSource, setSelectedSource] = useState<string>(initViewPrefs.selectedSource ?? "all");
  const [appliedSource, setAppliedSource] = useState<string>(initViewPrefs.selectedSource ?? "all");
  const [cycle, setCycle] = useState<QuotaCycleMode>(resolveInitialCycle);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(initViewPrefs.selectedWorkspace ?? "");
  const [appliedWorkspace, setAppliedWorkspace] = useState<string>(initViewPrefs.selectedWorkspace ?? "");
  const [selectedModel, setSelectedModel] = useState<string>(initViewPrefs.selectedModel ?? "");
  const [appliedModel, setAppliedModel] = useState<string>(initViewPrefs.selectedModel ?? "");
  const [theme, setTheme] = useState<ThemeMode>(resolveInitialTheme);
  const [summary, setSummary] = useState<DashboardSummaryPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  activeConvIdRef.current = activeConvId;
  const [chartWindow, setChartWindow] = useState<NodeWindowKey>(
    initViewPrefs.chartWindow === "150" || initViewPrefs.chartWindow === "all"
      ? initViewPrefs.chartWindow
      : "60"
  );
  const [hoveredNodeSeq, setHoveredNodeSeq] = useState<number | null>(null);
  const summaryCacheRef = useRef<Map<string, DashboardSummaryPayload>>(new Map()); // 前端切池瞬显缓存（SWR）
  const etagCacheRef = useRef<Map<string, string>>(new Map()); // 前端 ETag 缓存，数据未变时 304 零重绘
  const abortRef = useRef<AbortController | null>(null); // 取消过期在途请求，防止慢响应反覆盖新切池
  const requestSeqRef = useRef(0); // 单调请求序号，保证竞态下仅采纳最新响应
  const buildIdRef = useRef<string>(""); // 记录当前前端构建指纹，后台静默更新重启后自动无感重载页面
  const nodeLimitParam = chartWindow === "all" ? "" : "300"; // 非「全部」节点模式按需拉取尾部与今日节点，减负 90%+ 载荷

  // 0.1. 同步主题与周期偏好至 documentElement / localStorage
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* 忽略受限存储异常 */
    }
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CYCLE_STORAGE_KEY, cycle);
    } catch {
      /* 忽略受限存储异常 */
    }
  }, [cycle]);

  useEffect(() => {
    writeStoredJson("agy_dashboard_view_prefs_v1", {
      selectedSource,
      selectedModel,
      selectedWorkspace,
      chartWindow,
    });
  }, [selectedSource, selectedModel, selectedWorkspace, chartWindow]);

  /**
   * 职责：向本地只读服务请求会话 Token 汇总数据。
   * 参数：forceRefresh — 是否强制跳过服务端文件指纹缓存。
   */
  const fetchSummary = useCallback(
    async (forceRefresh = false) => {
      // 1.1. 命中前端缓存时先瞬显旧快照，同时取消过期请求并在后台静默拉新
      const cacheKey = `${selectedSource}|${cycle}|${selectedWorkspace}|${selectedModel}|${nodeLimitParam}`;
      const cached = !forceRefresh ? summaryCacheRef.current.get(cacheKey) : undefined;
      if (cached) {
        startTransition(() => {
          setSummary(cached);
          setAppliedSource(cached.activeSource ?? selectedSource);
          setAppliedModel(selectedModel);
          setAppliedWorkspace(selectedWorkspace);
        });
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const reqSeq = ++requestSeqRef.current;

      try {
        const params = new URLSearchParams();
        if (selectedSource) params.set("source", selectedSource);
        params.set("cycle", cycle);
        if (selectedWorkspace) params.set("workspace", selectedWorkspace);
        if (selectedModel) params.set("model", selectedModel);
        if (nodeLimitParam) params.set("nodeLimit", nodeLimitParam);
        if (forceRefresh) params.set("refresh", "1");

        const savedEtag = cached ? etagCacheRef.current.get(cacheKey) : undefined;
        const res = await fetch(`/api/summary?${params.toString()}`, {
          signal: controller.signal,
          ...(savedEtag ? { headers: { "If-None-Match": savedEtag } } : {}),
        });
        const nextBuildId = res.headers.get("X-Hamiji-Build") || "";
        if (nextBuildId) {
          if (buildIdRef.current && buildIdRef.current !== nextBuildId) {
            const focusedTag = document.activeElement?.tagName?.toLowerCase() || "";
            if (activeConvIdRef.current === null && focusedTag !== "input" && focusedTag !== "textarea") {
              window.location.reload();
              return;
            }
          } else {
            buildIdRef.current = nextBuildId;
          }
        }
        if (res.status === 304) {
          if (reqSeq === requestSeqRef.current) setError(null);
          return;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as DashboardSummaryPayload;
        if (reqSeq !== requestSeqRef.current) return;
        const resolvedSource = data.activeSource ?? selectedSource;
        const nextEtag = res.headers.get("ETag");
        if (nextEtag) etagCacheRef.current.set(cacheKey, nextEtag);
        summaryCacheRef.current.set(cacheKey, data);
        if (summaryCacheRef.current.size > 24) {
          const oldest = summaryCacheRef.current.keys().next().value;
          if (oldest !== undefined) {
            summaryCacheRef.current.delete(oldest);
            etagCacheRef.current.delete(oldest);
          }
        }
        startTransition(() => {
          setSummary(data);
          setAppliedSource(resolvedSource);
          if (data.activeSource && data.activeSource !== selectedSource) {
            setSelectedSource(data.activeSource);
          }
          setAppliedModel(selectedModel);
          setAppliedWorkspace(selectedWorkspace);
        });
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (reqSeq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : "无法连接本地统计服务");
      } finally {
        if (reqSeq === requestSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [selectedSource, cycle, selectedWorkspace, selectedModel, nodeLimitParam]
  );

  // 1.2. 筛选条件变化时立即拉取；仅在前台可见时 10 秒轮询（命中 ETag 304 零重绘），切回标签页瞬时刷新
  useEffect(() => {
    void fetchSummary(false);
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchSummary]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchSummary(false);
      }
    }, 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void fetchSummary(false);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchSummary]);

  // 1.2.1. 首屏加载完成后空闲静默预热其余核心配额池缓存，实现 1/2/3 快捷键 0ms 瞬切
  const hasSummary = summary !== null;
  useEffect(() => {
    if (!hasSummary) return;
    const targets = ["", "pool:claude", "pool:gemini"].filter(
      (m) => m !== selectedModel && !summaryCacheRef.current.has(`${selectedSource}|${cycle}|${selectedWorkspace}|${m}|${nodeLimitParam}`)
    );
    if (targets.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const m of targets) {
        if (cancelled || document.visibilityState !== "visible") return;
        const key = `${selectedSource}|${cycle}|${selectedWorkspace}|${m}|${nodeLimitParam}`;
        if (summaryCacheRef.current.has(key)) continue;
        try {
          const params = new URLSearchParams({ cycle });
          if (selectedSource) params.set("source", selectedSource);
          if (selectedWorkspace) params.set("workspace", selectedWorkspace);
          if (m) params.set("model", m);
          if (nodeLimitParam) params.set("nodeLimit", nodeLimitParam);
          const res = await fetch(`/api/summary?${params.toString()}`);
          if (!res.ok || cancelled) continue;
          const etag = res.headers.get("ETag");
          const data = (await res.json()) as DashboardSummaryPayload;
          if (etag) etagCacheRef.current.set(key, etag);
          summaryCacheRef.current.set(key, data);
        } catch {
          /* 预热失败静默忽略 */
        }
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasSummary, selectedSource, cycle, selectedWorkspace, selectedModel, nodeLimitParam]);

  // 1.3. 根据本机已扫描到的全部模型动态生成顶栏快捷切换按钮（新用 Sonnet 5.5 等会自动长出新按钮）
  const modelShortcuts = useMemo(
    () => buildModelShortcuts(summary?.availableModels ?? []),
    [summary?.availableModels]
  );

  // 1.4. 监听键盘数字快捷键 1~9，一键切换全部或任意已出现的模型统计面板
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || activeConvId !== null) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && target.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      const matched = modelShortcuts.find((item) => item.hotkey && item.hotkey === e.key);
      if (matched) {
        e.preventDefault();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setSelectedModel(matched.modelQuery);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeConvId, modelShortcuts]);

  // 1.5. 统计顶层主会话数量与当前快捷选中的模型名称供卡片展示
  const mainConvCount = useMemo(
    () => (summary ? groupByMainConversation(summary.conversations).length : 0),
    [summary]
  );

  const activeModelShortcut = useMemo(
    () =>
      modelShortcuts.find((item) => item.modelQuery === selectedModel) ??
      modelShortcuts[0],
    [modelShortcuts, selectedModel]
  );

  const appliedModelShortcut = useMemo(
    () =>
      modelShortcuts.find((item) => item.modelQuery === appliedModel) ??
      modelShortcuts[0],
    [modelShortcuts, appliedModel]
  );

  const handleInspectConversation = useCallback((conv: ConversationUsageSummary) => {
    setActiveConvId(conv.conversationId);
  }, []);

  const handleSelectSource = useCallback((nextSource: string) => {
    setSelectedSource(nextSource);
    setSelectedWorkspace("");
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-screen bg-slate-50 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-50">
        {/* 极简单行顶栏（实心背景免移动端粘性滚动重绘卡顿） */}
        <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white shadow-2xs dark:border-slate-800/80 dark:bg-slate-950">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-md bg-indigo-600 text-white">
                  <Activity className="size-3.5" />
                </div>
                <h1 className="text-sm font-semibold tracking-tight whitespace-nowrap text-slate-900 dark:text-slate-50">
                  哈吉米统计
                </h1>
              </div>

              {/* 配额池一键切换栏（Claude 池聚合 Opus/Sonnet，Gemini 池独立核算） */}
              <Tabs
                value={activeModelShortcut.tabValue}
                onValueChange={(val) => {
                  const hit = modelShortcuts.find((m) => m.tabValue === val);
                  setSelectedModel(hit ? hit.modelQuery : "");
                }}
                aria-label="模型配额池快捷切换"
              >
                <TabsList className="h-7 p-0.5">
                  {modelShortcuts.map((item) => (
                    <Tooltip key={item.tabValue}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex h-full">
                          <TabsTrigger
                            value={item.tabValue}
                            className="gap-1 px-2 text-xs data-[state=active]:text-indigo-600 dark:data-[state=active]:text-indigo-300"
                          >
                            <span>{item.label}</span>
                            {item.hotkey && (
                              <kbd className="hidden rounded bg-slate-200/70 px-1 font-mono text-[10px] leading-4 text-slate-500 sm:inline dark:bg-slate-700/70 dark:text-slate-400">
                                {item.hotkey}
                              </kbd>
                            )}
                          </TabsTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{item.tooltip}</TooltipContent>
                    </Tooltip>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {(() => {
                const availableCycles = summary?.quotaWindow?.available7dCycles ?? [];
                const cycleInOptions =
                  cycle === "all" ||
                  (availableCycles.length > 0
                    ? availableCycles.some((opt) => opt.key === cycle)
                    : cycle === "7d" || cycle === "prev-7d");
                let fallbackCycleLabel = summary?.quotaWindow?.label || "当前 7d 周周期";
                if (cycle.startsWith("window:")) {
                  const [, sStr, eStr] = cycle.split(":");
                  const sMs = Number(sStr);
                  const eMs = Number(eStr);
                  if (Number.isFinite(sMs) && Number.isFinite(eMs)) {
                    fallbackCycleLabel = `${formatDateTime(new Date(sMs).toISOString()).slice(0, 11)} ~ ${formatDateTime(new Date(eMs).toISOString()).slice(0, 11)}`;
                  }
                }
                return (
                  <Select value={cycle} onValueChange={(v) => setCycle(v as QuotaCycleMode)}>
                    <SelectTrigger
                      size="sm"
                      className="h-7 w-auto min-w-[165px] max-w-[248px] px-2.5 text-xs tabular-nums"
                      aria-label="配额周期切换"
                    >
                      <SelectValue placeholder="当前 7d 周周期" />
                    </SelectTrigger>
                    <SelectContent>
                      {!cycleInOptions && (
                        <SelectItem value={cycle} className="text-xs tabular-nums">
                          {fallbackCycleLabel}
                        </SelectItem>
                      )}
                      {availableCycles.length > 0 ? (
                        availableCycles.map((opt) => {
                          const startText = formatDateTime(
                            new Date(opt.startMs).toISOString()
                          ).slice(0, 11);
                          const endText = formatDateTime(new Date(opt.endMs).toISOString()).slice(
                            0,
                            11
                          );
                          return (
                            <SelectItem
                              key={opt.key}
                              value={opt.key}
                              className="text-xs tabular-nums"
                            >
                              {opt.isCurrent
                                ? `当前 7d (${startText} ~ ${endText})`
                                : `${startText} ~ ${endText} (${formatTokens(opt.totalTokens)})`}
                            </SelectItem>
                          );
                        })
                      ) : (
                        <>
                          <SelectItem value="7d">当前 7d 周周期</SelectItem>
                          <SelectItem value="prev-7d">上一 7d 周周期</SelectItem>
                        </>
                      )}
                      <SelectItem value="all" className="text-xs">
                        全部
                      </SelectItem>
                    </SelectContent>
                  </Select>
                );
              })()}

              {summary?.quotaWindow &&
                !(summary.sources && summary.sources.length > 1 && appliedSource === "all") &&
                summary.quotaWindow.mode !== "all" &&
                (summary.quotaWindow.isIdleReset || summary.quotaWindow.resetsInMs > 0) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        className={
                          summary.quotaWindow.isIdleReset
                            ? "h-6 cursor-default border border-emerald-500/25 bg-emerald-500/10 px-2 text-[11px] text-emerald-700 tabular-nums dark:text-emerald-300"
                            : "h-6 cursor-default border border-indigo-500/20 bg-indigo-500/10 px-2 text-[11px] text-indigo-700 tabular-nums dark:text-indigo-300"
                        }
                      >
                        {summary.quotaWindow.isIdleReset
                          ? "已重置·待触发"
                          : `${formatCycleCountdown(summary.quotaWindow.resetsInMs)}后重置`}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      {summary.quotaWindow.isIdleReset
                        ? "上一周期已完成重置，下次发起模型调用时自动开启新周期窗口"
                        : summary.quotaWindow.windowStart && summary.quotaWindow.windowEnd
                          ? `本周期区间：${formatDateTime(summary.quotaWindow.windowStart).slice(0, 11)} ~ ${formatDateTime(summary.quotaWindow.windowEnd).slice(0, 11)}（基于本地池内调用时间线推算）`
                          : "基于本地池内调用时间线推算"}
                    </TooltipContent>
                  </Tooltip>
                )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="xs"
                    asChild
                    className="h-7 w-7 p-0 text-slate-700 dark:text-slate-200"
                  >
                    <a
                      href={
                        selectedSource && selectedSource !== "all"
                          ? `/calendar?source=${encodeURIComponent(selectedSource)}`
                          : "/calendar"
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="打开重置日历与登记页"
                    >
                      <CalendarDays className="size-3.5 text-indigo-500" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>重置日历 / 登记</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-label={theme === "dark" ? "切换至白天模式" : "切换至深色模式"}
                    onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                    className="h-7 w-7 p-0 text-slate-700 dark:text-slate-200"
                  >
                    {theme === "dark" ? (
                      <Sun className="size-3.5 text-amber-400" />
                    ) : (
                      <Moon className="size-3.5 text-indigo-500" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{theme === "dark" ? "切换白天" : "切换深色"}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        {/* 紧凑高密度内容区 */}
        <main className="mx-auto max-w-7xl space-y-3 px-4 py-3.5 sm:px-5">
          {error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
            >
              <div className="flex items-center gap-1.5">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>读取统计服务失败：{error}</span>
              </div>
              <Button size="xs" variant="outline" onClick={() => void fetchSummary(true)}>
                重试
              </Button>
            </div>
          )}

          {loading && !summary ? (
            <div className="py-14 text-center text-xs text-slate-500 dark:text-slate-400">
              正在加载会话统计数据...
            </div>
          ) : summary ? (
            <>
              {summary.sources && summary.sources.length > 1 && (
                <SourceSwitcherBar
                  sources={summary.sources}
                  activeSource={selectedSource}
                  onSelectSource={handleSelectSource}
                />
              )}
              <KpiCards
                key={appliedSource || "all"}
                activeSource={appliedSource}
                totals={summary.totals}
                byModel={summary.byModel}
                mainConversationCount={mainConvCount}
                activeModelLabel={
                  appliedModelShortcut.modelQuery ? appliedModelShortcut.label : undefined
                }
                activePoolKey={appliedModelShortcut.modelQuery}
                quotaWindow={summary.quotaWindow}
                liveQuota={
                  appliedModelShortcut.modelQuery
                    ? summary.liveQuota?.[appliedModelShortcut.modelQuery]
                    : undefined
                }
                isWorkspaceFiltered={
                  Boolean(selectedWorkspace || appliedWorkspace) ||
                  selectedModel !== appliedModel ||
                  selectedSource !== appliedSource ||
                  Boolean(summary.sources && summary.sources.length > 1 && appliedSource === "all") ||
                  Boolean(summary.quotaWindow && summary.quotaWindow.mode !== cycle)
                }
              />
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <DailyUsageCard
                  dailyTrend={summary.dailyTrend}
                  callTimeline={summary.callTimeline}
                  byModel={summary.byModel}
                  windowKey={chartWindow}
                  onWindowKeyChange={setChartWindow}
                  hoveredSeq={hoveredNodeSeq}
                  onHoverSeq={setHoveredNodeSeq}
                  onSelectConversationId={setActiveConvId}
                />
                <CacheHitRateCard
                  dailyTrend={summary.dailyTrend}
                  callTimeline={summary.callTimeline}
                  byModel={summary.byModel}
                  byWorkspace={summary.byWorkspace}
                  cacheTtl={summary.cacheTtl}
                  windowKey={chartWindow}
                  onWindowKeyChange={setChartWindow}
                  hoveredSeq={hoveredNodeSeq}
                  onHoverSeq={setHoveredNodeSeq}
                  onSelectConversationId={setActiveConvId}
                />
              </div>
              <ModelCallChart
                variant="tps"
                nodes={summary.callTimeline}
                byModel={summary.byModel}
                totalCallCount={summary.totals.callCount}
                windowKey={chartWindow}
                onWindowKeyChange={setChartWindow}
                hoveredSeq={hoveredNodeSeq}
                onHoverSeq={setHoveredNodeSeq}
                onSelectConversationId={setActiveConvId}
              />
              <ConversationExplorer
                conversations={summary.conversations}
                availableWorkspaces={summary.availableWorkspaces}
                selectedWorkspace={selectedWorkspace}
                onWorkspaceChange={setSelectedWorkspace}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                onInspectConversation={handleInspectConversation}
              />
            </>
          ) : null}
        </main>

        {/* 点击会话“详情”弹出的单步 Token 拆解对话框 */}
        <ConversationDetailDialog
          conversationId={activeConvId}
          sourceId={appliedSource}
          open={activeConvId !== null}
          onOpenChange={(open) => {
            if (!open) setActiveConvId(null);
          }}
          customRates={null}
        />
      </div>
    </TooltipProvider>
  );
}
