/**
 * Input: 无外部运行时依赖，纯函数生成 Tailwind v4 虚拟样式表与 经典原版（默认）+ 6 套鲜明辨识度整站级主题（Classic / Vercel / Tokyo Night / Claude 暖陶 / Nebula 星云 / Nord 北欧 / Terminal HUD）的完整 CSS 令牌。
 * Output: 导出 buildVirtualThemeCss()，供 vite.config.ts 注入至 virtual:tailwind.css。
 * Pos: 零物理 .css/.scss 约束下的全局视觉引擎：联动画布底色、氛围光晕/网格材质、卡片层级、几何圆角、控件高亮与 8 槽位图表色盘（src/lib/themeCss.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

/**
 * 职责：构造包含 Tailwind v4 导入、暗色变体、6 套高辨识度整站级主题（浅/深双态独立画布色、氛围纹理、卡片材质、圆角几何与 8 色图表色盘）及语义化组件样式的完整样式源码。
 * 思路：1) 拒绝“换个主色点就叫主题”，每套主题同步改变画布色相与氛围纹理（点阵 / 极光光晕 / 羊皮纸暖光 / HUD 网格）、卡片填充与边框色调、圆角几何（6px 锐利直角 ~ 18px 温润大圆角）及 --theme-chart-1..8 整站图表色盘；
 *      2) 暗色态拒绝 6 个全黑背景，区分曜石黑（Vercel）、夜幕靛蓝（Tokyo #1a1b26）、烘焙深咖（Claude #1f1916）、宇宙紫靛（Nebula #131020）、极夜石板蓝（Nord #232833）与磷光翡翠黑（Terminal #06130f）；
 *      3) 浅色态同样区分纯白瓷灰、天青淡蓝、暖米羊皮纸、薰衣草淡紫、北欧霜灰与薄荷实验纸，保证浅/深任意切换一眼惊艳且高可读。
 * 参数：无。
 * 返回值：供 @tailwindcss/vite 编译的 CSS 文本字符串。
 */
