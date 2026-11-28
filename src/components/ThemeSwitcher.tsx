/**
 * Input: React 钩子、lucide-react 图标、@/lib/theme 主题预设与控制器类型、@/components/ui Button 与 Tooltip。
 * Output: 导出 ThemeSwitcher 顶栏主题配色弹窗与一键明暗切换组合控件（实时展示每套主题真实画布、圆角、卡片色与四色图表色盘预览）。
 * Pos: 全局顶栏外观定制入口组件，供主看板（App.tsx）与重置日历页（ResetCalendarPage.tsx）共同复用（src/components/ThemeSwitcher.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { useEffect, useId, useRef, useState } from "react";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import {
  THEME_PRESETS,
  type ThemeController,
  type ThemeMode,
} from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** ThemeSwitcher 组件入参 */
export interface ThemeSwitcherProps {
  theme: ThemeController; // 由 useThemeState() 返回的主题状态与操作集合
}

const MODE_OPTIONS: ReadonlyArray<{
  value: ThemeMode;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor },
];

/**
 * 职责：渲染顶栏「外观与主题」弹出面板与「一键明暗切换」快捷按钮，支持 3 种明暗模式与 6 套鲜明辨识度整站主题实时预览切换。
 * 思路：每张主题预览卡真实还原该主题的画布底色、卡片材质、圆角几何与 4 色数据图表缩略条，一眼区分 6 套风格世界。
 * 参数：props — theme 主题控制器实例。
 * 返回值：顶栏右侧主题操作按钮组节点。
 */
