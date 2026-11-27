/**
 * Input: vitest 断言工具、node:fs/http/os/path 模块，以及 server/app.ts 与 server/cliRender.ts 待测模块。
 * Output: 验证 HTTP 遥测服务路由、查询转发、UTF-8 BOM CSV 转义、静态安全托管与 CLI 解析渲染的完整测试套件。
 * Pos: 服务端 API 层与终端 CLI 展示层的自动化契约与回归测试。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryHttpServer } from "../server/app";
import { createCalibrationStore } from "../server/resetStore";
import { parseCliArgs, renderCliReport } from "../server/cliRender";
import type { ConversationDetail, ConversationUsageSummary, DashboardSummaryPayload, DataSourceHealth, TelemetryFilterOptions, TelemetryProvider } from "../src/types/telemetry";

/**
 * 职责：快速生成测试会话汇总条目并用局部字段覆盖默认值。
 * 参数：overrides — 需要覆盖的会话汇总属性。
 * 返回值：完整的 ConversationUsageSummary 对象。
 */
function makeConversation(overrides: Partial<ConversationUsageSummary>): ConversationUsageSummary {
  // 0. 提供默认会话汇总基线并合并调用方覆盖属性
  return {
    conversationId: "conv-main-001",
    title: '构建 "AntiGravity" Token 看板, 支持 CSV 导出',
    firstPromptPreview: "请统计本机所有会话 Token 消耗",
    workspaceUri: "file:///Users/demo/code/token",
    workspaceName: "token",
    workspacePath: "/Users/demo/code/token",
    parentConversationId: "",
    nestingDepth: 0,
    agentName: "",
    archived: false,
    status: "completed",
    createdAt: "2026-11-06T08:00:00.000Z",
    lastModifiedAt: "2026-11-06T09:50:00.000Z",
    models: ["Gemini 4 Argon (High)", "Claude Opus 5.5 (Medium)"],
    primaryModel: "Gemini 4 Argon (High)",
    callCount: 6,
    stepCount: 14,
    inputTokens: 12000,
    cacheReadTokens: 128000,
    outputTokens: 6400,
    thinkingTokens: 2400,
    responseTokens: 4000,
    totalTokens: 146400,
    cacheHitRate: 0.9143,
    peakContextUsed: 68000,
    contextLimit: 256000,
    totalLatencyMs: 9200,
    estimatedCostUsd: 0.48,
    cacheSavedUsd: 1.92,
    subagentCount: 1,
    ...overrides,
  };
}

/**
 * 职责：构造带中英文标题、子代理关系与多模型数据的内存态 Mock TelemetryProvider。
 * 参数：shouldThrow — 是否模拟底层扫描抛出异常。
 * 返回值：包含 provider 实例与最近一次查询参数记录器的测试夹具。
 */