export function buildVirtualThemeCss(): string {
  return `
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

/* ==========================================================================
   0. 经典原版 (Classic / Default) — 忠实还原原版 Slate 浅灰/深海蓝 + 靛蓝翡翠配色
   ========================================================================== */
:root,
:root[data-theme="classic"] {
  --theme-radius-card: 12px;
  --theme-radius-control: 8px;
  --theme-canvas: #f8fafc;
  --theme-canvas-overlay: none;
  --theme-canvas-overlay-size: auto;
  --theme-surface: #ffffff;
  --theme-surface-solid: #ffffff;
  --theme-surface-elevated: #f1f5f9;
  --theme-surface-muted: #f1f5f9;
  --theme-surface-header: rgba(255, 255, 255, 0.94);
  --theme-border: rgba(203, 213, 225, 0.85);
  --theme-border-strong: rgba(148, 163, 184, 0.70);
  --theme-text: #0f172a;
  --theme-text-secondary: #334155;
  --theme-text-muted: #64748b;
  --theme-accent: #4f46e5;
  --theme-accent-hover: #4338ca;
  --theme-accent-soft: rgba(79, 70, 229, 0.10);
  --theme-accent-border: rgba(99, 102, 241, 0.30);
  --theme-accent-ink: #4338ca;
  --theme-accent-contrast: #ffffff;
  --theme-row-hover: rgba(15, 23, 42, 0.03);
  --theme-grid-line: rgba(148, 163, 184, 0.22);
  --theme-chart-axis: #64748b;
  --theme-chart-1: #6366f1; --theme-chart-2: #10b981; --theme-chart-3: #8b5cf6; --theme-chart-4: #f59e0b;
  --theme-chart-5: #0ea5e9; --theme-chart-6: #f43f5e; --theme-chart-7: #14b8a6; --theme-chart-8: #f97316;
  --theme-chart-muted: #94a3b8;
  --theme-shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04);
  --theme-shadow-card-hover: 0 4px 12px -4px rgba(15, 23, 42, 0.09);
  --theme-shadow-popover: 0 16px 36px -8px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.06);
  --theme-scrollbar-thumb: rgba(148, 163, 184, 0.38);
  --theme-scrollbar-thumb-hover: rgba(100, 116, 139, 0.56);
}

.dark,
.dark[data-theme="classic"] {
  --theme-radius-card: 12px;
  --theme-radius-control: 8px;
  --theme-canvas: #020617;
  --theme-canvas-overlay: none;
  --theme-canvas-overlay-size: auto;
  --theme-surface: #0f172a;
  --theme-surface-solid: #0f172a;
  --theme-surface-elevated: #1e293b;
  --theme-surface-muted: #0b1220;
  --theme-surface-header: rgba(2, 6, 23, 0.92);
  --theme-border: rgba(30, 41, 59, 0.92);
  --theme-border-strong: rgba(71, 85, 105, 0.85);
  --theme-text: #f8fafc;
  --theme-text-secondary: #cbd5e1;
  --theme-text-muted: #94a3b8;
  --theme-accent: #6366f1;
  --theme-accent-hover: #818cf8;
  --theme-accent-soft: rgba(99, 102, 241, 0.16);
  --theme-accent-border: rgba(129, 140, 248, 0.36);
  --theme-accent-ink: #a5b4fc;
  --theme-accent-contrast: #ffffff;
  --theme-row-hover: rgba(148, 163, 184, 0.07);
  --theme-grid-line: rgba(148, 163, 184, 0.13);
  --theme-chart-axis: #94a3b8;
  --theme-chart-1: #818cf8; --theme-chart-2: #34d399; --theme-chart-3: #a78bfa; --theme-chart-4: #fbbf24;
  --theme-chart-5: #38bdf8; --theme-chart-6: #fb7185; --theme-chart-7: #2dd4bf; --theme-chart-8: #fb923c;
  --theme-chart-muted: #64748b;
  --theme-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.35);
  --theme-shadow-card-hover: 0 4px 14px -4px rgba(0, 0, 0, 0.50);
  --theme-shadow-popover: 0 20px 46px -10px rgba(0, 0, 0, 0.78), 0 0 0 1px rgba(148, 163, 184, 0.12);
  --theme-scrollbar-thumb: rgba(148, 163, 184, 0.25);
  --theme-scrollbar-thumb-hover: rgba(148, 163, 184, 0.44);
}

/* ==========================================================================
   1. 极简黑白 (Vercel / Geist) — 纯净黑白高对比 + 工程点阵画布
   ========================================================================== */
:root[data-theme="mono"] {
  --theme-radius-card: 12px;
  --theme-radius-control: 8px;
  --theme-canvas: #f2f2f5;
  --theme-canvas-overlay: radial-gradient(rgba(24, 24, 27, 0.09) 1px, transparent 1px);
  --theme-canvas-overlay-size: 20px 20px;
  --theme-surface: #ffffff;
  --theme-surface-solid: #ffffff;
  --theme-surface-elevated: #ececf0;
  --theme-surface-muted: #e5e5ea;
  --theme-surface-header: rgba(242, 242, 245, 0.86);
  --theme-border: rgba(24, 24, 27, 0.10);
  --theme-border-strong: rgba(24, 24, 27, 0.28);
  --theme-text: #09090b;
  --theme-text-secondary: #3f3f46;
  --theme-text-muted: #71717a;
  --theme-accent: #18181b;
  --theme-accent-hover: #27272a;
  --theme-accent-soft: rgba(24, 24, 27, 0.08);
  --theme-accent-border: rgba(24, 24, 27, 0.22);
  --theme-accent-ink: #09090b;
  --theme-accent-contrast: #fafafa;
  --theme-row-hover: rgba(24, 24, 27, 0.035);
  --theme-grid-line: rgba(24, 24, 27, 0.075);
  --theme-chart-axis: #71717a;
  --theme-chart-1: #18181b; --theme-chart-2: #2563eb; --theme-chart-3: #059669; --theme-chart-4: #d97706;
  --theme-chart-5: #e11d48; --theme-chart-6: #0891b2; --theme-chart-7: #7c3aed; --theme-chart-8: #ea580c;
  --theme-chart-muted: #71717a;
  --theme-shadow-card: 0 1px 2px rgba(9, 9, 11, 0.05);
  --theme-shadow-card-hover: 0 4px 12px -4px rgba(9, 9, 11, 0.10), 0 1px 2px rgba(9, 9, 11, 0.05);
  --theme-shadow-popover: 0 16px 38px -8px rgba(9, 9, 11, 0.18), 0 2px 6px rgba(9, 9, 11, 0.08);
  --theme-scrollbar-thumb: rgba(113, 113, 122, 0.28);
  --theme-scrollbar-thumb-hover: rgba(24, 24, 27, 0.48);
}

.dark[data-theme="mono"] {
  --theme-radius-card: 12px;
  --theme-radius-control: 8px;
  --theme-canvas: #09090b;
  --theme-canvas-overlay: radial-gradient(rgba(255, 255, 255, 0.065) 1px, transparent 1px);
  --theme-canvas-overlay-size: 22px 22px;
  --theme-surface: #121216;
  --theme-surface-solid: #141418;
  --theme-surface-elevated: #1c1c22;
  --theme-surface-muted: #19191f;
  --theme-surface-header: rgba(9, 9, 11, 0.84);
  --theme-border: rgba(255, 255, 255, 0.10);
  --theme-border-strong: rgba(255, 255, 255, 0.26);
  --theme-text: #fafafa;
  --theme-text-secondary: #d4d4d8;
  --theme-text-muted: #8a8a95;
  --theme-accent: #fafafa;
  --theme-accent-hover: #ffffff;
  --theme-accent-soft: rgba(255, 255, 255, 0.11);
  --theme-accent-border: rgba(255, 255, 255, 0.26);
  --theme-accent-ink: #ffffff;
  --theme-accent-contrast: #09090b;
  --theme-row-hover: rgba(255, 255, 255, 0.04);
  --theme-grid-line: rgba(255, 255, 255, 0.07);
  --theme-chart-axis: #7a7a85;
  --theme-chart-1: #e4e4e7; --theme-chart-2: #3b82f6; --theme-chart-3: #10b981; --theme-chart-4: #f59e0b;
  --theme-chart-5: #f43f5e; --theme-chart-6: #22d3ee; --theme-chart-7: #a78bfa; --theme-chart-8: #fb923c;
  --theme-chart-muted: #71717a;
  --theme-shadow-card: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  --theme-shadow-card-hover: inset 0 1px 0 rgba(255, 255, 255, 0.09);
  --theme-shadow-popover: 0 20px 48px -10px rgba(0, 0, 0, 0.78), 0 0 0 1px rgba(255, 255, 255, 0.08);
  --theme-scrollbar-thumb: rgba(161, 161, 170, 0.24);
  --theme-scrollbar-thumb-hover: rgba(244, 244, 245, 0.42);
}

/* ==========================================================================
   2. 东京夜幕 (Tokyo Night Storm / Day) — 经典靛蓝夜幕 + 天青极光
   ========================================================================== */
:root[data-theme="tokyo"] {
  --theme-radius-card: 14px;
  --theme-radius-control: 9px;
  --theme-canvas: #dfe6f5;
  --theme-canvas-overlay: radial-gradient(ellipse 90% 48% at 50% -10%, rgba(46, 125, 233, 0.18), transparent 68%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #f7f9fe;
  --theme-surface-solid: #f9fbff;
  --theme-surface-elevated: #e5ecf9;
  --theme-surface-muted: #d8e2f3;
  --theme-surface-header: rgba(223, 230, 245, 0.84);
  --theme-border: rgba(46, 125, 233, 0.18);
  --theme-border-strong: rgba(46, 125, 233, 0.44);
  --theme-text: #1a2340;
  --theme-text-secondary: #374770;
  --theme-text-muted: #5d6e96;
  --theme-accent: #2e7de9;
  --theme-accent-hover: #1d68d1;
  --theme-accent-soft: rgba(46, 125, 233, 0.13);
  --theme-accent-border: rgba(46, 125, 233, 0.34);
  --theme-accent-ink: #1a5ec4;
  --theme-accent-contrast: #ffffff;
  --theme-row-hover: rgba(46, 125, 233, 0.06);
  --theme-grid-line: rgba(46, 125, 233, 0.10);
  --theme-chart-axis: #5d6e96;
  --theme-chart-1: #2e7de9; --theme-chart-2: #587539; --theme-chart-3: #7847bd; --theme-chart-4: #b15c00;
  --theme-chart-5: #f52a65; --theme-chart-6: #007197; --theme-chart-7: #387068; --theme-chart-8: #8c6c3e;
  --theme-chart-muted: #6e7fa8;
  --theme-shadow-card: 0 2px 6px -2px rgba(26, 35, 64, 0.07);
  --theme-shadow-card-hover: 0 6px 16px -6px rgba(46, 125, 233, 0.18);
  --theme-scrollbar-thumb-hover: rgba(46, 125, 233, 0.50);
}

.dark[data-theme="tokyo"] {
  --theme-radius-card: 14px;
  --theme-radius-control: 9px;
  --theme-canvas: #1a1b26;
  --theme-canvas-overlay: radial-gradient(ellipse 85% 48% at 50% -12%, rgba(122, 162, 247, 0.25), rgba(187, 154, 247, 0.08) 46%, transparent 72%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #24283b;
  --theme-surface-solid: #262b40;
  --theme-surface-elevated: #2f3549;
  --theme-surface-muted: #1f2335;
  --theme-surface-header: rgba(26, 27, 38, 0.84);
  --theme-border: rgba(122, 162, 247, 0.20);
  --theme-border-strong: rgba(125, 207, 255, 0.52);
  --theme-text: #c8d3f5;
  --theme-text-secondary: #a9b1d6;
  --theme-text-muted: #737aa2;
  --theme-accent: #7aa2f7;
  --theme-accent-hover: #7dcfff;
  --theme-accent-soft: rgba(122, 162, 247, 0.18);
  --theme-accent-border: rgba(122, 162, 247, 0.42);
  --theme-accent-ink: #89b4fa;
  --theme-accent-contrast: #15161e;
  --theme-row-hover: rgba(122, 162, 247, 0.09);
  --theme-grid-line: rgba(122, 162, 247, 0.11);
  --theme-chart-axis: #737aa2;
  --theme-chart-1: #7aa2f7; --theme-chart-2: #9ece6a; --theme-chart-3: #bb9af7; --theme-chart-4: #e0af68;
  --theme-chart-5: #f7768e; --theme-chart-6: #7dcfff; --theme-chart-7: #73daca; --theme-chart-8: #ff9e64;
  --theme-chart-muted: #565f89;
  --theme-shadow-card: inset 0 1px 0 rgba(192, 202, 245, 0.08), 0 4px 16px -6px rgba(9, 10, 18, 0.45);
  --theme-shadow-card-hover: inset 0 1px 0 rgba(125, 207, 255, 0.18), 0 8px 22px -8px rgba(9, 10, 18, 0.55);
  --theme-scrollbar-thumb-hover: rgba(122, 162, 247, 0.52);
}

/* ==========================================================================
   3. 暖陶纸感 (Claude / Anthropic Editorial) — 暖米羊皮纸 / 烘焙深咖 + 陶土赤
   ========================================================================== */
:root[data-theme="claude"] {
  --theme-radius-card: 18px;
  --theme-radius-control: 10px;
  --theme-canvas: #ede5d6;
  --theme-canvas-overlay: radial-gradient(ellipse 85% 45% at 50% -10%, rgba(201, 100, 66, 0.14), transparent 68%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #faf6ee;
  --theme-surface-solid: #fcf9f2;
  --theme-surface-elevated: #efe7d8;
  --theme-surface-muted: #e5dccb;
  --theme-surface-header: rgba(237, 229, 214, 0.88);
  --theme-border: rgba(110, 78, 52, 0.17);
  --theme-border-strong: rgba(201, 100, 66, 0.48);
  --theme-text: #221a14;
  --theme-text-secondary: #4e3f33;
  --theme-text-muted: #827162;
  --theme-accent: #c96442;
  --theme-accent-hover: #b25130;
  --theme-accent-soft: rgba(201, 100, 66, 0.14);
  --theme-accent-border: rgba(201, 100, 66, 0.36);
  --theme-accent-ink: #ad4c2c;
  --theme-accent-contrast: #fffaf5;
  --theme-row-hover: rgba(201, 100, 66, 0.065);
  --theme-grid-line: rgba(110, 78, 52, 0.10);
  --theme-chart-axis: #827162;
  --theme-chart-1: #c96442; --theme-chart-2: #3d7a5e; --theme-chart-3: #c48b1c; --theme-chart-4: #b55470;
  --theme-chart-5: #45739c; --theme-chart-6: #d4752c; --theme-chart-7: #7a6299; --theme-chart-8: #6d7c46;
  --theme-chart-muted: #938273;
  --theme-shadow-card: 0 2px 8px -3px rgba(62, 42, 24, 0.08);
  --theme-shadow-card-hover: 0 6px 18px -6px rgba(158, 82, 48, 0.16);
  --theme-scrollbar-thumb-hover: rgba(201, 100, 66, 0.50);
}

.dark[data-theme="claude"] {
  --theme-radius-card: 18px;
  --theme-radius-control: 10px;
  --theme-canvas: #1f1916;
  --theme-canvas-overlay: radial-gradient(ellipse 80% 45% at 50% -10%, rgba(227, 130, 95, 0.22), rgba(233, 196, 106, 0.06) 45%, transparent 70%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #2b231e;
  --theme-surface-solid: #2f2621;
  --theme-surface-elevated: #382e28;
  --theme-surface-muted: #241d19;
  --theme-surface-header: rgba(31, 25, 22, 0.86);
  --theme-border: rgba(242, 206, 178, 0.15);
  --theme-border-strong: rgba(227, 130, 95, 0.52);
  --theme-text: #f7efe6;
  --theme-text-secondary: #dfd0c0;
  --theme-text-muted: #a69484;
  --theme-accent: #e3825f;
  --theme-accent-hover: #f09777;
  --theme-accent-soft: rgba(227, 130, 95, 0.18);
  --theme-accent-border: rgba(227, 130, 95, 0.42);
  --theme-accent-ink: #f3a689;
  --theme-accent-contrast: #1f1916;
  --theme-row-hover: rgba(227, 130, 95, 0.09);
  --theme-grid-line: rgba(242, 206, 178, 0.09);
  --theme-chart-axis: #a69484;
  --theme-chart-1: #e3825f; --theme-chart-2: #81b29a; --theme-chart-3: #e9c46a; --theme-chart-4: #d98ca3;
  --theme-chart-5: #7ca5c8; --theme-chart-6: #f4a261; --theme-chart-7: #b59cd6; --theme-chart-8: #a9b879;
  --theme-chart-muted: #8a7a6c;
  --theme-shadow-card: inset 0 1px 0 rgba(255, 232, 212, 0.07), 0 4px 16px -6px rgba(10, 6, 4, 0.45);
  --theme-shadow-card-hover: inset 0 1px 0 rgba(227, 130, 95, 0.18), 0 8px 22px -8px rgba(10, 6, 4, 0.55);
  --theme-scrollbar-thumb-hover: rgba(227, 130, 95, 0.52);
}

/* ==========================================================================
   4. 星云紫境 (Nebula / Linear) — 宇宙紫靛星云光晕 + 电光紫/品红数据色盘
   ========================================================================== */
:root[data-theme="linear"] {
  --theme-radius-card: 16px;
  --theme-radius-control: 10px;
  --theme-canvas: #ece6fa;
  --theme-canvas-overlay: radial-gradient(ellipse 85% 48% at 50% -12%, rgba(124, 58, 237, 0.18), rgba(219, 39, 119, 0.07) 48%, transparent 72%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #fbfaff;
  --theme-surface-solid: #ffffff;
  --theme-surface-elevated: #ece6fc;
  --theme-surface-muted: #e2d9f8;
  --theme-surface-header: rgba(236, 230, 250, 0.85);
  --theme-border: rgba(124, 58, 237, 0.17);
  --theme-border-strong: rgba(124, 58, 237, 0.45);
  --theme-text: #1b1334;
  --theme-text-secondary: #43376a;
  --theme-text-muted: #706399;
  --theme-accent: #7c3aed;
  --theme-accent-hover: #6d28d9;
  --theme-accent-soft: rgba(124, 58, 237, 0.13);
  --theme-accent-border: rgba(124, 58, 237, 0.34);
  --theme-accent-ink: #6d28d9;
  --theme-accent-contrast: #ffffff;
  --theme-row-hover: rgba(124, 58, 237, 0.06);
  --theme-grid-line: rgba(124, 58, 237, 0.10);
  --theme-chart-axis: #706399;
  --theme-chart-1: #7c3aed; --theme-chart-2: #059669; --theme-chart-3: #db2777; --theme-chart-4: #2563eb;
  --theme-chart-5: #d97706; --theme-chart-6: #0891b2; --theme-chart-7: #9333ea; --theme-chart-8: #e11d48;
  --theme-chart-muted: #7f73a3;
  --theme-shadow-card: 0 2px 8px -3px rgba(67, 55, 106, 0.09);
  --theme-shadow-card-hover: 0 6px 18px -6px rgba(124, 58, 237, 0.20);
  --theme-scrollbar-thumb-hover: rgba(124, 58, 237, 0.50);
}

.dark[data-theme="linear"] {
  --theme-radius-card: 16px;
  --theme-radius-control: 10px;
  --theme-canvas: #131020;
  --theme-canvas-overlay: radial-gradient(ellipse 85% 50% at 50% -14%, rgba(167, 139, 250, 0.28), rgba(244, 114, 182, 0.10) 45%, transparent 72%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #1d1832;
  --theme-surface-solid: #201b38;
  --theme-surface-elevated: #282145;
  --theme-surface-muted: #18132a;
  --theme-surface-header: rgba(19, 16, 32, 0.84);
  --theme-border: rgba(167, 139, 250, 0.20);
  --theme-border-strong: rgba(196, 181, 253, 0.52);
  --theme-text: #f3f0ff;
  --theme-text-secondary: #cdc5ee;
  --theme-text-muted: #8f84ba;
  --theme-accent: #a78bfa;
  --theme-accent-hover: #c4b5fd;
  --theme-accent-soft: rgba(167, 139, 250, 0.19);
  --theme-accent-border: rgba(167, 139, 250, 0.44);
  --theme-accent-ink: #c4b5fd;
  --theme-accent-contrast: #131020;
  --theme-row-hover: rgba(167, 139, 250, 0.10);
  --theme-grid-line: rgba(167, 139, 250, 0.11);
  --theme-chart-axis: #8f84ba;
  --theme-chart-1: #a78bfa; --theme-chart-2: #34d399; --theme-chart-3: #f472b6; --theme-chart-4: #60a5fa;
  --theme-chart-5: #fbbf24; --theme-chart-6: #22d3ee; --theme-chart-7: #c084fc; --theme-chart-8: #fb7185;
  --theme-chart-muted: #786ea1;
  --theme-shadow-card: inset 0 1px 0 rgba(196, 181, 253, 0.10), 0 6px 20px -8px rgba(7, 4, 18, 0.55);
  --theme-shadow-card-hover: inset 0 1px 0 rgba(196, 181, 253, 0.22), 0 10px 26px -8px rgba(7, 4, 18, 0.65);
  --theme-scrollbar-thumb-hover: rgba(167, 139, 250, 0.55);
}

/* ==========================================================================
   5. 北欧霜蓝 (Nord Polar Night / Snow Storm) — 经典石板蓝 + 冰川青极光
   ========================================================================== */
:root[data-theme="stripe"] {
  --theme-radius-card: 14px;
  --theme-radius-control: 8px;
  --theme-canvas: #dce4ef;
  --theme-canvas-overlay: radial-gradient(ellipse 85% 46% at 50% -10%, rgba(94, 129, 172, 0.18), transparent 68%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #f7f9fc;
  --theme-surface-solid: #fafbfd;
  --theme-surface-elevated: #e5ecf4;
  --theme-surface-muted: #d4dfec;
  --theme-surface-header: rgba(220, 228, 239, 0.86);
  --theme-border: rgba(59, 126, 161, 0.19);
  --theme-border-strong: rgba(59, 126, 161, 0.46);
  --theme-text: #242933;
  --theme-text-secondary: #3b4252;
  --theme-text-muted: #616e85;
  --theme-accent: #3b7ea1;
  --theme-accent-hover: #2d6a8a;
  --theme-accent-soft: rgba(59, 126, 161, 0.14);
  --theme-accent-border: rgba(59, 126, 161, 0.36);
  --theme-accent-ink: #276382;
  --theme-accent-contrast: #ffffff;
  --theme-row-hover: rgba(59, 126, 161, 0.065);
  --theme-grid-line: rgba(59, 126, 161, 0.11);
  --theme-chart-axis: #616e85;
  --theme-chart-1: #2f7d99; --theme-chart-2: #557a46; --theme-chart-3: #84567d; --theme-chart-4: #c28629;
  --theme-chart-5: #b54550; --theme-chart-6: #4b6f94; --theme-chart-7: #3f8a7c; --theme-chart-8: #b8663d;
  --theme-chart-muted: #707d94;
  --theme-shadow-card: 0 2px 6px -2px rgba(46, 52, 64, 0.08);
  --theme-shadow-card-hover: 0 6px 16px -6px rgba(59, 126, 161, 0.18);
  --theme-scrollbar-thumb-hover: rgba(59, 126, 161, 0.50);
}

.dark[data-theme="stripe"] {
  --theme-radius-card: 14px;
  --theme-radius-control: 8px;
  --theme-canvas: #232833;
  --theme-canvas-overlay: radial-gradient(ellipse 85% 46% at 50% -10%, rgba(136, 192, 208, 0.22), rgba(129, 161, 193, 0.08) 45%, transparent 70%);
  --theme-canvas-overlay-size: 100% 100%;
  --theme-surface: #2e3440;
  --theme-surface-solid: #323846;
  --theme-surface-elevated: #3b4252;
  --theme-surface-muted: #272c38;
  --theme-surface-header: rgba(35, 40, 51, 0.86);
  --theme-border: rgba(136, 192, 208, 0.20);
  --theme-border-strong: rgba(143, 188, 187, 0.55);
  --theme-text: #eceff4;
  --theme-text-secondary: #d8dee9;
  --theme-text-muted: #93a1b8;
  --theme-accent: #88c0d0;
  --theme-accent-hover: #8fbcbb;
  --theme-accent-soft: rgba(136, 192, 208, 0.18);
  --theme-accent-border: rgba(136, 192, 208, 0.44);
  --theme-accent-ink: #88c0d0;
  --theme-accent-contrast: #1d222b;
  --theme-row-hover: rgba(136, 192, 208, 0.09);
  --theme-grid-line: rgba(216, 222, 233, 0.10);
  --theme-chart-axis: #93a1b8;
  --theme-chart-1: #88c0d0; --theme-chart-2: #a3be8c; --theme-chart-3: #b48ead; --theme-chart-4: #ebcb8b;
  --theme-chart-5: #bf616a; --theme-chart-6: #81a1c1; --theme-chart-7: #8fbcbb; --theme-chart-8: #d08770;
  --theme-chart-muted: #6e7b91;
  --theme-shadow-card: inset 0 1px 0 rgba(236, 239, 244, 0.08), 0 4px 14px -6px rgba(15, 19, 26, 0.45);
  --theme-shadow-card-hover: inset 0 1px 0 rgba(136, 192, 208, 0.20), 0 8px 20px -8px rgba(15, 19, 26, 0.55);
  --theme-scrollbar-thumb-hover: rgba(136, 192, 208, 0.52);
}

/* ==========================================================================
   6. 黑客矩阵 (Cyber Terminal HUD) — 锐利直角 6px + 翡翠工程网格 + 磷光遥测
   ========================================================================== */
:root[data-theme="terminal"] {
  --theme-radius-card: 6px;
  --theme-radius-control: 4px;
  --theme-canvas: #dff0e8;
  --theme-canvas-overlay: linear-gradient(rgba(5, 150, 105, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(5, 150, 105, 0.08) 1px, transparent 1px);
  --theme-canvas-overlay-size: 24px 24px;
  --theme-surface: #f6fcf9;
  --theme-surface-solid: #f9fefb;
  --theme-surface-elevated: #e1f2ea;
  --theme-surface-muted: #d3eadd;
  --theme-surface-header: rgba(223, 240, 232, 0.88);
  --theme-border: rgba(5, 150, 105, 0.24);
  --theme-border-strong: rgba(4, 120, 87, 0.55);
  --theme-text: #062419;
  --theme-text-secondary: #1b4d3b;
  --theme-text-muted: #467865;
  --theme-accent: #047857;
  --theme-accent-hover: #065f46;
  --theme-accent-soft: rgba(5, 150, 105, 0.14);
  --theme-accent-border: rgba(5, 150, 105, 0.40);
  --theme-accent-ink: #065f46;
  --theme-accent-contrast: #ecfdf5;
  --theme-row-hover: rgba(5, 150, 105, 0.07);
  --theme-grid-line: rgba(5, 150, 105, 0.12);
  --theme-chart-axis: #467865;
  --theme-chart-1: #059669; --theme-chart-2: #0891b2; --theme-chart-3: #65a30d; --theme-chart-4: #d97706;
  --theme-chart-5: #e11d48; --theme-chart-6: #0284c7; --theme-chart-7: #0d9488; --theme-chart-8: #ca8a04;
  --theme-chart-muted: #5b8575;
  --theme-shadow-card: 0 1px 0 rgba(5, 150, 105, 0.12);
  --theme-shadow-card-hover: 0 0 0 1px rgba(5, 150, 105, 0.35);
  --theme-scrollbar-thumb-hover: rgba(5, 150, 105, 0.55);
}

.dark[data-theme="terminal"] {
  --theme-radius-card: 6px;
  --theme-radius-control: 4px;
  --theme-canvas: #06130f;
  --theme-canvas-overlay: linear-gradient(rgba(52, 211, 153, 0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(52, 211, 153, 0.07) 1px, transparent 1px);
  --theme-canvas-overlay-size: 24px 24px;
  --theme-surface: #0b2019;
  --theme-surface-solid: #0d251d;
  --theme-surface-elevated: #112e24;
  --theme-surface-muted: #081913;
  --theme-surface-header: rgba(6, 19, 15, 0.88);
  --theme-border: rgba(52, 211, 153, 0.24);
  --theme-border-strong: rgba(52, 211, 153, 0.62);
  --theme-text: #e6fff5;
  --theme-text-secondary: #a7e8cf;
  --theme-text-muted: #5ca68b;
  --theme-accent: #34d399;
  --theme-accent-hover: #6ee7b7;
  --theme-accent-soft: rgba(52, 211, 153, 0.17);
  --theme-accent-border: rgba(52, 211, 153, 0.48);
  --theme-accent-ink: #6ee7b7;
  --theme-accent-contrast: #041d15;
  --theme-row-hover: rgba(52, 211, 153, 0.10);
  --theme-grid-line: rgba(52, 211, 153, 0.11);
  --theme-chart-axis: #5ca68b;
  --theme-chart-1: #34d399; --theme-chart-2: #22d3ee; --theme-chart-3: #a3e635; --theme-chart-4: #fbbf24;
  --theme-chart-5: #fb7185; --theme-chart-6: #38bdf8; --theme-chart-7: #2dd4bf; --theme-chart-8: #fde047;
  --theme-chart-muted: #467865;
  --theme-shadow-card: inset 0 1px 0 rgba(52, 211, 153, 0.14), 0 0 24px -12px rgba(16, 185, 129, 0.35);
  --theme-shadow-card-hover: inset 0 1px 0 rgba(110, 231, 183, 0.28), 0 0 28px -10px rgba(52, 211, 153, 0.45);
  --theme-scrollbar-thumb-hover: rgba(52, 211, 153, 0.58);
}

@layer base {
  html {
    background-color: var(--theme-canvas);
    color: var(--theme-text);
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-feature-settings: "cv02", "cv03", "cv04", "cv11";
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }

  body {
    background-color: var(--theme-canvas);
    color: var(--theme-text);
  }

  code, pre, kbd, .font-mono {
    font-family: "JetBrains Mono", "Geist Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  :root[data-theme="terminal"] h1,
  :root[data-theme="terminal"] [data-slot="card-title"] {
    font-family: "JetBrains Mono", "Geist Mono", "SF Mono", ui-monospace, monospace;
    letter-spacing: -0.01em;
  }

  ::selection {
    background-color: var(--theme-accent-soft);
    color: var(--theme-accent-ink);
  }

  * {
    scrollbar-width: thin;
    scrollbar-color: var(--theme-scrollbar-thumb) transparent;
  }

  *::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  *::-webkit-scrollbar-track {
    background: transparent;
  }

  *::-webkit-scrollbar-thumb {
    border-radius: 9999px;
    background-color: var(--theme-scrollbar-thumb);
  }

  *::-webkit-scrollbar-thumb:hover {
    background-color: var(--theme-scrollbar-thumb-hover);
  }
}

@layer components {
  .theme-canvas {
    background-color: var(--theme-canvas);
    background-image: var(--theme-canvas-overlay);
    background-size: var(--theme-canvas-overlay-size);
    background-attachment: fixed;
    color: var(--theme-text);
    transition: background-color 220ms ease, color 180ms ease;
  }

  .theme-header {
    background-color: var(--theme-surface-header);
    border-color: var(--theme-border);
    backdrop-filter: blur(14px) saturate(150%);
    -webkit-backdrop-filter: blur(14px) saturate(150%);
  }

  .theme-brand-badge {
    background-color: var(--theme-accent);
    color: var(--theme-accent-contrast);
    border-radius: var(--theme-radius-control);
  }

  .theme-account-rail {
    background-color: var(--theme-surface);
    border-color: var(--theme-border);
    border-radius: var(--theme-radius-card);
    box-shadow: var(--theme-shadow-card);
  }

  .theme-kpi-strip {
    border-radius: var(--theme-radius-card);
    transition: border-color 180ms ease, box-shadow 180ms ease, border-radius 180ms ease;
  }

  .theme-card,
  [data-slot="card"] {
    background-color: var(--theme-surface);
    border-color: var(--theme-border);
    border-radius: var(--theme-radius-card);
    box-shadow: var(--theme-shadow-card);
    color: var(--theme-text);
    transition: border-color 180ms ease, box-shadow 180ms ease, background-color 220ms ease, border-radius 180ms ease;
  }

  .theme-kpi-card {
    position: relative;
  }

  .theme-kpi-card:hover {
    border-color: var(--theme-border-strong);
    box-shadow: var(--theme-shadow-card-hover);
  }

  .theme-surface-solid,
  .theme-popover-surface {
    background-color: var(--theme-surface-solid);
    border-color: var(--theme-border);
    border-radius: var(--theme-radius-card);
    color: var(--theme-text);
    box-shadow: var(--theme-shadow-popover);
  }

  .theme-accent-pill {
    background-color: var(--theme-accent-soft);
    border-color: var(--theme-accent-border);
    color: var(--theme-accent-ink);
  }

  .theme-accent-text {
    color: var(--theme-accent-ink);
  }

  .theme-accent-icon {
    color: var(--theme-accent);
  }

  .theme-text {
    color: var(--theme-text);
  }

  .theme-text-secondary {
    color: var(--theme-text-secondary);
  }

  .theme-text-muted {
    color: var(--theme-text-muted);
  }

  [data-slot="tabs-list"] {
    background-color: var(--theme-surface-muted);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius-control);
    color: var(--theme-text-muted);
  }

  [data-slot="tabs-trigger"] {
    border-radius: calc(var(--theme-radius-control) - 2px);
    color: var(--theme-text-muted);
  }

  [data-slot="tabs-trigger"]:hover {
    color: var(--theme-text);
  }

  [data-slot="tabs-trigger"][data-state="active"] {
    background-color: var(--theme-accent-soft);
    color: var(--theme-accent-ink);
    border-color: var(--theme-accent-border);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }

  [data-slot="select-trigger"],
  [data-slot="button"][data-variant="outline"] {
    background-color: var(--theme-surface-solid);
    border-color: var(--theme-border);
    border-radius: var(--theme-radius-control);
    color: var(--theme-text);
  }

  [data-slot="select-trigger"]:hover,
  [data-slot="button"][data-variant="outline"]:hover {
    border-color: var(--theme-border-strong);
    background-color: var(--theme-surface-elevated);
  }

  [data-slot="select-content"],
  [data-slot="dialog-content"] {
    background-color: var(--theme-surface-solid);
    border-color: var(--theme-border);
    border-radius: var(--theme-radius-card);
    color: var(--theme-text);
    box-shadow: var(--theme-shadow-popover);
  }

  [data-slot="input"] {
    background-color: var(--theme-surface-solid);
    border-color: var(--theme-border);
    border-radius: var(--theme-radius-control);
    color: var(--theme-text);
  }

  [data-slot="input"]:focus-visible {
    border-color: var(--theme-accent);
    box-shadow: 0 0 0 2px var(--theme-accent-soft);
  }

  [data-slot="table-row"] {
    border-color: var(--theme-border);
  }

  [data-slot="table-row"]:hover {
    background-color: var(--theme-row-hover);
  }

  [data-slot="badge"][data-variant="secondary"] {
    background-color: var(--theme-surface-elevated);
    color: var(--theme-text-secondary);
  }
}
`;
}