export function ThemeSwitcher({ theme }: ThemeSwitcherProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const isDark = theme.resolvedMode === "dark";
  const activeSwatchColor = isDark
    ? theme.presetMeta.swatches.accentDark
    : theme.presetMeta.swatches.accent;

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label="打开主题与外观设置"
            aria-expanded={open}
            aria-controls={panelId}
            aria-haspopup="dialog"
            onClick={() => setOpen((prev) => !prev)}
            className="h-8 gap-2 px-2.5 text-xs font-medium"
          >
            <span
              className="size-2.5 shrink-0 rounded-full ring-1 ring-black/15 dark:ring-white/25"
              style={{ backgroundColor: activeSwatchColor }}
            />
            <Palette className="size-3.5 shrink-0 text-[var(--theme-text-muted)]" />
            <span className="hidden lg:inline">{theme.presetMeta.name}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          外观主题 · {theme.presetMeta.name} ({theme.presetMeta.badge})
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={isDark ? "切换至浅色模式" : "切换至深色模式"}
            onClick={theme.toggleQuickMode}
            className="h-8 w-8 p-0"
          >
            {isDark ? (
              <Sun className="size-3.5 text-amber-400" />
            ) : (
              <Moon className="size-3.5 text-[var(--theme-text-secondary)]" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{isDark ? "切换浅色模式" : "切换深色模式"}</TooltipContent>
      </Tooltip>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="主题与外观设置"
          className="theme-surface-solid absolute top-full right-0 z-50 mt-2 w-[328px] border p-4 sm:w-[368px]"
        >
          {/* 1.1. 标题与当前生效标识 */}
          <div className="mb-3.5 flex items-center justify-between gap-2">
            <div>
              <div className="text-[13px] font-semibold tracking-tight text-[var(--theme-text)]">
                外观与主题
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--theme-text-muted)]">
                联动画布氛围、卡片圆角与整站图表色盘
              </div>
            </div>
            <span className="theme-accent-pill inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium">
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: activeSwatchColor }}
              />
              {theme.presetMeta.badge}
            </span>
          </div>

          {/* 1.2. 外观明暗模式三段切换 */}
          <div className="mb-4 space-y-1.5">
            <div className="text-[11px] font-medium text-[var(--theme-text-muted)]">
              明暗模式
            </div>
            <div
              role="radiogroup"
              aria-label="外观明暗模式"
              className="grid grid-cols-3 gap-1 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-surface-muted)] p-1"
            >
              {MODE_OPTIONS.map(({ value, label, Icon }) => {
                const selected = theme.mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => theme.setMode(value)}
                    className={`flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium transition-all ${
                      selected
                        ? "border border-[var(--theme-accent-border)] bg-[var(--theme-accent-soft)] text-[var(--theme-accent-ink)] shadow-2xs"
                        : "border border-transparent text-[var(--theme-text-muted)] hover:text-[var(--theme-text)]"
                    }`}
                  >
                    <Icon className="size-3 shrink-0" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 1.3. 6 套鲜明辨识度主题缩略图卡片（真实画布 + 圆角 + 4 色迷你柱图） */}
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-[var(--theme-text-muted)]">
              风格预设
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {THEME_PRESETS.map((item) => {
                const selected = theme.preset === item.id;
                const previewBg = isDark ? item.swatches.darkBg : item.swatches.lightBg;
                const previewCard = isDark ? item.swatches.darkCard : item.swatches.lightCard;
                const previewAccent = isDark ? item.swatches.accentDark : item.swatches.accent;
                const previewPalette = isDark
                  ? item.swatches.paletteDark
                  : item.swatches.paletteLight;
                const previewBorder = isDark
                  ? "rgba(255,255,255,0.14)"
                  : "rgba(15,23,42,0.12)";
                const miniRadius = Math.max(3, Math.round(item.radius * 0.45));

                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => theme.setPreset(item.id)}
                    className={`group relative flex cursor-pointer flex-col gap-2 rounded-xl border p-2.5 text-left transition-all ${
                      selected
                        ? "border-[var(--theme-accent)] bg-[var(--theme-accent-soft)] ring-1 ring-[var(--theme-accent)]"
                        : "border-[var(--theme-border)] bg-[var(--theme-surface)] hover:border-[var(--theme-border-strong)]"
                    }`}
                  >
                    {/* 真实画布 + 顶部氛围光 + 迷你卡片与四色柱图预览 */}
                    <div
                      className="flex h-13 w-full flex-col justify-between border p-1.5"
                      style={{
                        backgroundColor: previewBg,
                        borderColor: previewBorder,
                        borderRadius: `${miniRadius}px`,
                        backgroundImage:
                          item.id === "terminal"
                            ? `linear-gradient(${previewAccent}22 1px, transparent 1px), linear-gradient(90deg, ${previewAccent}22 1px, transparent 1px)`
                            : `radial-gradient(ellipse 90% 60% at 50% 0%, ${previewAccent}33, transparent 72%)`,
                        backgroundSize: item.id === "terminal" ? "10px 10px" : "100% 100%",
                      }}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className="h-1.5 w-7 rounded-full"
                          style={{ backgroundColor: previewAccent }}
                        />
                        <span className="flex items-center gap-0.5">
                          {previewPalette.map((c, cIdx) => (
                            <span
                              key={cIdx}
                              className="size-1.5 rounded-full"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </span>
                      </div>

                      <div className="grid grid-cols-12 gap-1">
                        <div
                          className="col-span-7 flex h-6 items-end gap-1 border px-1.5 pb-1"
                          style={{
                            backgroundColor: previewCard,
                            borderColor: previewBorder,
                            borderRadius: `${Math.max(2, miniRadius - 2)}px`,
                          }}
                        >
                          {[65, 95, 50, 80].map((hPct, bIdx) => (
                            <span
                              key={bIdx}
                              className="flex-1 rounded-t-[2px]"
                              style={{
                                height: `${hPct}%`,
                                backgroundColor: previewPalette[bIdx],
                              }}
                            />
                          ))}
                        </div>
                        <div
                          className="col-span-5 flex h-6 flex-col justify-center gap-1 border px-1.5"
                          style={{
                            backgroundColor: previewCard,
                            borderColor: previewBorder,
                            borderRadius: `${Math.max(2, miniRadius - 2)}px`,
                          }}
                        >
                          <span
                            className="h-1 w-full rounded-full"
                            style={{ backgroundColor: previewPalette[0] }}
                          />
                          <span
                            className="h-1 w-3/4 rounded-full"
                            style={{ backgroundColor: previewPalette[1] }}
                          />
                          <span
                            className="h-1 w-1/2 rounded-full"
                            style={{ backgroundColor: previewPalette[2] }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-xs font-semibold text-[var(--theme-text)]">
                          {item.name}
                        </span>
                        {selected ? (
                          <span
                            className="flex size-4 shrink-0 items-center justify-center rounded-full"
                            style={{
                              backgroundColor: previewAccent,
                              color: isDark ? "#09090b" : "#ffffff",
                            }}
                          >
                            <Check className="size-2.5 stroke-[2.8]" />
                          </span>
                        ) : (
                          <span className="font-mono text-[9.5px] text-[var(--theme-text-muted)]">
                            {item.badge}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[10px] text-[var(--theme-text-muted)]">
                        {item.tagline}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
