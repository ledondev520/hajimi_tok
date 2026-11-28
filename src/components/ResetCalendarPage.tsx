/**
 * Input: React 状态与副作用钩子、QuotaResetEvent 类型、@/lib/format 日历事件构造与时间格式化工具、@/components/ui 基础组件与 lucide-react 图标。
 * Output: 导出 ResetCalendarPage 独立重置日历与登记管理页面（挂载于 /calendar 路由）。
 * Pos: 可视化展示每一次实际登记重置与 +7 天自然重置日期对照，并支持在线登记/删除重置时间（src/components/ResetCalendarPage.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Moon,
  Plus,
  Sun,
  Trash2,
} from "lucide-react";
import type { QuotaResetEvent } from "@/types/telemetry";
import {
  buildResetCalendarItems,
  formatCycleCountdown,
  formatDateTime,
  type ResetCalendarItem,
} from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const THEME_STORAGE_KEY = "agy_theme_mode"; // 与主看板共享的主题偏好键
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]; // 月历表头（周一为首列）
const POOL_LABEL: Record<QuotaResetEvent["pool"], string> = {
  all: "双池",
  gemini: "Gemini",
  claude: "Claude",
};

/** 将 Date 对象格式化为 datetime-local 输入框所需的 YYYY-MM-DDTHH:mm 本地文本 */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 将 Date 对象格式化为本地 YYYY-MM-DD 键 */
function toDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 职责：渲染独立重置日历页面，支持登记/删除每次重置时刻，并在月历与明细表中对照「实际重置」与「+7 天自然重置」。
 * 思路：1) 读写 /api/resets 持久化至 ~/.hamiji-sta/resets.json；2) 复用 buildResetCalendarItems 生成双轨日历项；3) 以标准周一到周日网格展示全月重置节点。
 * 返回值：完整独立页面节点。
 */