function createMockProviderFixture(shouldThrow = false): {
  provider: TelemetryProvider;
  getLastFilters: () => TelemetryFilterOptions | undefined;
} {
  let lastFilters: TelemetryFilterOptions | undefined; // 记录最近一次传入 getSummary 的过滤条件

  // 0. 准备数据源健康状态与会话样本（含逗号、双引号与中文标题）
  const health: DataSourceHealth = {
    dataDir: "/Users/demo/.gemini/antigravity", exists: true, summaryDbAvailable: true,
    conversationDbCount: 2, transcriptCount: 2, sqliteReadMode: "wal-readonly",
    scanDurationMs: 18, scannedAt: "2026-11-06T09:55:00.000Z", warnings: [],
  };

  const conversations: ConversationUsageSummary[] = [
    makeConversation({}),
    makeConversation({
      conversationId: "conv:sub-002",
      title: "Subagent: Implement HTTP & CLI test suite",
      parentConversationId: "conv-main-001",
      nestingDepth: 1,
      agentName: "worker-cli",
      archived: true,
      models: ["Claude Opus 5.5 (Medium)"],
      primaryModel: "Claude Opus 5.5 (Medium)",
      callCount: 3,
      inputTokens: 5000,
      cacheReadTokens: 45000,
      outputTokens: 2600,
      thinkingTokens: 900,
      responseTokens: 1700,
      totalTokens: 52600,
      cacheHitRate: 0.9,
      estimatedCostUsd: 0.31,
      cacheSavedUsd: 0.85,
      subagentCount: 0,
    }),
  ];

  // 1.1. 组装完整汇总响应与单会话详情映射
  const summaryPayload: DashboardSummaryPayload = {
    health,
    totals: {
      conversationCount: 2,
      subagentCount: 1,
      callCount: 9,
      inputTokens: 17000,
      cacheReadTokens: 173000,
      outputTokens: 9000,
      thinkingTokens: 3300,
      responseTokens: 5700,
      totalTokens: 199000,
      cacheHitRate: 173000 / 190000,
      avgLatencyMs: 1478,
      avgTtftMs: 920,
      avgOutputTps: 67.6,
      avgStreamingTps: 112.5,
      estimatedCostUsd: 0.79,
      cacheSavedUsd: 2.77,
      todayTotalTokens: 199000,
      todayEstimatedCostUsd: 0.79,
    },
    callTimeline: [],
    dailyTrend: [],
    hourlyTrend: [],
    byModel: [
      {
        modelName: "Gemini 4 Argon (High)",
        modelId: "gemini-4-argon-high",
        conversationCount: 1,
        callCount: 6,
        inputTokens: 12000,
        cacheReadTokens: 128000,
        outputTokens: 6400,
        thinkingTokens: 2400,
        responseTokens: 4000,
        totalTokens: 146400,
        cacheHitRate: 0.9143,
        avgLatencyMs: 1533,
        avgOutputTps: 69.6,
        avgStreamingTps: 115.0,
        estimatedCostUsd: 0.48,
        cacheSavedUsd: 1.92,
        shareOfTotalTokens: 146400 / 199000,
      },
    ],
    byWorkspace: [
      {
        workspaceName: "token",
        workspacePath: "/Users/demo/code/token",
        conversationCount: 2,
        subagentCount: 1,
        callCount: 9,
        inputTokens: 17000,
        cacheReadTokens: 173000,
        outputTokens: 9000,
        totalTokens: 199000,
        cacheHitRate: 173000 / 190000,
        estimatedCostUsd: 0.79,
        lastActiveAt: "2026-11-06T09:54:00.000Z",
        shareOfTotalTokens: 1,
      },
    ],
    topTools: [{ toolName: "view_file", invocationCount: 4, associatedOutputTokens: 1800 }],
    conversations,
    availableWorkspaces: ["token"],
    availableModels: ["Gemini 4 Argon (High)", "Claude Opus 5.5 (Medium)"],
    defaultPricing: [],
  };

  const provider: TelemetryProvider = {
    getHealth: () => {
      if (shouldThrow) throw new Error("Simulated SQLite read failure");
      return health;
    },
    getSummary: (options) => {
      if (shouldThrow) throw new Error("Simulated summary failure");
      lastFilters = options;
      const filtered =
        options?.includeArchived === false ? conversations.filter((c) => !c.archived) : conversations;
      return { ...summaryPayload, conversations: filtered };
    },
    getConversationDetail: (id): ConversationDetail | null => {
      const target = conversations.find((c) => c.conversationId === id);
      if (!target) return null;
      return { ...target, steps: [], toolUsageCounts: { view_file: 1 } };
    },
  };

  return { provider, getLastFilters: () => lastFilters };
}

const activeServers: http.Server[] = []; // 跟踪待回收的测试 HTTP 服务实例

/**
 * 职责：在本地回环随机端口启动测试 HTTP 服务并返回基础 URL 与端口号。
 * 参数：provider — 注入的数据提供者；staticDir — 可选静态文件目录。
 * 返回值：包含 baseUrl 与 port 的连接信息。
 */
async function startServer(
  provider: TelemetryProvider,
  staticDir?: string,
): Promise<{ baseUrl: string; port: number }> {
  // 0. 创建服务器并监听 127.0.0.1 随机空闲端口
  const server = createTelemetryHttpServer(provider, { staticDir });
  activeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, port };
}

/**
 * 职责：使用原生 http.get 发送未归一化的原始请求路径（用于验证服务端路径穿越拦截）。
 * 参数：port — 目标端口；rawPath — 原始未折叠路径。
 * 返回值：HTTP 响应状态码。
 */
