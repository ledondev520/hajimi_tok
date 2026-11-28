/**
 * Input: 浏览器 localStorage、matchMedia、document.documentElement 与 React 状态/副作用钩子。
 * Output: 导出主题模式与配色预设类型、经典原版（默认）+ 6 套鲜明辨识度主题元数据（Classic / Vercel / Tokyo / Claude / Nebula / Nord / HUD）、DOM 同步工具函数与 useThemeState 跨标签页同步钩子。
 * Pos: 前端主题系统核心状态与持久化引擎，为主看板与 /calendar 日历页提供统一外观模式（浅色/深色/跟随系统）与整站级主题切换能力（src/lib/theme.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { useCallback, useEffect, useState } from "react";

/** 外观明暗模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = "light" | "dark" | "system";

/** 实际生效的明暗模式 */
export type ResolvedThemeMode = "light" | "dark";

/** 内置主题方案标识（classic 经典原版默认 + 6 套鲜明风格主题） */
export type ThemePresetId =
  | "classic"
  | "mono"
  | "linear"
  | "claude"
  | "stripe"
  | "terminal"
  | "tokyo";

/** 单套主题配色的展示元数据（供主题面板渲染真实画布、圆角、卡片与图表四色谱预览） */
export interface ThemePresetMeta {
  id: ThemePresetId; // 主题唯一标识（同步至 html[data-theme]）
  name: string; // 中文显示名
  badge: string; // 灵感风格短标
  tagline: string; // 简洁风格描述
  radius: number; // 预览与卡片视觉圆角风格（px）
  swatches: {
    lightBg: string; // 浅色模式画布预览色
    lightCard: string; // 浅色模式卡片预览色
    darkBg: string; // 深色模式画布预览色
    darkCard: string; // 深色模式卡片预览色
    accent: string; // 主强调色（浅色态）
    accentDark: string; // 主强调色（深色态）
    paletteLight: readonly [string, string, string, string]; // 浅色图表四色谱
    paletteDark: readonly [string, string, string, string]; // 深色图表四色谱
  };
}

export const THEME_MODE_STORAGE_KEY = "agy_theme_mode"; // 外观明暗模式持久化键
export const THEME_PRESET_STORAGE_KEY = "agy_theme_preset"; // 主题配色方案持久化键
export const DEFAULT_THEME_MODE: ThemeMode = "system"; // 默认跟随操作系统浅色/深色偏好
export const DEFAULT_THEME_PRESET: ThemePresetId = "classic"; // 默认保留经典原版（Slate + Indigo 清爽配色）

const VALID_MODES = new Set<ThemeMode>(["light", "dark", "system"]);
const VALID_PRESETS = new Set<ThemePresetId>([
  "classic",
  "mono",
  "linear",
  "claude",
  "stripe",
  "terminal",
  "tokyo",
]);

/** 旧版彩虹预设 ID 平滑迁移映射，避免已有 localStorage 配置失效 */
const LEGACY_PRESET_MAP: Record<string, ThemePresetId> = {
  indigo: "linear",
  ocean: "tokyo",
  emerald: "terminal",
  violet: "stripe",
  amber: "claude",
  rose: "claude",
};

