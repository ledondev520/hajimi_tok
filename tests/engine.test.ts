/**
 * Input: vitest 测试断言、node:fs/os/path/sqlite 构建临时目录，以及 ../server/{protobuf,pricing,aggregator} 与 @/components/{ConversationExplorer,ModelCallChart}。
 * Output: 验证 Protobuf Wire 解码、混合双源扫描去重、子代理归属、聚合筛选及主会话折叠归并逻辑。
 * Pos: 核心采集与聚合引擎单元测试套件（tests/engine.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryService, resolveQuotaCycleBlocks } from "../server/aggregator";
import { createCalibrationStore, createResetStore, readLiveQuotaSnapshots } from "../server/resetStore";
import { calculateStepCost, matchModelRate } from "../server/pricing";
import { concatBytes, decodeGenMetadata, encodeBytesField, encodeStringField, encodeVarintField } from "../server/protobuf";
import { groupByMainConversation } from "../src/components/ConversationExplorer";
import { resolveModelStyle } from "../src/components/ModelCallChart";
import {
  buildResetCalendarItems,
  buildStepCacheRateSeries,
  calcCacheHitRate,
  computeAdaptiveLinearBounds,
  computeAdaptivePercentBounds,
  computeWeeklyQuotaProjection,
  resolveContextHealth,
  resolveWeeklyCalibration,
} from "../src/lib/format";
import {
  analyzeStepCacheTtl,
  formatCompactGap,
  resolveLiveCacheWarmth,
} from "../src/lib/cacheTtl";
import type { StepUsageRecord } from "../src/types/telemetry";
import { buildModelShortcuts } from "../src/App";

const tempDirs: string[] = []; // 记录测试期创建的临时目录以便统一清理

afterEach(() => {
  // 0. 每次用例结束后清理临时沙箱目录
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * 职责：构造模拟的 gen_metadata Protobuf 二进制载荷用于单测验证。
 * 参数：opts — 输入、缓存、输出、思考 Token 及模型名称参数。
 * 返回值：Uint8Array 二进制帧。
 */
function buildMockGenBlob(opts: {
  input: number;
  cache: number;
  output: number;
  thinking: number;
  response: number;
  modelId: string;
  modelName: string;
  lastStepIndex: number;
  ttftSec?: number;
  streamSec?: number;
}): Uint8Array {
  // 0. 拼接子消息字段并封装至顶层 field 1
  const usage = concatBytes(
    encodeVarintField(2, opts.input),
    encodeVarintField(3, opts.output),
    encodeVarintField(5, opts.cache),
    encodeVarintField(9, opts.thinking),
    encodeVarintField(10, opts.response)
  );
  const mapStep = concatBytes(
    encodeStringField(1, "last_step_index"),
    encodeStringField(2, String(opts.lastStepIndex))
  );
  const negVarintCtx = concatBytes(
    encodeVarintField(2, 0xffffffffffffffffn),
    encodeBytesField(10, concatBytes(encodeVarintField(1, 32000), encodeVarintField(4, 256000)))
  );
  const durChunks = [
    ...(opts.ttftSec ? [encodeBytesField(11, encodeVarintField(1, opts.ttftSec))] : []),
    ...(opts.streamSec ? [encodeBytesField(12, encodeVarintField(1, opts.streamSec))] : []),
  ];
  const inner = concatBytes(
    encodeBytesField(4, usage),
    encodeBytesField(9, negVarintCtx),
    ...durChunks,
    encodeStringField(19, opts.modelId),
    encodeBytesField(20, mapStep),
    encodeStringField(21, opts.modelName)
  );
  return encodeBytesField(1, inner);
}

