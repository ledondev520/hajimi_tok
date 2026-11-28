/**
 * Input: vitest 断言原语、../src/lib/theme、../src/lib/themeCss 与 ../src/lib/chartPath 模块。
 * Output: 校验主题模式规范化、系统暗色解析、6 套一线开发工具配色预设完整性、旧预设迁移映射、虚拟样式表 CSS 变量覆盖度以及平滑曲线路径生成。
 * Pos: 前端多主题系统与图表曲线工具的回归单元测试套件（tests/theme.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_PRESET,
  THEME_PRESETS,
  getThemePresetMeta,
  normalizeThemeMode,
  normalizeThemePreset,
  resolveEffectiveMode,
} from "../src/lib/theme";
import { buildVirtualThemeCss } from "../src/lib/themeCss";
import { buildSmoothAreaPath, buildSmoothLinePath } from "../src/lib/chartPath";
import { ensureDistinctColors, resolveModelStyle } from "../src/lib/modelStyle";

describe("theme system & virtual CSS tokens", () => {
  it("normalizes theme mode and architectural presets with legacy migration", () => {
    expect(DEFAULT_THEME_MODE).toBe("system");
    expect(DEFAULT_THEME_PRESET).toBe("classic");

    expect(normalizeThemeMode("light")).toBe("light");
    expect(normalizeThemeMode("dark")).toBe("dark");
    expect(normalizeThemeMode("system")).toBe("system");
    expect(normalizeThemeMode("invalid")).toBe(DEFAULT_THEME_MODE);
    expect(normalizeThemeMode(null)).toBe(DEFAULT_THEME_MODE);

    expect(THEME_PRESETS.map((p) => p.id)).toEqual([
      "classic",
      "mono",
      "tokyo",
      "claude",
      "linear",
      "stripe",
      "terminal",
    ]);

    for (const preset of THEME_PRESETS) {
      expect(normalizeThemePreset(preset.id)).toBe(preset.id);
      const meta = getThemePresetMeta(preset.id);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.badge.length).toBeGreaterThan(0);
      expect(meta.swatches.paletteLight.length).toBe(4);
      expect(meta.swatches.paletteDark.length).toBe(4);
    }

    // 旧版预设值平滑迁移至新预设
    expect(normalizeThemePreset("indigo")).toBe("linear");
    expect(normalizeThemePreset("ocean")).toBe("tokyo");
    expect(normalizeThemePreset("emerald")).toBe("terminal");
    expect(normalizeThemePreset("violet")).toBe("stripe");
    expect(normalizeThemePreset("amber")).toBe("claude");
    expect(normalizeThemePreset("rose")).toBe("claude");

    expect(normalizeThemePreset("nonexistent")).toBe(DEFAULT_THEME_PRESET);
    expect(normalizeThemePreset(undefined)).toBe(DEFAULT_THEME_PRESET);
  });

  it("resolves effective light/dark mode including system preference", () => {
    expect(resolveEffectiveMode("light", true)).toBe("light");
    expect(resolveEffectiveMode("dark", false)).toBe("dark");
    expect(resolveEffectiveMode("system", true)).toBe("dark");
    expect(resolveEffectiveMode("system", false)).toBe("light");
  });

  it("generates virtual Tailwind v4 CSS covering all 6 light & dark theme presets", () => {
    const css = buildVirtualThemeCss();
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain("@custom-variant dark");
    expect(css).toContain(".theme-canvas");
    expect(css).toContain(".theme-header");
    expect(css).toContain(".theme-account-rail");
    expect(css).toContain(".theme-kpi-strip");
    expect(css).toContain(".theme-kpi-card");
    expect(css).toContain(".theme-popover-surface");
    expect(css).toContain("--theme-grid-line");
    expect(css).toContain("--theme-chart-axis");
    expect(css).toContain("--theme-chart-1");
    expect(css).toContain("--theme-chart-8");
    expect(css).toContain("--theme-radius-card");
    expect(css).toContain("--theme-canvas-overlay");

    for (const preset of THEME_PRESETS) {
      expect(css).toContain(`:root[data-theme="${preset.id}"]`);
      expect(css).toContain(`.dark[data-theme="${preset.id}"]`);
    }
  });
});

describe("smooth monotone cubic Bezier chart paths", () => {
  it("handles empty, single, two-point, and multi-point series safely", () => {
    expect(buildSmoothLinePath([])).toBe("");
    expect(buildSmoothLinePath([{ x: 10, y: 20 }])).toBe("");
    expect(buildSmoothAreaPath([{ x: 10, y: 20 }], 100)).toBe("");

    const two = buildSmoothLinePath([
      { x: 0, y: 80 },
      { x: 50, y: 20 },
    ]);
    expect(two).toBe("M0.0,80.0 L50.0,20.0");

    const pts = [
      { x: 0, y: 100 },
      { x: 40, y: 20 },
      { x: 80, y: 20 },
      { x: 120, y: 90 },
    ];
    const line = buildSmoothLinePath(pts, 10, 110);
    expect(line.startsWith("M0.0,100.0 C")).toBe(true);
    expect(line).toContain("120.0,90.0");

    const area = buildSmoothAreaPath(pts, 110, 10, 110);
    expect(area.startsWith("M0.0,100.0 C")).toBe(true);
    expect(area.endsWith("L120.0,110.0 L0.0,110.0 Z")).toBe(true);
  });
});

describe("model style & distinct chart palette resolution", () => {
  it("strips hyphenated gemini-4 prefixes and assigns distinct colors per tier", () => {
    const high = resolveModelStyle("gemini-4-neon-high", 0);
    const medium = resolveModelStyle("gemini-4-neon-medium", 1);
    const base = resolveModelStyle("gemini-4-neon", 2);

    expect(high.shortLabel).toBe("Neon High");
    expect(medium.shortLabel).toBe("Neon Medium");
    expect(base.shortLabel).toBe("Neon");
    expect(new Set([high.color, medium.color, base.color]).size).toBe(3);
  });

  it("deduplicates colliding series colors with ensureDistinctColors", () => {
    const items = ensureDistinctColors([
      { id: "a", color: "#10b981" },
      { id: "b", color: "#10b981" },
      { id: "c", color: "#10b981" },
    ]);
    expect(new Set(items.map((x) => x.color.toLowerCase())).size).toBe(3);
  });
});