/** 经典原版（默认）+ 6 套高辨识度整站级主题清单（画布氛围、卡片材质、圆角几何与图表色谱全量联动） */
export const THEME_PRESETS: readonly ThemePresetMeta[] = [
  {
    id: "classic",
    name: "经典原版",
    badge: "默认",
    tagline: "原版 Slate 浅灰/深海蓝底色 · 靛蓝与翡翠经典配色 · 零纹理清爽直览",
    radius: 12,
    swatches: {
      lightBg: "#f8fafc",
      lightCard: "#ffffff",
      darkBg: "#020617",
      darkCard: "#0f172a",
      accent: "#4f46e5",
      accentDark: "#6366f1",
      paletteLight: ["#6366f1", "#10b981", "#8b5cf6", "#f59e0b"],
      paletteDark: ["#818cf8", "#34d399", "#a78bfa", "#fbbf24"],
    },
  },
  {
    id: "mono",
    name: "极简黑白",
    badge: "Vercel",
    tagline: "纯黑白高对比 · 点阵画布 · 瑞士精密图表",
    radius: 12,
    swatches: {
      lightBg: "#f2f2f5",
      lightCard: "#ffffff",
      darkBg: "#09090b",
      darkCard: "#131317",
      accent: "#18181b",
      accentDark: "#fafafa",
      paletteLight: ["#18181b", "#2563eb", "#059669", "#d97706"],
      paletteDark: ["#e4e4e7", "#3b82f6", "#10b981", "#f59e0b"],
    },
  },
  {
    id: "tokyo",
    name: "东京夜幕",
    badge: "Tokyo",
    tagline: "靛蓝夜幕画布 · 天青极光 · 樱紫数据色盘",
    radius: 14,
    swatches: {
      lightBg: "#dfe6f5",
      lightCard: "#f7f9fe",
      darkBg: "#1a1b26",
      darkCard: "#24283b",
      accent: "#2e7de9",
      accentDark: "#7aa2f7",
      paletteLight: ["#2e7de9", "#587539", "#7847bd", "#f52a65"],
      paletteDark: ["#7aa2f7", "#9ece6a", "#bb9af7", "#f7768e"],
    },
  },
  {
    id: "claude",
    name: "暖陶纸感",
    badge: "Claude",
    tagline: "暖米羊皮纸 / 烘焙深咖 · 陶土赤与鼠尾草",
    radius: 18,
    swatches: {
      lightBg: "#ede5d6",
      lightCard: "#faf6ee",
      darkBg: "#1f1916",
      darkCard: "#2b231e",
      accent: "#c96442",
      accentDark: "#e3825f",
      paletteLight: ["#c96442", "#3d7a5e", "#c48b1c", "#b55470"],
      paletteDark: ["#e3825f", "#81b29a", "#e9c46a", "#d98ca3"],
    },
  },
  {
    id: "linear",
    name: "星云紫境",
    badge: "Nebula",
    tagline: "深邃紫靛星云光晕 · 电光紫与品红渐层",
    radius: 16,
    swatches: {
      lightBg: "#ece6fa",
      lightCard: "#fbfaff",
      darkBg: "#131020",
      darkCard: "#1d1832",
      accent: "#7c3aed",
      accentDark: "#a78bfa",
      paletteLight: ["#7c3aed", "#059669", "#db2777", "#2563eb"],
      paletteDark: ["#a78bfa", "#34d399", "#f472b6", "#60a5fa"],
    },
  },
  {
    id: "stripe",
    name: "北欧霜蓝",
    badge: "Nord",
    tagline: "经典 Nord 极夜石板蓝 · 冰川青与极光色阶",
    radius: 14,
    swatches: {
      lightBg: "#dce4ef",
      lightCard: "#f7f9fc",
      darkBg: "#232833",
      darkCard: "#2e3440",
      accent: "#3b7ea1",
      accentDark: "#88c0d0",
      paletteLight: ["#2f7d99", "#557a46", "#84567d", "#c28629"],
      paletteDark: ["#88c0d0", "#a3be8c", "#b48ead", "#ebcb8b"],
    },
  },
  {
    id: "terminal",
    name: "黑客矩阵",
    badge: "HUD",
    tagline: "锐利直角 HUD 网格 · 荧光翡翠磷光遥测",
    radius: 6,
    swatches: {
      lightBg: "#dff0e8",
      lightCard: "#f6fcf9",
      darkBg: "#06130f",
      darkCard: "#0b2019",
      accent: "#047857",
      accentDark: "#34d399",
      paletteLight: ["#059669", "#0891b2", "#65a30d", "#d97706"],
      paletteDark: ["#34d399", "#22d3ee", "#a3e635", "#fbbf24"],
    },
  },
];

/**
 * 职责：安全解析并规范化外观明暗模式值，非法值回退为默认模式。
 * 参数：raw — localStorage 或外部读取到的原始字符串。
 * 返回值：合法的 ThemeMode 枚举值。
 */
export function normalizeThemeMode(raw: string | null | undefined): ThemeMode {
  if (raw && VALID_MODES.has(raw as ThemeMode)) {
    return raw as ThemeMode;
  }
  return DEFAULT_THEME_MODE;
}

/**
 * 职责：安全解析并规范化主题配色方案 ID，自动兼容旧版预设名称并回退至默认主题。
 * 参数：raw — localStorage 或外部读取到的原始字符串。
 * 返回值：合法的 ThemePresetId 枚举值。
 */
export function normalizeThemePreset(raw: string | null | undefined): ThemePresetId {
  if (!raw) return DEFAULT_THEME_PRESET;
  if (VALID_PRESETS.has(raw as ThemePresetId)) {
    return raw as ThemePresetId;
  }
  if (raw in LEGACY_PRESET_MAP) {
    return LEGACY_PRESET_MAP[raw];
  }
  return DEFAULT_THEME_PRESET;
}