export function ResetCalendarPage() {
  // 0. 主题、重置记录列表、当前查看月份与登记表单状态
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [resets, setResets] = useState<QuotaResetEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const now = useMemo(() => new Date(), []);
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0-based

  const [inputDatetime, setInputDatetime] = useState(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return toDatetimeLocalValue(d);
  });
  const [inputPool, setInputPool] = useState<QuotaResetEvent["pool"]>("all");
  const [inputNote, setInputNote] = useState("");

  useEffect(() => {
    document.title = "哈吉米统计 · 重置日历";
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const loadResets = useCallback(async () => {
    try {
      const res = await fetch("/api/resets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { resets?: QuotaResetEvent[] };
      setResets(Array.isArray(data.resets) ? data.resets : []);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "加载重置记录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadResets();
  }, [loadResets]);

  const handleAddReset = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = new Date(inputDatetime);
    if (Number.isNaN(parsed.getTime())) {
      setErrorMsg("请选择有效的日期时间");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/resets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timestamp: parsed.toISOString(),
          pool: inputPool,
          note: inputNote.trim(),
        }),
      });
      const data = (await res.json()) as { resets?: QuotaResetEvent[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResets(Array.isArray(data.resets) ? data.resets : []);
      setInputNote("");
      setViewYear(parsed.getFullYear());
      setViewMonth(parsed.getMonth());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "登记失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteReset = async (id: string) => {
    try {
      const res = await fetch(`/api/resets/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = (await res.json()) as { resets?: QuotaResetEvent[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResets(Array.isArray(data.resets) ? data.resets : []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "删除失败");
    }
  };

  // 1.1. 构造双轨日历事件并按本地日期分组
  const nowMs = Date.now();
  const calendarItems = useMemo(() => buildResetCalendarItems(resets, nowMs), [resets, nowMs]);
  const itemsByDay = useMemo(() => {
    const map = new Map<string, ResetCalendarItem[]>();
    for (const item of calendarItems) {
      const list = map.get(item.dayKey) ?? [];
      list.push(item);
      map.set(item.dayKey, list);
    }
    return map;
  }, [calendarItems]);

  // 1.2. 构造当前月的 6×7 或 5×7 日期格子（周一作为第一列）
  const todayKey = toDayKey(new Date());
  const monthCells = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // 周一=0 .. 周日=6
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    const cells: Array<{ date: Date; dayKey: string; inMonth: boolean }> = [];
    for (let i = 0; i < totalCells; i++) {
      const d = new Date(viewYear, viewMonth, 1 - startOffset + i);
      cells.push({
        date: d,
        dayKey: toDayKey(d),
        inMonth: d.getMonth() === viewMonth,
      });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const shiftMonth = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  // 1.3. 整理倒序重置记录对照表（关联对应 +7d 自然重置与实际时长）
  const pairedRows = useMemo(() => {
    const natById = new Map<string, ResetCalendarItem>();
    const actById = new Map<string, ResetCalendarItem>();
    for (const it of calendarItems) {
      if (it.kind === "natural") natById.set(it.resetId, it);
      else actById.set(it.resetId, it);
    }
    return [...resets]
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .map((r) => ({
        reset: r,
        actual: actById.get(r.id),
        natural: natById.get(r.id),
      }));
  }, [resets, calendarItems]);

  return (
    <TooltipProvider delayDuration={120}>
      <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50">
        <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/95 shadow-2xs backdrop-blur-md dark:border-slate-800/80 dark:bg-slate-950/90">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
            <div className="flex items-center gap-2.5">
              <div className="flex size-6 items-center justify-center rounded-md bg-indigo-600 text-white">
                <Activity className="size-3.5" />
              </div>
              <h1 className="text-sm font-semibold tracking-tight">重置日历</h1>
              <Button variant="outline" size="xs" asChild className="h-6 px-2 text-[11px]">
                <a href="/">
                  <ArrowLeft className="size-3" />
                  返回
                </a>
              </Button>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  aria-label={theme === "dark" ? "切换至白天模式" : "切换至深色模式"}
                  onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                  className="h-7 w-7 p-0"
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
        </header>

        <main className="mx-auto max-w-6xl space-y-3.5 px-4 py-4 sm:px-5">
          {errorMsg && (
            <div
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
            >
              {errorMsg}
            </div>
          )}

          {/* 单行极简登记条 */}
          <Card className="border-slate-200/80 bg-white py-2.5 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
            <CardContent className="px-4">
              <form onSubmit={handleAddReset} className="flex flex-wrap items-center gap-2">
                <Input
                  type="datetime-local"
                  value={inputDatetime}
                  onChange={(e) => setInputDatetime(e.target.value)}
                  aria-label="重置日期与时间"
                  required
                  className="h-8 w-46 font-mono text-xs tabular-nums"
                />
                <Select
                  value={inputPool}
                  onValueChange={(v) => setInputPool(v as QuotaResetEvent["pool"])}
                >
                  <SelectTrigger aria-label="配额池" size="sm" className="h-8 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">双池</SelectItem>
                    <SelectItem value="gemini">Gemini</SelectItem>
                    <SelectItem value="claude">Claude</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="text"
                  value={inputNote}
                  onChange={(e) => setInputNote(e.target.value)}
                  placeholder="备注（可选）"
                  className="h-8 min-w-[160px] flex-1 text-xs"
                />
                <Button type="submit" size="sm" disabled={submitting} className="h-8 px-3 text-xs">
                  <Plus className="size-3.5" />
                  {submitting ? "保存中" : "登记"}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* 月历视图：同时标注实际重置与 +7 天自然重置 */}
          <Card className="gap-2.5 border-slate-200/80 bg-white py-3 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
            <CardHeader className="px-4 pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CalendarDays className="size-4 text-indigo-500" />
                  <CardTitle className="text-sm font-semibold tabular-nums">
                    {viewYear} 年 {viewMonth + 1} 月
                  </CardTitle>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      aria-label="上一月"
                      onClick={() => shiftMonth(-1)}
                      className="h-6 w-6 p-0"
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        const t = new Date();
                        setViewYear(t.getFullYear());
                        setViewMonth(t.getMonth());
                      }}
                      className="h-6 px-2 text-[11px]"
                    >
                      今天
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      aria-label="下一月"
                      onClick={() => shiftMonth(1)}
                      className="h-6 w-6 p-0"
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {/* 极简图例 */}
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block size-2.5 rounded-xs bg-emerald-500" />
                    实际
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block size-2.5 rounded-xs border border-dashed border-amber-500 bg-amber-500/15" />
                    +7d 自然
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block size-2.5 rounded-xs border border-dashed border-slate-400 bg-slate-200/60 dark:bg-slate-800" />
                    已覆盖
                  </span>
                </div>
              </div>
            </CardHeader>

            <CardContent className="px-4">
              <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="py-1">
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {monthCells.map((cell) => {
                  const isToday = cell.dayKey === todayKey;
                  const dayItems = itemsByDay.get(cell.dayKey) ?? [];
                  return (
                    <div
                      key={cell.dayKey}
                      className={`min-h-[80px] rounded-md border p-1.5 text-left transition-colors ${
                        isToday
                          ? "border-indigo-500 bg-indigo-50/40 dark:border-indigo-400 dark:bg-indigo-950/30"
                          : cell.inMonth
                            ? "border-slate-200/80 bg-white dark:border-slate-800 dark:bg-slate-950/50"
                            : "border-slate-100 bg-slate-50/50 opacity-50 dark:border-slate-900 dark:bg-slate-950/20"
                      }`}
                    >
                      <div className="mb-1">
                        <span
                          className={`inline-flex size-5 items-center justify-center rounded-full font-mono text-[11px] tabular-nums ${
                            isToday
                              ? "bg-indigo-600 font-bold text-white"
                              : "text-slate-700 dark:text-slate-300"
                          }`}
                        >
                          {cell.date.getDate()}
                        </span>
                      </div>

                      <div className="space-y-1">
                        {dayItems.map((it) => {
                          const isActual = it.kind === "actual";
                          const isSuperseded = it.kind === "natural" && it.supersededByMs !== null;
                          const pillCls = isActual
                            ? it.pool === "claude"
                              ? "bg-violet-600 text-white"
                              : it.pool === "gemini"
                                ? "bg-sky-600 text-white"
                                : "bg-emerald-600 text-white"
                            : isSuperseded
                              ? "border border-dashed border-slate-300 bg-slate-100/80 text-slate-400 line-through dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500"
                              : "border border-dashed border-amber-500/70 bg-amber-500/10 text-amber-800 dark:text-amber-300";

                          return (
                            <Tooltip key={it.key}>
                              <TooltipTrigger asChild>
                                <div
                                  className={`cursor-default truncate rounded px-1 py-0.5 font-mono text-[10px] leading-tight tabular-nums ${pillCls}`}
                                >
                                  {it.timeText}{" "}
                                  {isActual
                                    ? it.pool === "all"
                                      ? "双池"
                                      : it.pool === "gemini"
                                        ? "Gem"
                                        : "Cla"
                                    : "+7d"}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs space-y-0.5 text-[11px]">
                                <div className="font-semibold">
                                  {isActual ? "实际重置" : "+7d 自然重置"} · {POOL_LABEL[it.pool]}
                                </div>
                                <div className="font-mono">
                                  {formatDateTime(new Date(it.timestampMs).toISOString())}
                                </div>
                                {it.note && <div>{it.note}</div>}
                                {isSuperseded && it.supersededByMs && (
                                  <div className="text-amber-300 dark:text-amber-700">
                                    已于{" "}
                                    {formatDateTime(new Date(it.supersededByMs).toISOString()).slice(
                                      0,
                                      11
                                    )}{" "}
                                    提前重置
                                  </div>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* 极简记录清单 */}
          <Card className="gap-2 border-slate-200/80 bg-white py-3 shadow-2xs dark:border-slate-800/90 dark:bg-slate-900/70">
            <CardHeader className="px-4 pb-0">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-semibold">重置记录</CardTitle>
                <Badge variant="secondary" className="h-4 px-1.5 text-[11px] tabular-nums">
                  {resets.length}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="px-4">
              {loading ? (
                <div className="py-5 text-center text-xs text-slate-400">加载中...</div>
              ) : pairedRows.length === 0 ? (
                <div className="rounded-md border border-dashed border-slate-200 py-5 text-center text-xs text-slate-400 dark:border-slate-800">
                  暂无记录
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {pairedRows.map(({ reset, actual, natural }) => {
                    const startText = formatDateTime(reset.timestamp).slice(0, 11);
                    const natText = natural
                      ? formatDateTime(new Date(natural.timestampMs).toISOString()).slice(0, 11)
                      : "-";
                    const superseded = natural?.supersededByMs != null;
                    const remMs = natural ? Math.max(0, natural.timestampMs - nowMs) : 0;
                    return (
                      <div
                        key={reset.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="font-mono font-semibold tabular-nums">{startText}</span>
                          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                            {POOL_LABEL[reset.pool]}
                          </Badge>
                          {reset.source === "shared" && (
                            <Badge
                              variant="outline"
                              className="h-5 border-indigo-400/40 px-1.5 text-[10px] text-indigo-600 dark:text-indigo-300"
                            >
                              公共
                            </Badge>
                          )}
                          <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                            → {natText}
                          </span>
                          {superseded && actual?.actualDurationMs ? (
                            <Badge
                              variant="outline"
                              className="h-5 border-amber-500/40 px-1.5 text-[10px] text-amber-700 tabular-nums dark:text-amber-300"
                            >
                              提前 · {formatCycleCountdown(actual.actualDurationMs)}
                            </Badge>
                          ) : remMs > 0 ? (
                            <Badge className="h-5 bg-emerald-600 px-1.5 text-[10px] text-white tabular-nums">
                              剩余 {formatCycleCountdown(remMs)}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-slate-500">
                              满 7d
                            </Badge>
                          )}
                          {reset.note && (
                            <span className="truncate text-slate-500 dark:text-slate-400">
                              {reset.note}
                            </span>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-label={reset.source === "shared" ? "隐藏公共记录" : "删除记录"}
                          title={reset.source === "shared" ? "仅本机隐藏此公共记录" : "删除记录"}
                          onClick={() => void handleDeleteReset(reset.id)}
                          className="h-6 w-6 p-0 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
      </div>
    </TooltipProvider>
  );
}
