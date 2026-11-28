/**
 * Input: DashboardSummaryPayload 领域聚合结果契约与命令行参数字符串数组。
 * Output: 导出 parseCliArgs 参数解析函数、renderCliReport 终端对齐报表函数与 renderCliHelp 帮助说明函数。
 * Pos: 终端一键统计 CLI（npm run stats）的参数解析与纯文本表格可视化渲染层。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import type { DashboardSummaryPayload } from "../src/types/telemetry";

/** CLI 命令行解析结果结构 */
export interface ParsedCliArgs {
  source?: string; // 按数据源 / 账号 ID 过滤（如 all / native / t3:antigravity）
  days?: number; // 最近 N 天过滤窗口
  workspace?: string; // 按工作区名称或路径过滤
  model?: string; // 按模型名称过滤
  json: boolean; // 是否直接输出原始 JSON
  limit: number; // 会话明细表最大显示条数（默认 10）
  dataDir?: string; // 自定义 AntiGravity 数据根目录
  help: boolean; // 是否打印命令行帮助信息
}

type ColumnAlign = "left" | "right";

/**
 * 职责：解析终端命令行参数数组并输出标准化的 CLI 配置项。
 * 思路：顺序扫描参数，兼容短选项（-d/-w/-m/-n/-h）、长选项（--days 等）以及 --key=value 写法。
 * 参数：argv — 去除 node 与脚本路径后的参数数组（如 process.argv.slice(2)）。
 * 返回值：解析后的 ParsedCliArgs 对象。
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = { json: false, limit: 10, help: false }; // 默认 CLI 参数状态

  // 0. 顺序遍历命令行 token 并提取键值对或布尔开关
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eqIndex = token.indexOf("=");
    const flag = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
    const inlineVal = eqIndex >= 0 ? token.slice(eqIndex + 1) : undefined;

    // 1.1. 处理布尔型开关参数
    if (flag === "--json") {
      result.json = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      result.help = true;
      continue;
    }

    // 1.2. 读取带值选项的参数值（优先内联等号值，否则消费下一个参数）
    const nextVal = inlineVal !== undefined ? inlineVal : argv[i + 1];
    const consumeNext = inlineVal === undefined;
    if (nextVal === undefined) continue;

    if (flag === "--days" || flag === "-d") {
      const parsed = Number(nextVal);
      if (Number.isFinite(parsed) && parsed > 0) result.days = Math.floor(parsed);
      if (consumeNext) i += 1;
    } else if (flag === "--workspace" || flag === "-w") {
      const trimmed = nextVal.trim();
      if (trimmed && trimmed.toLowerCase() !== "all") result.workspace = trimmed;
      if (consumeNext) i += 1;
    } else if (flag === "--model" || flag === "-m") {
      const trimmed = nextVal.trim();
      if (trimmed && trimmed.toLowerCase() !== "all") result.model = trimmed;
      if (consumeNext) i += 1;
    } else if (flag === "--limit" || flag === "-n") {
      const parsed = Number(nextVal);
      if (Number.isFinite(parsed) && parsed > 0) result.limit = Math.floor(parsed);
      if (consumeNext) i += 1;
    } else if (flag === "--source" || flag === "-s") {
      const trimmed = nextVal.trim();
      if (trimmed) result.source = trimmed;
      if (consumeNext) i += 1;
    } else if (flag === "--data-dir") {
      const trimmed = nextVal.trim();
      if (trimmed) result.dataDir = trimmed;
      if (consumeNext) i += 1;
    }
  }

  return result;
}

/**
 * 职责：判断单个 Unicode 码点在等宽终端中是否占据双倍列宽（CJK 全角字符）。
 * 参数：code — Unicode 码点数值。
 * 返回值：true 表示占 2 列宽，false 表示占 1 列宽。
 */
function isWideCodePoint(code: number): boolean {
  // 0. 覆盖中日韩统一表意文字、全角标点与谚文区间
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  );
}

/**
 * 职责：计算字符串在终端等宽字体下的实际显示列宽。
 * 参数：text — 待测量的单行文本。
 * 返回值：终端显示总列数。
 */