function requestRawStatusCode(port: number, rawPath: string): Promise<number> {
  // 0. 直接透传 path 字段避免客户端 URL 预折叠
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: rawPath }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe("HTTP Telemetry Server (server/app.ts)", () => {
  it("serves GET /api/health, OPTIONS CORS, and forwards query params on GET /api/summary", async () => {
    const { provider, getLastFilters } = createMockProviderFixture();
    const { baseUrl } = await startServer(provider);

    expect((await fetch(`${baseUrl}/api/summary`, { method: "OPTIONS" })).status).toBe(204);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await healthRes.json()) as DataSourceHealth).sqliteReadMode).toBe("wal-readonly");

    const summaryRes = await fetch(
      `${baseUrl}/api/summary?cycle=5h&days=7&workspace=token&model=all&search=%20看板%20&includeArchived=false&refresh=1`,
    );
    expect(summaryRes.status).toBe(200);
    expect(((await summaryRes.json()) as DashboardSummaryPayload).conversations).toHaveLength(1);
    expect(getLastFilters()).toEqual({
      cycle: "5h",
      days: 7,
      workspace: "token",
      model: undefined,
      search: "看板",
      includeArchived: false,
      forceRefresh: true,
    });
  });

  it("handles GET /api/conversations/:id with URL-decoded IDs and 404 on unknown ID", async () => {
    const { baseUrl } = await startServer(createMockProviderFixture().provider);

    const okRes = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent("conv:sub-002")}`);
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as ConversationDetail).conversationId).toBe("conv:sub-002");

    const missingRes = await fetch(`${baseUrl}/api/conversations/non-existent-id`);
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toEqual({ error: "Conversation not found" });
  });

  it("exports UTF-8 BOM CSV with escaped quotes/commas and attachment JSON", async () => {
    const { baseUrl } = await startServer(createMockProviderFixture().provider);

    const csvRes = await fetch(`${baseUrl}/api/export.csv`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-disposition")).toContain("antigravity-tokens.csv");
    const rawBuffer = Buffer.from(await csvRes.arrayBuffer());
    expect(Array.from(rawBuffer.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    const lines = rawBuffer.toString("utf8").slice(1).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "conversationId,title,workspaceName,primaryModel,callCount,inputTokens,cacheReadTokens,outputTokens,thinkingTokens,responseTokens,totalTokens,cacheHitRate,estimatedCostUsd,cacheSavedUsd,parentConversationId,archived,lastModifiedAt",
    );
    expect(lines[1]).toContain('"构建 ""AntiGravity"" Token 看板, 支持 CSV 导出"');

    const jsonExportRes = await fetch(`${baseUrl}/api/export.json?includeArchived=false`);
    expect(jsonExportRes.status).toBe(200);
    expect(jsonExportRes.headers.get("content-disposition")).toBe(
      'attachment; filename="antigravity-tokens.json"',
    );
    expect(((await jsonExportRes.json()) as DashboardSummaryPayload).conversations).toHaveLength(1);
  });

  it("serves static files securely, blocks path traversal, and returns 500 on runtime errors", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-static-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "index.html"), "<!doctype html><title>Radar</title>");
      fs.writeFileSync(path.join(tmpDir, "app.js"), "console.log('ok');");

      const { baseUrl, port } = await startServer(createMockProviderFixture().provider, tmpDir);
      expect((await fetch(`${baseUrl}/app.js`)).status).toBe(200);
      expect(await (await fetch(`${baseUrl}/conversations/conv-main-001`)).text()).toContain("Radar");
      expect(await requestRawStatusCode(port, "/../package.json")).toBe(403);
      expect(await requestRawStatusCode(port, "/%2e%2e/package.json")).toBe(403);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const { baseUrl: errBaseUrl } = await startServer(createMockProviderFixture(true).provider);
    const errRes = await fetch(`${errBaseUrl}/api/health`);
    expect(errRes.status).toBe(500);
    expect(await errRes.json()).toEqual({ error: "Simulated SQLite read failure" });
  });

  it("supports GET/POST/DELETE /api/calibrations backed by local store", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-http-cal-"));
    try {
      const store = createCalibrationStore(path.join(tmpDir, "calibrations.json"));
      const base = createMockProviderFixture().provider;
      const provider: TelemetryProvider = {
        ...base,
        getCalibrations: () => store.list(),
        setCalibration: (k, v) => store.set(k, v),
        deleteCalibration: (k) => store.remove(k),
      };
      const { baseUrl } = await startServer(provider);
      const key = "pool:claude:2026-11-18T01:02:39.000Z";

      expect(await (await fetch(`${baseUrl}/api/calibrations`)).json()).toEqual({ calibrations: {} });

      const postRes = await fetch(`${baseUrl}/api/calibrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          remainingPct: 40,
          calibratedCostUsd: 93.19,
          calibratedTokens: 190_800_000,
          calibratedAt: "2026-11-24T01:40:00.000Z",
        }),
      });
      expect(postRes.status).toBe(200);
      const postJson = (await postRes.json()) as { calibrations: Record<string, { remainingPct: number }> };
      expect(postJson.calibrations[key]?.remainingPct).toBe(40);

      const badRes = await fetch(`${baseUrl}/api/calibrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, remainingPct: 100, calibratedCostUsd: 1, calibratedTokens: 1 }),
      });
      expect(badRes.status).toBe(400);

      const delRes = await fetch(`${baseUrl}/api/calibrations?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ calibrations: {} });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("CLI Parser & Renderer (server/cliRender.ts)", () => {
  it("parses short/long CLI flags and renders an aligned terminal report", () => {
    expect(parseCliArgs([])).toEqual({ json: false, limit: 10, help: false });
    expect(
      parseCliArgs(["-d", "14", "-w", "token", "-m", "Argon", "-n", "1", "--data-dir", "/tmp/ag", "--json"]),
    ).toEqual({
      days: 14,
      workspace: "token",
      model: "Argon",
      limit: 1,
      dataDir: "/tmp/ag",
      json: true,
      help: false,
    });
    expect(parseCliArgs(["--help"]).help).toBe(true);

    const report = renderCliReport(createMockProviderFixture().provider.getSummary(), 1);
    expect(report).toContain("/Users/demo/.gemini/antigravity");
    expect(report).toContain("wal-readonly");
    expect(report).toContain("2 conversations (1 subagents)");
    expect(report).toContain("199,000");
    expect(report).toContain("91.1%");
    expect(report).toContain("Gemini 4 Argon (High)");
    expect(report).toContain("[Top Conversations (1/2)]");
    expect(report).not.toContain("Implement HTTP & CLI test suite");
  });
});