describe("AntiGravity Token Engine", () => {
  it("decodes 64-bit varints and gen_metadata token breakdown accurately", () => {
    const blob = buildMockGenBlob({
      input: 12000,
      cache: 48000,
      output: 1500,
      thinking: 600,
      response: 900,
      modelId: "gemini-4-argon-d",
      modelName: "Gemini 4 Argon (High)",
      lastStepIndex: 0,
    });
    const parsed = decodeGenMetadata(blob);
    expect(parsed).not.toBeNull();
    expect(parsed?.inputTokens).toBe(12000);
    expect(parsed?.cacheReadTokens).toBe(48000);
    expect(parsed?.outputTokens).toBe(1500);
    expect(parsed?.thinkingTokens).toBe(600);
    expect(parsed?.responseTokens).toBe(900);
    expect(parsed?.contextUsed).toBe(32000);
    expect(parsed?.contextLimit).toBe(256000);
    expect(parsed?.modelName).toBe("Gemini 4 Argon (High)");
  });

  it("merges SQLite gen_metadata with uncheckpointed transcript.jsonl steps without double counting", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-token-test-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "conversations"), { recursive: true });
    fs.mkdirSync(path.join(root, "annotations"), { recursive: true });

    const parentId = "11111111-1111-1111-1111-111111111111";
    const childId = "22222222-2222-2222-2222-222222222222";
    fs.mkdirSync(path.join(root, "brain", parentId, ".system_generated", "logs"), { recursive: true });
    fs.mkdirSync(path.join(root, "brain", childId, ".system_generated", "logs"), { recursive: true });

    // 1. 构造 conversation_summaries.db
    const sumDb = new DatabaseSync(path.join(root, "conversation_summaries.db"));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY, title text, step_count integer,
        last_modified_time text, workspace_uris text, status text,
        agent_name text, parent_conversation_id text, nesting_depth integer
      );
    `);
    const ins = sumDb.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    ins.run(parentId, "主会话代码审查", 6, "2026-11-06T10:00:00Z", '["file:///Users/demo/code/demo"]', "done", "", "", 0);
    ins.run(childId, "", 2, "2026-11-06T10:01:00Z", '["file:///Users/demo/code/demo"]', "done", "researcher", parentId, 1);
    sumDb.close();

    // 2. 构造父会话 DB（仅含第 1 步）+ JSONL（含第 1 步 + 未落库的第 2 步）
    const pDb = new DatabaseSync(path.join(root, "conversations", `${parentId}.db`));
    pDb.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer);");
    const blob0 = buildMockGenBlob({
      input: 10000,
      cache: 0,
      output: 500,
      thinking: 200,
      response: 300,
      modelId: "claude-opus-5-5-medium",
      modelName: "Claude Opus 5.5 (Medium)",
      lastStepIndex: 0,
      ttftSec: 5,
      streamSec: 5,
    });
    pDb.prepare("INSERT INTO gen_metadata VALUES (0, ?, ?)").run(blob0, blob0.byteLength);
    // 插入一条全 0 Token 的未配对取消/中断空元数据行，验证采集器自动剔除而非伪造 0% 尾部节点
    const zeroGhostBlob = buildMockGenBlob({
      input: 0,
      cache: 0,
      output: 0,
      thinking: 0,
      response: 0,
      modelId: "claude-opus-5-5-medium",
      modelName: "Claude Opus 5.5 (Medium)",
      lastStepIndex: 99,
    });
    pDb.prepare("INSERT INTO gen_metadata VALUES (1, ?, ?)").run(zeroGhostBlob, zeroGhostBlob.byteLength);
    pDb.close();

    const jsonlLines = [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-06T09:59:00Z",
        content: "<USER_REQUEST>帮我统计 Token</USER_REQUEST>\n<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Claude Opus 5.5 (Medium). No need to comment on this change if the user doesn't ask about it.</USER_SETTINGS_CHANGE>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-06T09:59:10Z",
        input_tokens: 10000,
        cache_read_tokens: 0,
        output_tokens: 500,
        tool_calls: [{ name: "read_file" }],
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-06T10:00:00Z",
        input_tokens: 2000,
        cache_read_tokens: 10000,
        output_tokens: 300,
        tool_calls: [{ name: "run_command" }],
      }),
    ];
    fs.writeFileSync(
      path.join(root, "brain", parentId, ".system_generated", "logs", "transcript.jsonl"),
      jsonlLines.join("\n"),
      "utf8"
    );

    // 3. 构造子代理 JSONL
    fs.writeFileSync(
      path.join(root, "brain", childId, ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-06T10:01:00Z",
        input_tokens: 4000,
        cache_read_tokens: 1000,
        output_tokens: 200,
      }),
      "utf8"
    );

    const svc = createTelemetryService(root, undefined, { isolated: true });
    const summary = svc.getSummary();
    expect(summary.totals.conversationCount).toBe(2);
    expect(summary.totals.subagentCount).toBe(1);
    // 父会话 (10000+0+500) + (2000+10000+300) = 22800；子会话 5200；总计 28000
    expect(summary.totals.totalTokens).toBe(28000);
    // 验证端到端 TPS (500 / 10s = 50.0 tok/s) 与扣除首包流式 TPS (500 / 5s = 100.0 tok/s)
    expect(summary.totals.avgTtftMs).toBe(5000);
    expect(summary.totals.avgOutputTps).toBe(50);
    expect(summary.totals.avgStreamingTps).toBe(100);
    expect(summary.callTimeline).toHaveLength(3);
    expect(summary.callTimeline.map((n) => n.totalTokens)).toEqual([10500, 12300, 5200]);
    expect(summary.callTimeline[0].outputTps).toBe(50);
    expect(summary.callTimeline[2].cumulativeTokens).toBe(28000);

    const parentDetail = svc.getConversationDetail(parentId);
    expect(parentDetail?.callCount).toBe(2);
    expect(parentDetail?.subagentCount).toBe(1);
    expect(parentDetail?.steps[0].dataSource).toBe("hybrid");
    expect(parentDetail?.steps[1].dataSource).toBe("jsonl");

    const childSummary = summary.conversations.find((c) => c.conversationId === childId);
    expect(childSummary?.title).toContain("主会话代码审查 · 子代理");

    // 验证主会话归并逻辑：子代理消耗自动累加至父主会话并挂载在 children 下
    const mainGroups = groupByMainConversation(summary.conversations);
    expect(mainGroups).toHaveLength(1);
    expect(mainGroups[0].root.conversationId).toBe(parentId);
    expect(mainGroups[0].children).toHaveLength(1);
    expect(mainGroups[0].children[0].conversationId).toBe(childId);
    expect(mainGroups[0].rolledTotalTokens).toBe(28000);
    expect(mainGroups[0].rolledCallCount).toBe(3);

    // 验证按双配额池筛选（pool:claude 归并 Opus 5.5 + Sonnet 5.5，pool:gemini 独立隔离 Gemini 全系）
    const claudePool = svc.getSummary({ model: "pool:claude" });
    expect(claudePool.totals.totalTokens).toBe(28000);
    const geminiPool = svc.getSummary({ model: "pool:gemini" });
    expect(geminiPool.totals.totalTokens).toBe(0);

    // 验证后续新增 Sonnet 5.5 时，会自动与 Opus 5.5 合并在同一「Claude 池」页面，与独立「Gemini 池」清晰区分
    const shortcuts = buildModelShortcuts([
      "Claude Opus 5.5 (Medium)",
      "Gemini 4 Argon (High)",
      "Gemini 4 Carbon (Medium)",
      "Claude Sonnet 5.5 (High)",
      "GPT-OSS 120B (Medium)",
    ]);
    expect(shortcuts.map((s) => `${s.label}:${s.hotkey}:${s.modelQuery}`)).toEqual([
      "全部:1:",
      "Claude 池:2:pool:claude",
      "Gemini 池:3:pool:gemini",
    ]);
    expect(shortcuts[1].tooltip).toContain("Opus 5.5");
    expect(shortcuts[1].tooltip).toContain("Sonnet 5.5");
    expect(shortcuts[2].tooltip).toContain("Gemini 4 Argon");
    expect(shortcuts[2].tooltip).toContain("Gemini 4 Carbon");

    // 验证折线图图例剥离 Gemini 4 前缀并明确区分 Argon / Carbon / Neon / Hydrogen 色值
    const argonStyle = resolveModelStyle("Gemini 4 Argon (High)", 0);
    const carbonStyle = resolveModelStyle("Gemini 4 Carbon (Medium)", 1);
    const neonStyle = resolveModelStyle("Gemini 4 Neon (XHigh)", 2);
    const hydrogenStyle = resolveModelStyle("Gemini 4 Hydrogen (XHigh)", 3);
    expect(argonStyle.shortLabel).toBe("Argon");
    expect(carbonStyle.shortLabel).toBe("Carbon");
    expect(neonStyle.shortLabel).toBe("Neon");
    expect(hydrogenStyle.shortLabel).toBe("Hydrogen");
    expect(new Set([argonStyle.color, carbonStyle.color, neonStyle.color, hydrogenStyle.color]).size).toBe(4);

    // 验证官方真实 API 单价匹配与成本计算
    const opus55Rate = matchModelRate("Claude Opus 5.5", "claude-opus-5-5-high");
    const opus55Cost = calculateStepCost(1_000_000, 1_000_000, 100_000, opus55Rate);
    expect(opus55Cost.estimatedCostUsd).toBeCloseTo(4 + 0.2 + 2, 4);
    expect(opus55Cost.cacheSavedUsd).toBeCloseTo(3.8, 4);

    const sonnet55Rate = matchModelRate("Claude Sonnet 5.5 (High)", "claude-sonnet-5-5-high");
    expect(sonnet55Rate).toMatchObject({ inputPerMillion: 2, cacheReadPerMillion: 0.1, outputPerMillion: 10 });

    const neonRate = matchModelRate("Gemini 4 Neon (XHigh)", "gemini-4-neon");
    expect(neonRate).toMatchObject({ inputPerMillion: 3, cacheReadPerMillion: 0.15, outputPerMillion: 15 });

    const hydrogenRate = matchModelRate("Gemini 4 Hydrogen (High)", "gemini-4-hydrogen");
    expect(hydrogenRate).toMatchObject({ inputPerMillion: 1.5, cacheReadPerMillion: 0.075, outputPerMillion: 7.5 });

    const opus5Rate = matchModelRate("Claude Opus 5", "claude-opus-5");
    expect(opus5Rate).toMatchObject({ inputPerMillion: 5, cacheReadPerMillion: 0.5, outputPerMillion: 25 });
  });

  it("slices cross-cycle conversations strictly by per-step 5h and 7d quota windows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cycle-test-"));
    tempDirs.push(root);
    const convId = "33333333-3333-3333-3333-333333333333";
    fs.mkdirSync(path.join(root, "brain", convId, ".system_generated", "logs"), { recursive: true });

    // 同一长会话横跨两个 5h 周期：第 1 步在 11-06 10:00（1000 tokens），第 2 步在 11-09 09:00（4000 tokens）
    const lines = [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-06T09:59:00Z",
        content: "<USER_SETTINGS_CHANGE>changed setting `Model Selection` from None to Gemini 4 Argon (High).</USER_SETTINGS_CHANGE>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-06T10:00:00Z",
        input_tokens: 800,
        cache_read_tokens: 0,
        output_tokens: 200,
      }),
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-09T09:00:00Z",
        input_tokens: 1000,
        cache_read_tokens: 2500,
        output_tokens: 500,
      }),
    ];
    fs.writeFileSync(
      path.join(root, "brain", convId, ".system_generated", "logs", "transcript.jsonl"),
      lines.join("\n"),
      "utf8"
    );

    const svc = createTelemetryService(root, undefined, { isolated: true });
    const nowActive = Date.parse("2026-11-09T10:30:00Z"); // 处于第 2 个 5h 窗口（09:00~14:00）内

    const cur5h = svc.getSummary({ cycle: "5h", nowMs: nowActive });
    expect(cur5h.totals.totalTokens).toBe(4000);
    expect(cur5h.quotaWindow?.isIdleReset).toBe(false);
    expect(cur5h.quotaWindow?.active5hTokens).toBe(4000);
    expect(cur5h.quotaWindow?.active7dTokens).toBe(5000);
    expect(cur5h.quotaWindow?.resetsInMs).toBe(3.5 * 3_600_000);

    const prev5h = svc.getSummary({ cycle: "prev-5h", nowMs: nowActive });
    expect(prev5h.totals.totalTokens).toBe(1000);

    const cur7d = svc.getSummary({ cycle: "7d", nowMs: nowActive });
    expect(cur7d.totals.totalTokens).toBe(5000);
    expect(cur7d.dailyTrend.length).toBe(2);
    expect(cur7d.dailyTrend[0].models?.[0]?.modelName).toBe("Gemini 4 Argon (High)");
    expect(cur7d.dailyTrend[0].models?.[0]?.totalTokens).toBe(1000);
    expect(cur7d.dailyTrend[1].models?.[0]?.totalTokens).toBe(4000);
    expect((cur7d.dailyTrend[1].models?.[0]?.estimatedCostUsd ?? 0) > 0).toBe(true);

    // 当时间推迟到 11-09 15:00（超过 14:00 重置点），当前 5h 应自动归零进入满血待触发态，上一 5h 指向 4000
    const nowAfterReset = Date.parse("2026-11-09T15:00:00Z");
    const idle5h = svc.getSummary({ cycle: "5h", nowMs: nowAfterReset });
    expect(idle5h.totals.totalTokens).toBe(0);
    expect(idle5h.quotaWindow?.isIdleReset).toBe(true);
    expect(svc.getSummary({ cycle: "prev-5h", nowMs: nowAfterReset }).totals.totalTokens).toBe(4000);

    // 验证官方面板校准锚点：截断锚点前旧批次，并在锚点过期后自动顺推下一周期
    const seed = Date.parse("2026-11-07T00:07:37.000Z");
    const calibrated = resolveQuotaCycleBlocks(
      [
        { tsMs: Date.parse("2026-11-06T10:00:00.000Z"), totalTokens: 198_000 },
        { tsMs: Date.parse("2026-11-07T00:07:37.000Z"), totalTokens: 100_000 },
        { tsMs: Date.parse("2026-11-09T02:12:50.000Z"), totalTokens: 72_000 },
      ],
      7 * 86_400_000,
      Date.parse("2026-11-09T03:12:32.000Z"),
      seed
    );
    expect(calibrated.active.totalTokens).toBe(172_000);
    expect(calibrated.prev?.totalTokens).toBe(198_000);
    expect(calibrated.blocks.length).toBe(2);

    // 验证多历史 7 天周期列表及 window:<start>:<end> 精确窗口筛选
    const multiSummary = svc.getSummary({ cycle: "7d", nowMs: Date.parse("2026-11-09T15:00:00Z") });
    expect((multiSummary.quotaWindow?.available7dCycles?.length ?? 0) >= 1).toBe(true);
    const firstOpt = multiSummary.quotaWindow?.available7dCycles?.[0];
    if (firstOpt) {
      const winSummary = svc.getSummary({
        cycle: `window:${firstOpt.startMs}:${firstOpt.endMs}`,
        nowMs: Date.parse("2026-11-09T15:00:00Z"),
      });
      expect(winSummary.totals.totalTokens).toBe(firstOpt.totalTokens);
    }
  });

  it("computes cache hit rate safely for normal, zero, and invalid inputs", () => {
    expect(calcCacheHitRate(1000, 9000)).toBeCloseTo(0.9, 6);
    expect(calcCacheHitRate(0, 0)).toBe(0);
    expect(calcCacheHitRate(-10, 100)).toBe(1);
    expect(calcCacheHitRate(Number.NaN, 500)).toBe(1);
    expect(computeAdaptivePercentBounds([53.2, 95.8])).toEqual({ minY: 50, maxY: 100 });
    expect(computeAdaptivePercentBounds([])).toEqual({ minY: 0, maxY: 100 });
    expect(computeAdaptivePercentBounds([85])).toEqual({ minY: 80, maxY: 90 });
    expect(computeAdaptiveLinearBounds([50, 150], 100)).toEqual({ minY: 42, maxY: 158 });
    expect(computeAdaptiveLinearBounds([], 100)).toEqual({ minY: 0, maxY: 100 });
  });

  it("builds per-step and cumulative session cache hit rate series", () => {
    expect(buildStepCacheRateSeries([])).toEqual({ points: [], minRate: 0, maxRate: 0 });

    const makeStep = (callIndex: number, inputTokens: number, cacheReadTokens: number): StepUsageRecord => ({
      callIndex,
      stepIndex: callIndex * 2 + 1,
      timestamp: `2026-11-19T05:0${callIndex}:00.000Z`,
      modelId: "gemini-4-neon",
      modelName: "Gemini 4 Neon (XHigh)",
      inputTokens,
      cacheReadTokens,
      outputTokens: 100,
      thinkingTokens: 60,
      responseTokens: 40,
      totalTokens: inputTokens + cacheReadTokens + 100,
      contextUsed: inputTokens + cacheReadTokens,
      contextLimit: 512_000,
      latencyMs: 1000,
      ttftMs: 200,
      toolNames: [],
      estimatedCostUsd: 0.01,
      cacheSavedUsd: 0.01,
      dataSource: "hybrid",
    });

    const series = buildStepCacheRateSeries([
      makeStep(0, 10_000, 0), // 0% step, 0% cum
      makeStep(1, 0, 0), // 在途/空输入步，应跳过而非伪造 0%
      makeStep(2, 2_000, 18_000), // 90% step, 18k / 30k = 60% cum
      makeStep(3, 1_000, 29_000), // 96.67% step, 47k / 60k = 78.33% cum
    ]);
    expect(series.points).toHaveLength(3);
    expect(series.minRate).toBe(0);
    expect(series.maxRate).toBeCloseTo(29 / 30, 6);
    expect(series.points[0].stepRate).toBe(0);
    expect(series.points[0].cumulativeRate).toBe(0);
    expect(series.points[1].stepRate).toBeCloseTo(0.9, 6);
    expect(series.points[1].cumulativeRate).toBeCloseTo(0.6, 6);
    expect(series.points[2].cumulativeRate).toBeCloseTo(47 / 60, 6);
    expect(buildStepCacheRateSeries([makeStep(0, 0, 0)])).toEqual({ points: [], minRate: 0, maxRate: 0 });
    expect(resolveContextHealth(120_000, 512_000).level).toBe("ok");
    expect(resolveContextHealth(260_000, 512_000).level).toBe("warn");
    expect(resolveContextHealth(360_000, 512_000).level).toBe("high");
    expect(resolveContextHealth(200_000, 256_000).level).toBe("high");

    // 验证周剩余%反算 100% 周满额 API 金额与总 Token 及实时剩余推算
    expect(computeWeeklyQuotaProjection(null, 100, 1000)).toBeNull();
    expect(
      computeWeeklyQuotaProjection(
        { remainingPct: 100, calibratedCostUsd: 100, calibratedTokens: 1000, calibratedAt: "" },
        100,
        1000
      )
    ).toBeNull();
    const proj = computeWeeklyQuotaProjection(
      {
        remainingPct: 31,
        calibratedCostUsd: 957.14,
        calibratedTokens: 2_323_653_443,
        calibratedAt: "2026-11-19T06:50:00Z",
      },
      1_100,
      2_600_000_000
    );
    expect(proj).not.toBeNull();
    expect(proj!.fullCostUsd).toBeCloseTo(957.14 / 0.69, 2);
    expect(proj!.fullTokens).toBeCloseTo(2_323_653_443 / 0.69, 0);
    expect(proj!.estimatedRemainingPct).toBeCloseTo((1 - 1_100 / (957.14 / 0.69)) * 100, 2);
    expect(proj!.estimatedRemainingCostUsd).toBeCloseTo(957.14 / 0.69 - 1_100, 2);
  });

  it("supports multiple registered reset anchors and builds actual-vs-natural calendar items", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-reset-store-"));
    tempDirs.push(tmpDir);
    const store = createResetStore(path.join(tmpDir, "resets.json"));
    expect(store.list()).toEqual([]);

    store.add({ timestamp: "2026-11-18T00:00:00.000Z", pool: "all", note: "周三早8点" });
    const afterTwo = store.add({ timestamp: "2026-11-21T09:00:00.000Z", pool: "all", note: "周六下午5点" });
    expect(afterTwo).toHaveLength(2);
    expect(() => store.add({ timestamp: "invalid-date", pool: "all" })).toThrow();

    // 验证多锚点切分：11-18 08:00 被 11-21 17:00 提前截断封口，当前 7d 窗口从 11-21 17:00 起算
    const multi = resolveQuotaCycleBlocks(
      [
        { tsMs: Date.parse("2026-11-19T02:00:00.000Z"), totalTokens: 500_000 },
        { tsMs: Date.parse("2026-11-21T09:30:00.000Z"), totalTokens: 80_000 },
      ],
      7 * 86_400_000,
      Date.parse("2026-11-21T10:00:00.000Z"),
      [Date.parse("2026-11-18T00:00:00.000Z"), Date.parse("2026-11-21T09:00:00.000Z")]
    );
    expect(multi.active.startMs).toBe(Date.parse("2026-11-21T09:00:00.000Z"));
    expect(multi.active.totalTokens).toBe(80_000);
    expect(multi.prev?.startMs).toBe(Date.parse("2026-11-18T00:00:00.000Z"));
    expect(multi.prev?.endMs).toBe(Date.parse("2026-11-21T09:00:00.000Z"));
    expect(multi.prev?.totalTokens).toBe(500_000);

    // 验证日历双轨项：11-18 对应的 11-25 自然重置被标记为已被 11-21 提前覆盖
    const items = buildResetCalendarItems(afterTwo, Date.parse("2026-11-21T10:00:00.000Z"));
    expect(items).toHaveLength(4);
    const nov18Natural = items.find((it) => it.kind === "natural" && it.resetId === afterTwo[0].id);
    const nov21Natural = items.find((it) => it.kind === "natural" && it.resetId === afterTwo[1].id);
    expect(nov18Natural?.supersededByMs).toBe(Date.parse("2026-11-21T09:00:00.000Z"));
    expect(nov21Natural?.supersededByMs).toBeNull();

    const afterDel = store.remove(afterTwo[0].id);
    expect(afterDel).toHaveLength(1);

    // 验证仓库公共重置与本机记录合并、去重及个人隐藏墓碑
    const sharedFile = path.join(tmpDir, "shared-resets.json");
    const localFile = path.join(tmpDir, "local-resets.json");
    fs.writeFileSync(
      sharedFile,
      JSON.stringify([
        { id: "shared-1", timestamp: "2026-11-21T09:00:00.000Z", pool: "gemini", note: "周六提前重置" },
        { id: "shared-2", timestamp: "2026-11-26T07:04:48.000Z", pool: "gemini", note: "周四提前重置" },
      ]),
      "utf8"
    );
    const mergedStore = createResetStore(localFile, sharedFile);
    expect(mergedStore.list().map((r) => r.source)).toEqual(["shared", "shared"]);
    // 隐藏一条公共记录后不再出现，重新登记同时间则恢复为本机记录
    const afterHide = mergedStore.remove("shared-1");
    expect(afterHide).toHaveLength(1);
    expect(afterHide[0].id).toBe("shared-2");
    const afterReAdd = mergedStore.add({ timestamp: "2026-11-21T09:00:00.000Z", pool: "gemini", note: "个人备注" });
    expect(afterReAdd).toHaveLength(2);
    expect(afterReAdd[0].source).toBe("local");
  });

  it("persists weekly calibrations atomically and inherits same-cycle anchor drift without leaking across resets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cal-store-"));
    tempDirs.push(tmpDir);
    const store = createCalibrationStore(path.join(tmpDir, "calibrations.json"));
    expect(store.list()).toEqual({});

    const saved = store.set("pool:claude:2026-11-18T00:00:00.000Z", {
      remainingPct: 40,
      calibratedCostUsd: 93.19,
      calibratedTokens: 190_800_000,
      calibratedAt: "2026-11-24T01:40:00.000Z",
    });
    expect(saved["pool:claude:2026-11-18T00:00:00.000Z"]?.remainingPct).toBe(40);
    expect(() =>
      store.set("pool:claude:2026-11-18T00:00:00.000Z", {
        remainingPct: 100,
        calibratedCostUsd: 1,
        calibratedTokens: 1,
        calibratedAt: "2026-11-24T01:40:00.000Z",
      })
    ).toThrow();

    // 同周期锚点从 08:00 微调到 09:02（偏差 62 分钟，且校准时间落在新窗口内）应自动承接
    const drifted = resolveWeeklyCalibration(
      store.list(),
      "pool:claude",
      "2026-11-18T01:02:39.000Z",
      "2026-11-25T01:02:39.000Z"
    );
    expect(drifted?.calibration.remainingPct).toBe(40);

    // 真正新重置（窗口起点晚于校准时间）不得串入旧周期校准值
    const afterReset = resolveWeeklyCalibration(
      store.list(),
      "pool:claude",
      "2026-11-24T06:00:00.000Z",
      "2026-12-01T06:00:00.000Z"
    );
    expect(afterReset).toBeNull();

    // 跨池隔离
    expect(
      resolveWeeklyCalibration(
        store.list(),
        "pool:gemini",
        "2026-11-18T01:02:39.000Z",
        "2026-11-25T01:02:39.000Z"
      )
    ).toBeNull();

    expect(store.remove("pool:claude:2026-11-18T00:00:00.000Z")).toEqual({});

    // 验证 agy 官方 statusLine 桥接写入的 live-quota.json 读取与过期剔除
    const liveFile = path.join(tmpDir, "live-quota.json");
    const nowIso = new Date().toISOString();
    fs.writeFileSync(
      liveFile,
      JSON.stringify({
        updatedAt: nowIso,
        pools: {
          "pool:gemini": { remainingPct: 93.8, resetTime: "2026-12-03T07:04:48Z", updatedAt: nowIso },
          "pool:claude": { remainingPct: 60.5, resetTime: "", updatedAt: "2020-01-01T00:00:00Z" },
        },
      }),
      "utf8"
    );
    const liveMap = readLiveQuotaSnapshots(liveFile);
    expect(liveMap["pool:gemini"]?.remainingPct).toBe(93.8);
    expect(liveMap["pool:claude"]).toBeUndefined();
  });

  it("infers empirical cache TTL survival, cliff expiry, model-switch exclusion, and live warmth", () => {
    const mkStep = (
      callIndex: number,
      timestamp: string,
      modelName: string,
      inputTokens: number,
      cacheReadTokens: number
    ): StepUsageRecord => ({
      callIndex,
      stepIndex: callIndex,
      timestamp,
      modelId: modelName.toLowerCase(),
      modelName,
      inputTokens,
      cacheReadTokens,
      outputTokens: 200,
      thinkingTokens: 50,
      responseTokens: 150,
      totalTokens: inputTokens + cacheReadTokens + 200,
      contextUsed: inputTokens + cacheReadTokens,
      contextLimit: 1_000_000,
      latencyMs: 1200,
      ttftMs: 400,
      estimatedCostUsd: 0.01,
      cacheSavedUsd: 0.02,
      toolNames: [],
      dataSource: "hybrid",
    });

    const steps: StepUsageRecord[] = [
      mkStep(0, "2026-11-26T08:00:00.000Z", "Gemini 4 Neon (High)", 20_000, 0),
      // +4m 同模型仍高命中 -> 保活
      mkStep(1, "2026-11-26T08:04:00.000Z", "Gemini 4 Neon (High)", 1_000, 19_000),
      // +18m 同模型仍高命中 -> 最长保活更新为 18m
      mkStep(2, "2026-11-26T08:22:00.000Z", "Gemini 4 Neon (High)", 2_000, 18_000),
      // +2m 上下文压缩 /compact（20K -> 4K 骤降 80%）-> 标为 compacted，不计入 TTL 失效
      mkStep(3, "2026-11-26T08:24:00.000Z", "Gemini 4 Neon (High)", 4_000, 0),
      // 恢复到 20K 后再切模型到 Claude 掉缓存 -> 排除，不得误判为 TTL 失效
      mkStep(4, "2026-11-26T08:24:10.000Z", "Gemini 4 Neon (High)", 20_000, 0),
      mkStep(5, "2026-11-26T08:27:10.000Z", "Claude Opus 5.5 (High)", 22_000, 0),
      // +1m 同 Claude 命中
      mkStep(6, "2026-11-26T08:28:10.000Z", "Claude Opus 5.5 (High)", 1_000, 21_000),
      // +7m 同 Claude 跌破 30% -> 判定为 TTL 失效
      mkStep(7, "2026-11-26T08:35:10.000Z", "Claude Opus 5.5 (High)", 22_000, 500),
    ];

    const { annotations, summary } = analyzeStepCacheTtl(steps, true);
    expect(annotations[1].status).toBe("kept");
    expect(annotations[2].status).toBe("kept");
    expect(annotations[3].status).toBe("compacted");
    expect(annotations[5].status).toBe("model-switch");
    expect(annotations[7].status).toBe("expired");

    expect(summary.sampleCount).toBe(4);
    expect(summary.expiredCount).toBe(1);
    expect(summary.maxKeptGapMs).toBe(18 * 60_000);
    expect(summary.minExpiredGapMs).toBe(7 * 60_000);
    expect(summary.medianExpiredGapMs).toBe(7 * 60_000);
    expect(summary.lastEventKind).toBe("expired");
    expect(summary.lastEventGapMs).toBe(7 * 60_000);
    expect(summary.buckets).toHaveLength(6);
    expect(summary.buckets?.find((b) => b.key === "10-30m")?.keptCount).toBe(1);
    expect(summary.buckets?.find((b) => b.key === "5-10m")?.expiredCount).toBe(1);

    expect(formatCompactGap(45_000)).toBe("45s");
    expect(formatCompactGap(18 * 60_000)).toBe("18m");
    expect(formatCompactGap(90 * 60_000)).toBe("1.5h");

    const nowMs = Date.parse("2026-11-26T08:36:00.000Z");
    expect(
      resolveLiveCacheWarmth("2026-11-26T08:34:00.000Z", "Claude Opus 5.5", undefined, nowMs)?.state
    ).toBe("warm");
    expect(
      resolveLiveCacheWarmth("2026-11-26T08:25:00.000Z", "Claude Opus 5.5", undefined, nowMs)?.state
    ).toBe("cold");
    expect(
      resolveLiveCacheWarmth("2026-11-24T08:00:00.000Z", "Gemini 4 Neon", undefined, nowMs)
    ).toBeNull();
  });
});