/**
 * 职责：从 localStorage 读取初始外观明暗模式偏好。
 * 返回值：规范化后的 ThemeMode。
 */
export function resolveInitialThemeMode(): ThemeMode {
  try {
    return normalizeThemeMode(window.localStorage.getItem(THEME_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

/**
 * 职责：从 localStorage 读取初始主题配色方案偏好。
 * 返回值：规范化后的 ThemePresetId。
 */
export function resolveInitialThemePreset(): ThemePresetId {
  try {
    return normalizeThemePreset(window.localStorage.getItem(THEME_PRESET_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PRESET;
  }
}

/**
 * 职责：结合系统 prefers-color-scheme 将 ThemeMode 解析为最终生效的 light / dark。
 * 参数：mode — 用户选择的外观模式；systemPrefersDark — 可选系统暗色布尔覆盖（供单元测试注入）。
 * 返回值：最终生效的 ResolvedThemeMode。
 */
export function resolveEffectiveMode(
  mode: ThemeMode,
  systemPrefersDark?: boolean
): ResolvedThemeMode {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  if (typeof systemPrefersDark === "boolean") {
    return systemPrefersDark ? "dark" : "light";
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/**
 * 职责：根据主题 ID 查找对应展示元数据，缺失时回退为首项默认主题。
 * 参数：preset — 主题 ID。
 * 返回值：ThemePresetMeta 对象。
 */
export function getThemePresetMeta(preset: ThemePresetId): ThemePresetMeta {
  return THEME_PRESETS.find((item) => item.id === preset) ?? THEME_PRESETS[0];
}

/**
 * 职责：将外观模式与主题配色即时应用到 document.documentElement。
 * 参数：mode — 外观模式；preset — 主题配色 ID。
 * 返回值：当前实际生效的明暗模式。
 */
export function applyThemeToDocument(
  mode: ThemeMode,
  preset: ThemePresetId
): ResolvedThemeMode {
  const resolved = resolveEffectiveMode(mode);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.dataset.theme = preset;
    root.style.colorScheme = resolved;
  }
  return resolved;
}

/** useThemeState 返回值结构 */
export interface ThemeController {
  mode: ThemeMode; // 当前外观明暗模式（light / dark / system）
  resolvedMode: ResolvedThemeMode; // 实际生效的明暗模式（light / dark）
  preset: ThemePresetId; // 当前主题配色 ID
  presetMeta: ThemePresetMeta; // 当前主题元数据
  setMode: (next: ThemeMode) => void; // 切换外观模式
  setPreset: (next: ThemePresetId) => void; // 切换主题配色
  toggleQuickMode: () => void; // 一键在浅色与深色间快速切换
}

/**
 * 职责：提供具备 localStorage 持久化、系统暗色自动监听与多标签页实时同步的 React 主题控制 Hook。
 * 返回值：ThemeController 实例。
 */
export function useThemeState(): ThemeController {
  const [mode, setModeState] = useState<ThemeMode>(resolveInitialThemeMode);
  const [preset, setPresetState] = useState<ThemePresetId>(resolveInitialThemePreset);
  const [resolvedMode, setResolvedMode] = useState<ResolvedThemeMode>(() =>
    resolveEffectiveMode(resolveInitialThemeMode())
  );

  useEffect(() => {
    setResolvedMode(applyThemeToDocument(mode, preset));
    try {
      window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, preset);
    } catch {
      /* 忽略受限存储异常 */
    }
  }, [mode, preset]);

  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setResolvedMode(applyThemeToDocument("system", preset));
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [mode, preset]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_MODE_STORAGE_KEY) {
        setModeState(normalizeThemeMode(event.newValue));
      } else if (event.key === THEME_PRESET_STORAGE_KEY) {
        setPresetState(normalizeThemePreset(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(normalizeThemeMode(next));
  }, []);

  const setPreset = useCallback((next: ThemePresetId) => {
    setPresetState(normalizeThemePreset(next));
  }, []);

  const toggleQuickMode = useCallback(() => {
    setModeState((prev) => (resolveEffectiveMode(prev) === "dark" ? "light" : "dark"));
  }, []);

  return {
    mode,
    resolvedMode,
    preset,
    presetMeta: getThemePresetMeta(preset),
    setMode,
    setPreset,
    toggleQuickMode,
  };
}