function getDisplayWidth(text: string): number {
  let width = 0; // 累计显示列宽
  // 0. 按完整 Unicode 码点迭代，避免拆断代理对
  for (const ch of text) {
    width += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/**
 * 职责：将多行或超长文本清洗为单行并按终端显示宽度安全截断。
 * 参数：text — 原始文本；maxWidth — 最大允许显示列宽。
 * 返回值：截断后的单行安全字符串。
 */
function truncateDisplay(text: string, maxWidth: number): string {
  // 0. 折叠换行与多余空白，确保表格单行稳定
  const clean = text.replace(/\s+/g, " ").trim();
  if (getDisplayWidth(clean) <= maxWidth) return clean;
  if (maxWidth <= 3) return ".".repeat(Math.max(0, maxWidth));

  // 1.1. 预留 3 列给 ASCII 省略号 "..."，逐字符累加直至达到上限
  const budget = maxWidth - 3;
  let used = 0;
  let out = "";
  for (const ch of clean) {
    const w = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return `${out}...`;
}

/**
 * 职责：按终端实际显示宽度将单元格文本左对齐或右对齐填充空格。
 * 参数：text — 单元格字符串；width — 目标总列宽；align — 对齐方向。
 * 返回值：填充对齐后的定宽字符串。
 */
function padDisplay(text: string, width: number, align: ColumnAlign): string {
  // 0. 计算差值空格数量并按方向拼接
  const spaces = " ".repeat(Math.max(0, width - getDisplayWidth(text)));
  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

/**
 * 职责：渲染带边框对齐的纯文本二维表格。
 * 参数：headers — 表头列名数组；aligns — 各列对齐方式；rows — 数据行二维数组。
 * 返回值：拼接好的多行终端表格文本。
 */
function renderBoxTable(headers: string[], aligns: ColumnAlign[], rows: string[][]): string {
  // 0. 统计每一列在表头与所有数据行中的最大显示列宽
  const widths = headers.map((header, colIdx) =>
    rows.reduce((maxW, row) => Math.max(maxW, getDisplayWidth(row[colIdx] ?? "")), getDisplayWidth(header)),
  );

  // 1.1. 构造边框分隔线与格式化行拼装器
  const topBorder = `┌─${widths.map((w) => "─".repeat(w)).join("─┬─")}─┐`;
  const midBorder = `├─${widths.map((w) => "─".repeat(w)).join("─┼─")}─┤`;
  const botBorder = `└─${widths.map((w) => "─".repeat(w)).join("─┴─")}─┘`;
  const headerLine = `│ ${headers.map((h, i) => padDisplay(h, widths[i], aligns[i])).join(" │ ")} │`;
  const bodyLines = rows.map(
    (row) => `│ ${widths.map((w, i) => padDisplay(row[i] ?? "", w, aligns[i])).join(" │ ")} │`,
  );
  return [topBorder, headerLine, midBorder, ...bodyLines, botBorder].join("\n");
}

/**
 * 职责：格式化千分位整数、美元金额与百分比指标文本。
 * 参数：value — 待格式化的数值；mode — 格式化模式（int/usd/pct）。
 * 返回值：可读的指标字符串。
 */
function fmtMetric(value: number, mode: "int" | "usd" | "pct"): string {
  // 0. 按模式分支格式化千分位、美元或百分比
  if (mode === "int") return Math.round(value).toLocaleString("en-US");
  if (mode === "pct") return `${(value * 100).toFixed(1)}%`;
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * 职责：返回 CLI 命令行的使用帮助文本。
 * 参数：无。
 * 返回值：多行帮助说明字符串。
 */
export function renderCliHelp(): string {
  // 0. 输出支持的全部过滤参数与示例命令
  return [
    "AntiGravity Token Radar CLI",
    "Usage: npm run stats -- [-s <source>] [-d <days>] [-w <workspace>] [-m <model>] [-n <limit>] [--data-dir <path>] [--json] [-h]",
  ].join("\n");
}

/**
 * 职责：将 DashboardSummaryPayload 聚合数据渲染为适用于 macOS 终端的对齐统计报表。
 * 思路：依次输出 1) 数据源诊断头；2) 核心 Token/成本 KPI 面板；3) 模型表；4) 工作区表；5) Top 会话表。
 * 参数：summary — 聚合层输出的完整看板数据载荷；limit — 会话列表最大展示行数（默认 10）。
 * 返回值：可直接打印到标准输出的多行纯文本报表。
 */
export function renderCliReport(summary: DashboardSummaryPayload, limit = 10): string {
  const { health, totals, byModel, byWorkspace, conversations } = summary;
  const maxConvRows = Math.max(0, limit); // 会话表格最大截断行数
  const sections: string[] = []; // 各区块文本缓冲列表

  // 1. 顶部数据源诊断与规模摘要
  const headerLines = [
    "══════════════════════════════════════════════════════════════════════════════",
    "  AntiGravity Token Radar — Local Telemetry Summary",
    "══════════════════════════════════════════════════════════════════════════════",
    `  Data Dir     : ${health.dataDir} (${health.exists ? "found" : "missing"})`,
    `  SQLite Mode  : ${health.sqliteReadMode} | Scan Latency: ${health.scanDurationMs} ms`,
    `  Scope        : ${fmtMetric(totals.conversationCount, "int")} conversations (${fmtMetric(totals.subagentCount, "int")} subagents) | ${fmtMetric(totals.callCount, "int")} LLM calls`,
  ];
  if (health.warnings.length > 0) headerLines.push(`  Warnings     : ${health.warnings.join("; ")}`);
  sections.push(headerLines.join("\n"));

  // 2. 核心 Token 与等效 API 成本 KPI 汇总表
  sections.push(
    `[Core Token KPIs]\n${renderBoxTable(
      ["Metric", "Value", "Detail"],
      ["left", "right", "left"],
      [
        ["Total Tokens", fmtMetric(totals.totalTokens, "int"), "Uncached Input + Cache Read + Output"],
        ["Today's Tokens", fmtMetric(totals.todayTotalTokens, "int"), `Today Est. Cost: ${fmtMetric(totals.todayEstimatedCostUsd, "usd")}`],
        ["Uncached Input", fmtMetric(totals.inputTokens, "int"), "Fresh prompt & tool result tokens"],
        ["Cache Read", fmtMetric(totals.cacheReadTokens, "int"), `Cache Hit Rate: ${fmtMetric(totals.cacheHitRate, "pct")}`],
        ["Output Tokens", fmtMetric(totals.outputTokens, "int"), `Thinking: ${fmtMetric(totals.thinkingTokens, "int")} | Response: ${fmtMetric(totals.responseTokens, "int")}${totals.avgOutputTps > 0 ? ` | TPS: ${totals.avgOutputTps.toFixed(1)}/s (Stream ${totals.avgStreamingTps.toFixed(1)}/s)` : ""}`],
        ["Est. API Cost", fmtMetric(totals.estimatedCostUsd, "usd"), `Prompt Cache Savings: ${fmtMetric(totals.cacheSavedUsd, "usd")}`],
      ],
    )}`,
  );

  // 2.5. 多账号/多数据源拆解表（自动发现 T3 Code 多账号与原生目录时展示）
  if (summary.sources && summary.sources.length > 1) {
    sections.push(
      `[By Account / Source]\n${renderBoxTable(
        ["Source", "ID", "Convs", "Calls", "Today", "Total Tokens", "Est. Cost"],
        ["left", "left", "right", "right", "right", "right", "right"],
        summary.sources.map((src) => [
          truncateDisplay(src.label, 18),
          truncateDisplay(src.id, 18),
          fmtMetric(src.conversationCount, "int"),
          fmtMetric(src.callCount, "int"),
          fmtMetric(src.todayEstimatedCostUsd, "usd"),
          fmtMetric(src.totalTokens, "int"),
          fmtMetric(src.estimatedCostUsd, "usd"),
        ]),
      )}`,
    );
  }

  // 3. 按模型维度拆解表
  sections.push(
    byModel.length === 0
      ? "[By Model]\n  (no model usage records)"
      : `[By Model]\n${renderBoxTable(
          ["Model", "Calls", "Input", "Cache Read", "Output", "Hit %", "Est. Cost"],
          ["left", "right", "right", "right", "right", "right", "right"],
          byModel.map((m) => [
            truncateDisplay(m.modelName, 28),
            fmtMetric(m.callCount, "int"),
            fmtMetric(m.inputTokens, "int"),
            fmtMetric(m.cacheReadTokens, "int"),
            fmtMetric(m.outputTokens, "int"),
            fmtMetric(m.cacheHitRate, "pct"),
            fmtMetric(m.estimatedCostUsd, "usd"),
          ]),
        )}`,
  );

  // 4. 按工作区维度拆解表
  sections.push(
    byWorkspace.length === 0
      ? "[By Workspace]\n  (no workspace usage records)"
      : `[By Workspace]\n${renderBoxTable(
          ["Workspace", "Convs", "Calls", "Total Tokens", "Est. Cost"],
          ["left", "right", "right", "right", "right"],
          byWorkspace.map((ws) => [
            truncateDisplay(ws.workspaceName, 26),
            fmtMetric(ws.conversationCount, "int"),
            fmtMetric(ws.callCount, "int"),
            fmtMetric(ws.totalTokens, "int"),
            fmtMetric(ws.estimatedCostUsd, "usd"),
          ]),
        )}`,
  );

  // 5. Top 会话消耗与最近活跃明细表
  const topConversations = conversations.slice(0, maxConvRows);
  sections.push(
    topConversations.length === 0
      ? `[Top Conversations (0/${conversations.length})]\n  (no conversations matched)`
      : `[Top Conversations (${topConversations.length}/${conversations.length})]\n${renderBoxTable(
          ["Title", "Workspace", "Model", "Calls", "Total Tokens", "Est. Cost"],
          ["left", "left", "left", "right", "right", "right"],
          topConversations.map((conv) => {
            const prefix = conv.nestingDepth > 0 || conv.parentConversationId ? "[sub] " : "";
            return [
              truncateDisplay(`${prefix}${conv.title || conv.conversationId}`, 34),
              truncateDisplay(conv.workspaceName || "-", 16),
              truncateDisplay(conv.primaryModel || "-", 22),
              fmtMetric(conv.callCount, "int"),
              fmtMetric(conv.totalTokens, "int"),
              fmtMetric(conv.estimatedCostUsd, "usd"),
            ];
          }),
        )}`,
  );

  return sections.join("\n\n");
}
