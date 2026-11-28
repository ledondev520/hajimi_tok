/**
 * Input: vitest 断言工具、node:fs/os/path/sqlite/child_process，以及 scanner、aggregator、resetStore、update 与 statusline-bridge 模块。
 * Output: 覆盖独立 CR 发现的全部 P1/P2 边界回归测试（源目录零写入+活跃 WAL、双源步号冲突与真零值、读取失败可重试、跨池 7d 一致性、损坏文件防覆盖、自更新脏树与断点续建、桥接安全与并发合并、子代理节点与未过滤 TTL）。
 * Pos: 关键正确性与安全合同回归测试套件（tests/regressions.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryService } from "../server/aggregator";
import { concatBytes, encodeBytesField, encodeStringField, encodeVarintField } from "../server/protobuf";
import { createCalibrationStore, createResetStore } from "../server/resetStore";
import { createTelemetryScanner, openSqliteSafe } from "../server/scanner";

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function buildBlob(opts: {
  input: number;
  cache: number;
  output: number;
  modelId: string;
  modelName: string;
  lastStepIndex?: number;
}): Uint8Array {
  const usage = concatBytes(
    encodeVarintField(2, opts.input),
    encodeVarintField(3, opts.output),
    encodeVarintField(5, opts.cache),
    encodeVarintField(9, 0),
    encodeVarintField(10, opts.output)
  );
  const parts: Uint8Array[] = [encodeBytesField(4, usage), encodeStringField(19, opts.modelId)];
  if (opts.lastStepIndex !== undefined) {
    parts.push(
      encodeBytesField(
        20,
        concatBytes(encodeStringField(1, "last_step_index"), encodeStringField(2, String(opts.lastStepIndex)))
      )
    );
  }
  parts.push(encodeStringField(21, opts.modelName));
  return encodeBytesField(1, concatBytes(...parts));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("Independent CR P1 & P2 Regressions", () => {
  it("P1-1: reads WAL-mode SQLite without creating sidecar files in source dir and sees active WAL rows", () => {
    const dir = mkTmp("hamiji-p1-wal-");
    const dbPath = path.join(dir, "fixture.db");

    // 1. WAL 模式库无旁文件时扫描，源目录严禁新增 -wal / -shm
    const w = new DatabaseSync(dbPath);
    w.exec("PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);");
    const b0 = buildBlob({ input: 100, cache: 0, output: 10, modelId: "gemini-4", modelName: "Gemini 4", lastStepIndex: 0 });
    w.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(b0);
    w.close();
    expect(fs.readdirSync(dir).sort()).toEqual(["fixture.db"]);

    const opened = openSqliteSafe(dbPath);
    try {
      const rows = opened.db.prepare("SELECT idx FROM gen_metadata").all() as Array<{ idx: number }>;
      expect(rows).toHaveLength(1);
    } finally {
      opened.db.close();
      opened.cleanup();
    }
    expect(fs.readdirSync(dir).sort()).toEqual(["fixture.db"]);

    // 2. 保持写连接开启以生成未 checkpoint 的活跃 -wal，确认快照副本能读到新提交行且不改源目录文件集合
    const liveWriter = new DatabaseSync(dbPath);
    liveWriter.exec("PRAGMA wal_autocheckpoint = 0;");
    const b1 = buildBlob({ input: 200, cache: 0, output: 20, modelId: "gemini-4", modelName: "Gemini 4", lastStepIndex: 1 });
    liveWriter.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(b1);
    const filesBefore = fs.readdirSync(dir).sort();
    const openedLive = openSqliteSafe(dbPath);
    try {
      const rows = openedLive.db.prepare("SELECT idx FROM gen_metadata ORDER BY idx ASC").all() as Array<{ idx: number }>;
      expect(rows.map((r) => r.idx)).toEqual([0, 1]);
    } finally {
      openedLive.db.close();
      openedLive.cleanup();
      liveWriter.close();
    }
    expect(filesBefore).toContain("fixture.db-wal");
  });

  it("P2-1 & P2-2: keeps conflicting step indices separate, preserves real zero tokens, and retries failed reads", () => {
    const root = mkTmp("hamiji-p2-merge-");
    fs.mkdirSync(path.join(root, "conversations"), { recursive: true });
    const convA = "aaaa-conv";
    const convBad = "bbbb-bad";
    fs.mkdirSync(path.join(root, "brain", convA, ".system_generated", "logs"), { recursive: true });

    // convA: JSONL step 1 (input=100) + step 2 (explicit input=0, cache=500), DB explicit lastStepIndex=98 (step 99, input=200) & lastStepIndex=1 (step 2, input=999)
    const dbA = new DatabaseSync(path.join(root, "conversations", `${convA}.db`));
    dbA.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);");
    dbA.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(
      buildBlob({ input: 200, cache: 0, output: 0, modelId: "claude-opus", modelName: "Claude Opus", lastStepIndex: 98 })
    );
    dbA.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(
      buildBlob({ input: 999, cache: 500, output: 10, modelId: "gemini-4", modelName: "Gemini 4", lastStepIndex: 1 })
    );
    dbA.close();

    fs.writeFileSync(
      path.join(root, "brain", convA, ".system_generated", "logs", "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-26T10:00:00Z", input_tokens: 100, cache_read_tokens: 0, output_tokens: 0 }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", created_at: "2026-11-26T10:01:00Z", input_tokens: 0, cache_read_tokens: 500, output_tokens: 10 }),
      ].join("\n"),
      "utf8"
    );

    // convBad: 初始为损坏 SQLite 文件，触发读取失败但不中断 convA，也不得把失败结果锁死在缓存中
    const badDbPath = path.join(root, "conversations", `${convBad}.db`);
    fs.writeFileSync(badDbPath, "not-a-valid-sqlite-file", "utf8");

    const scanner = createTelemetryScanner(root);
    const first = scanner.scan(false);
    expect(first.health.warnings.some((w) => w.includes(convBad))).toBe(true);

    const detailA = first.conversations.find((c) => c.conversationId === convA);
    expect(detailA).toBeDefined();
    // step 1 (100, jsonl) + step 2 (0+500+10, hybrid, 保留真实 0 input) + step 99 (200, db, 独立不合并) => input 合计 300
    expect(detailA?.steps).toHaveLength(3);
    expect(detailA?.inputTokens).toBe(300);
    expect(detailA?.steps.find((s) => s.stepIndex === 1)?.modelName).not.toBe("Claude Opus");
    expect(detailA?.steps.find((s) => s.stepIndex === 2)?.inputTokens).toBe(0);
    expect(detailA?.steps.find((s) => s.stepIndex === 99)?.inputTokens).toBe(200);

    // 恢复 convBad 为有效库（即使同一毫秒内重写），下一次 scan 必须立刻重试成功读到数据
    fs.unlinkSync(badDbPath);
    const goodBadDb = new DatabaseSync(badDbPath);
    goodBadDb.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);");
    goodBadDb.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(
      buildBlob({ input: 777, cache: 0, output: 0, modelId: "gemini-4", modelName: "Gemini 4", lastStepIndex: 0 })
    );
    goodBadDb.close();

    const second = scanner.scan(false);
    expect(second.conversations.find((c) => c.conversationId === convBad)?.inputTokens).toBe(777);
  });

  it("P2-5, P2-7, P2-8 & P2-13: enables prod stores with custom dataDir, reconciles all-pool 7d partition, aligns liveQuota at sample time, preserves subagent IDs & unfiltered TTL", () => {
    const root = mkTmp("hamiji-p2-agg-");
    const storeDir = mkTmp("hamiji-p2-store-");
    const resetsPath = path.join(storeDir, "resets.json");
    const calsPath = path.join(storeDir, "calibrations.json");
    const livePath = path.join(storeDir, "live-quota.json");

    const parentId = "p-main-1";
    const childId = "c-sub-1";
    fs.mkdirSync(path.join(root, "brain", parentId, ".system_generated", "logs"), { recursive: true });
    fs.mkdirSync(path.join(root, "brain", childId, ".system_generated", "logs"), { recursive: true });

    // 构造 conversation_summaries 声明父子关系
    const sumDb = new DatabaseSync(path.join(root, "conversation_summaries.db"));
    sumDb.exec(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY, title text, step_count integer, last_modified_time text,
      workspace_uris text, status text, agent_name text, parent_conversation_id text, nesting_depth integer
    );`);
    const ins = sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run(parentId, "主会话", 4, "2026-11-26T12:00:00Z", '["file:///tmp/ws1"]', "done", "", "", 0);
    ins.run(childId, "", 1, "2026-11-26T12:05:00Z", '["file:///tmp/ws1"]', "done", "explorer", parentId, 1);
    sumDb.close();

    // 4 笔调用总计 135 Token：Claude 50 @ Nov 20, Gemini 50 @ Nov 20+1h, Claude 20 @ Nov 22, Gemini 15 @ Nov 25 (Gemini 在 Nov 24 重置)
    fs.writeFileSync(
      path.join(root, "brain", parentId, ".system_generated", "logs", "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-20T08:00:00Z", content: "changed setting `Model Selection` from None to Claude Opus 5.5 (High)." }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-20T08:01:00Z", input_tokens: 50, cache_read_tokens: 0, output_tokens: 0 }),
        JSON.stringify({ step_index: 2, type: "USER_INPUT", created_at: "2026-11-20T09:00:00Z", content: "changed setting `Model Selection` from None to Gemini 4 Neon (High)." }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", created_at: "2026-11-20T09:01:00Z", input_tokens: 50, cache_read_tokens: 0, output_tokens: 0 }),
        JSON.stringify({ step_index: 4, type: "USER_INPUT", created_at: "2026-11-22T08:00:00Z", content: "changed setting `Model Selection` from None to Claude Opus 5.5 (High)." }),
        JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", created_at: "2026-11-22T08:01:00Z", input_tokens: 20, cache_read_tokens: 0, output_tokens: 0 }),
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "brain", childId, ".system_generated", "logs", "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-25T08:00:00Z", content: "changed setting `Model Selection` from None to Gemini 4 Neon (High)." }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-25T08:01:00Z", input_tokens: 15, cache_read_tokens: 0, output_tokens: 0 }),
      ].join("\n"),
      "utf8"
    );

    const nowMs = Date.parse("2026-11-26T12:00:00Z");
    const liveAt = "2026-11-25T09:00:00.000Z";
    fs.writeFileSync(
      livePath,
      JSON.stringify({
        updatedAt: liveAt,
        pools: { "pool:gemini": { remainingPct: 80, resetTime: "", updatedAt: liveAt } },
      }),
      "utf8"
    );

    const svc = createTelemetryService(root, undefined, {
      resetsPath,
      calibrationsPath: calsPath,
      liveQuotaPath: livePath,
      useEnvAnchors: false,
    });

    // P2-5: 自定义 dataDir 下重置与校准写入必须可用
    svc.addReset!({ timestamp: "2026-11-24T00:00:00.000Z", pool: "gemini", note: "Gemini 中途重置" });
    const cals = svc.setCalibration!("pool:gemini:2026-11-24T00:00:00.000Z", {
      remainingPct: 80,
      calibratedCostUsd: 1,
      calibratedTokens: 15,
      calibratedAt: liveAt,
    });
    expect(cals["pool:gemini:2026-11-24T00:00:00.000Z"]?.remainingPct).toBe(80);

    // P2-7: 「全部」模式下 7d 与历史周严格不重不漏且与选择器一致 (15 + 120 = 135)
    const all7d = svc.getSummary({ cycle: "7d", nowMs });
    expect(all7d.totals.totalTokens).toBe(15);
    expect(all7d.quotaWindow?.active7dTokens).toBe(15);
    const opts = all7d.quotaWindow?.available7dCycles ?? [];
    expect(opts.map((o) => o.totalTokens)).toEqual([15, 120]);
    const prevWin = svc.getSummary({ cycle: opts[1].key, nowMs });
    expect(prevWin.totals.totalTokens).toBe(120);
    expect(all7d.totals.totalTokens + prevWin.totals.totalTokens).toBe(135);

    // P2-8: liveQuota 自动附带采样时刻的整池累计 Token (15) 与 windowStart
    expect(all7d.liveQuota?.["pool:gemini"]?.poolTokensAtSample).toBe(15);
    expect(all7d.liveQuota?.["pool:gemini"]?.windowStart).toBe("2026-11-24T00:00:00.000Z");

    // P2-13: 子代理调用节点保留实际 conversationId 和 rootConversationId
    const childNode = all7d.callTimeline.find((n) => n.conversationId === childId);
    expect(childNode).toBeDefined();
    expect(childNode?.rootConversationId).toBe(parentId);

    // P2-13: 隔着 Claude 的两次 Gemini 调用，单筛 pool:gemini 时不得误判为连续步 TTL 失效
    const switchConv = "switch-conv";
    fs.mkdirSync(path.join(root, "brain", switchConv, ".system_generated", "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "brain", switchConv, ".system_generated", "logs", "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-26T08:00:00Z", content: "changed setting `Model Selection` from None to Gemini 4 Neon (High)." }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-26T08:01:00Z", input_tokens: 20_000, cache_read_tokens: 0, output_tokens: 100 }),
        JSON.stringify({ step_index: 2, type: "USER_INPUT", created_at: "2026-11-26T08:02:00Z", content: "changed setting `Model Selection` from None to Claude Opus 5.5 (High)." }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", created_at: "2026-11-26T08:03:00Z", input_tokens: 20_000, cache_read_tokens: 0, output_tokens: 100 }),
        JSON.stringify({ step_index: 4, type: "USER_INPUT", created_at: "2026-11-26T08:04:00Z", content: "changed setting `Model Selection` from None to Gemini 4 Neon (High)." }),
        JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", created_at: "2026-11-26T08:06:00Z", input_tokens: 20_000, cache_read_tokens: 0, output_tokens: 100 }),
      ].join("\n"),
      "utf8"
    );
    const geminiFiltered = svc.getSummary({ model: "pool:gemini", cycle: "all", forceRefresh: true, nowMs });
    expect(geminiFiltered.cacheTtl?.expiredCount).toBe(0);
    expect(geminiFiltered.cacheTtl?.sampleCount).toBe(0);
  });

  it("P2-6 (round-1 & round-2): refuses to overwrite corrupted or mixed-bad-item resets.json and calibrations.json", () => {
    const dir = mkTmp("hamiji-p2-corrupt-");
    const badResets = path.join(dir, "resets.json");
    const badCals = path.join(dir, "calibrations.json");
    fs.writeFileSync(badResets, "[{broken json", "utf8");
    fs.writeFileSync(badCals, "{broken json", "utf8");

    const rStore = createResetStore(badResets);
    expect(() => rStore.add({ timestamp: "2026-11-27T00:00:00Z", pool: "all" })).toThrow(/已损坏/);
    expect(fs.readFileSync(badResets, "utf8")).toBe("[{broken json");

    const cStore = createCalibrationStore(badCals);
    expect(() =>
      cStore.set("pool:gemini:2026-11-27T00:00:00Z", {
        remainingPct: 50,
        calibratedCostUsd: 10,
        calibratedTokens: 1000,
        calibratedAt: "2026-11-27T01:00:00Z",
      })
    ).toThrow(/已损坏/);
    expect(fs.readFileSync(badCals, "utf8")).toBe("{broken json");

    // 合法 JSON 内混入损坏条目（坏日期 / 坏百分比）时，编辑其他记录必须阻止覆盖并保留原件
    const mixedResets = JSON.stringify([
      { id: "ok1", timestamp: "2026-11-20T00:00:00.000Z", pool: "gemini", note: "ok" },
      { id: "bad1", timestamp: "not-a-date", pool: "gemini", note: "bad" },
    ]);
    fs.writeFileSync(badResets, mixedResets, "utf8");
    expect(() => rStore.add({ timestamp: "2026-11-27T00:00:00Z", pool: "all" })).toThrow(/无效/);
    expect(fs.readFileSync(badResets, "utf8")).toBe(mixedResets);

    const mixedCals = JSON.stringify({
      "pool:gemini:2026-11-20T00:00:00.000Z": { remainingPct: 50, calibratedCostUsd: 1, calibratedTokens: 10, calibratedAt: "2026-11-21T00:00:00Z" },
      "pool:claude:2026-11-20T00:00:00.000Z": { remainingPct: 150, calibratedCostUsd: 1, calibratedTokens: 10, calibratedAt: "2026-11-21T00:00:00Z" },
    });
    fs.writeFileSync(badCals, mixedCals, "utf8");
    expect(() =>
      cStore.set("pool:gemini:2026-11-27T00:00:00Z", {
        remainingPct: 60,
        calibratedCostUsd: 2,
        calibratedTokens: 20,
        calibratedAt: "2026-11-27T01:00:00Z",
      })
    ).toThrow(/损坏条目/);
    expect(fs.readFileSync(badCals, "utf8")).toBe(mixedCals);
    // P2-3 (round-3): remainingPct: null 与无效 calibratedAt 在编辑其他键时必须抛错阻止改写，绝不变成 0% 或当前时间
    const nullAndBadDateCals = JSON.stringify({
      "pool:claude:2026-11-20T00:00:00.000Z": {
        remainingPct: null,
        calibratedCostUsd: 1,
        calibratedTokens: 10,
        calibratedAt: "not-a-valid-date",
      },
    });
    fs.writeFileSync(badCals, nullAndBadDateCals, "utf8");
    expect(() =>
      cStore.set("pool:gemini:2026-11-27T00:00:00Z", {
        remainingPct: 60,
        calibratedCostUsd: 2,
        calibratedTokens: 20,
        calibratedAt: "2026-11-27T01:00:00Z",
      })
    ).toThrow(/周剩余百分比/);
    expect(fs.readFileSync(badCals, "utf8")).toBe(nullAndBadDateCals);

    // P2-2 (round-3): 服务端按时间戳保护较新校准（较新的 42% 绝不被旧采样 65% 覆盖）
    const freshCals = path.join(dir, "fresh-calibrations.json");
    const freshStore = createCalibrationStore(freshCals);
    const k = "pool:gemini:2026-11-24T00:00:00.000Z";
    freshStore.set(k, { remainingPct: 42, calibratedCostUsd: 50, calibratedTokens: 500, calibratedAt: "2026-11-27T10:05:00.000Z" });
    const afterStale = freshStore.set(
      k,
      { remainingPct: 65, calibratedCostUsd: 30, calibratedTokens: 300, calibratedAt: "2026-11-27T10:00:00.000Z" },
      { source: "auto" }
    );
    expect(afterStale[k]?.remainingPct).toBe(42);

    // P2-1 (round-4): 迟到删除早于 10:05 写入不得删掉 42%；10:06 正常删除后，早于 10:06 的旧采样不得重建，10:10 新采样可重新写入
    expect(freshStore.remove(k, "2026-11-27T10:04:00.000Z")[k]?.remainingPct).toBe(42);
    expect(freshStore.remove(k, "2026-11-27T10:06:00.000Z")).toEqual({});
    expect(
      freshStore.set(
        k,
        { remainingPct: 65, calibratedCostUsd: 30, calibratedTokens: 300, calibratedAt: "2026-11-27T10:05:30.000Z" },
        { source: "auto" }
      )
    ).toEqual({});
    expect(
      freshStore.set(
        k,
        { remainingPct: 35, calibratedCostUsd: 60, calibratedTokens: 600, calibratedAt: "2026-11-27T10:10:00.000Z" },
        { source: "auto" }
      )[k]?.remainingPct
    ).toBe(35);
  });

  it("P2-6 (GPT-OSS in all-pool 7d) & P3-1 (legacy 4-arg calibrations path): reconciles all models and respects 4th arg", () => {
    const root = mkTmp("hamiji-p2-gptoss-");
    const storeDir = mkTmp("hamiji-p2-4arg-");
    const convId = "gptoss-conv";
    fs.mkdirSync(path.join(root, "brain", convId, ".system_generated", "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "brain", convId, ".system_generated", "logs", "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-25T08:00:00Z", content: "changed setting `Model Selection` from None to Gemini 4 Neon (High)." }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-25T08:01:00Z", input_tokens: 10, cache_read_tokens: 0, output_tokens: 0 }),
        JSON.stringify({ step_index: 2, type: "USER_INPUT", created_at: "2026-11-25T08:02:00Z", content: "changed setting `Model Selection` from None to GPT-OSS 120B (Medium)." }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", created_at: "2026-11-25T08:03:00Z", input_tokens: 20, cache_read_tokens: 0, output_tokens: 0 }),
      ].join("\n"),
      "utf8"
    );

    const nowMs = Date.parse("2026-11-26T12:00:00Z");
    const svcIso = createTelemetryService(root, undefined, { isolated: true });
    const s = svcIso.getSummary({ cycle: "7d", nowMs });
    expect(s.totals.totalTokens).toBe(30);
    expect(s.quotaWindow?.active7dTokens).toBe(30);
    expect(s.quotaWindow?.available7dCycles?.[0]?.totalTokens).toBe(30);

    // 旧四参签名：第 3 参 undefined、第 4 参传显式校准路径时必须写入该指定文件
    const explicitCal = path.join(storeDir, "explicit-cal.json");
    const svcLegacy = createTelemetryService(root, undefined, undefined, explicitCal);
    svcLegacy.setCalibration!("pool:gemini:2026-11-25T08:01:00.000Z", {
      remainingPct: 70,
      calibratedCostUsd: 1,
      calibratedTokens: 10,
      calibratedAt: "2026-11-25T09:00:00.000Z",
    });
    expect(fs.existsSync(explicitCal)).toBe(true);
  });

  it("P2-4, P2-10 & P2-11: dirty update returns ok:false, statusline preserves custom wrappers & rejects null remaining_fraction", async () => {
    // 1. statusline-bridge: 拒绝覆盖自定义包装命令与非对象配置，拒绝 remaining_fraction: null，保留真实 0
    const bridge = (await import(pathToFileURL(path.resolve("scripts/statusline-bridge.mjs")).href)) as {
      installAgyStatuslineHook: (opts: { agyDir: string; settingsPath: string }) => { installed: boolean };
      extractWeeklyQuotaPools: (payload: unknown) => Record<string, { remainingPct: number }> | null;
      mergeLiveQuotaFile: (filePath: string, pools: Record<string, unknown>) => { pools: Record<string, { remainingPct: number }> };
    };
    const bDir = mkTmp("hamiji-p2-bridge-");
    const settingsPath = path.join(bDir, "settings.json");

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "my-wrap && node statusline-bridge.mjs", extra: 1 } }),
      "utf8"
    );
    expect(bridge.installAgyStatuslineHook({ agyDir: bDir, settingsPath }).installed).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine.command).toContain("my-wrap");

    fs.writeFileSync(settingsPath, "[]", "utf8");
    expect(bridge.installAgyStatuslineHook({ agyDir: bDir, settingsPath }).installed).toBe(false);

    const extracted = bridge.extractWeeklyQuotaPools({
      quota: {
        gemini_weekly: { remaining_fraction: null },
        claude_7d: { remaining_fraction: 0, reset_time: "2026-12-01T00:00:00Z" },
      },
    });
    expect(extracted?.["pool:gemini"]).toBeUndefined();
    expect(extracted?.["pool:claude"]?.remainingPct).toBe(0);

    // 真实 agy CLI 桶名校验：gemini-weekly -> pool:gemini，3p-weekly -> pool:claude，忽略 5h 桶
    const extractedReal = bridge.extractWeeklyQuotaPools({
      quota: {
        "3p-5h": { remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z", reset_in_seconds: 0 },
        "3p-weekly": { remaining_fraction: 0.96389854, reset_time: "2026-12-01T23:55:17Z", reset_in_seconds: 333100 },
        "gemini-5h": { remaining_fraction: 0.9446, reset_time: "2026-11-28T05:54:24Z", reset_in_seconds: 9047 },
        "gemini-weekly": { remaining_fraction: 0.63076097, reset_time: "2026-12-03T07:05:28Z", reset_in_seconds: 445311 },
      },
    });
    expect(extractedReal?.["pool:gemini"]?.remainingPct).toBe(63.1);
    expect(extractedReal?.["pool:claude"]?.remainingPct).toBe(96.4);

    const livePath = path.join(bDir, "live-quota.json");
    bridge.mergeLiveQuotaFile(livePath, { "pool:gemini": { remainingPct: 88, resetTime: "", resetInSeconds: 0 } });
    const merged = bridge.mergeLiveQuotaFile(livePath, { "pool:claude": { remainingPct: 42, resetTime: "", resetInSeconds: 0 } });
    expect(merged.pools["pool:gemini"]?.remainingPct).toBe(88);
    expect(merged.pools["pool:claude"]?.remainingPct).toBe(42);

    // 2. update.mjs: 脏工作区(含断点续建)返回 ok:false、存活 PID 锁不被抢占、过期 {} NaN-PID 锁可回收、跨提交 B->C 保留 pendingBuild、confirmAppliedUpdate 校验 build 已完成
    const updater = (await import(pathToFileURL(path.resolve("scripts/update.mjs")).href)) as {
      acquireUpdateLock: (lockPath: string) => (() => void) | null;
      checkForUpdate: (opts: { repoRoot: string; stateDir: string }) => { ok: boolean; available: boolean; behindCount: number; pendingSteps?: boolean };
      confirmAppliedUpdate: (opts: { repoRoot: string; stateDir: string }) => { confirmed: boolean };
      performUpdate: (opts: { repoRoot: string; stateDir: string; noRestart: boolean }) => { ok: boolean; dirty?: boolean; updated?: boolean; pendingRestart?: boolean; needBuild?: boolean };
    };
    const lockFile = path.join(bDir, "owner-test.lock");
    // 写入当前存活 PID 但时间戳为 1 小时前的锁：存活持有人绝不可被抢占
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "alive-holder", startedAt: Date.now() - 3_600_000 }), "utf8");
    expect(updater.acquireUpdateLock(lockFile)).toBeNull();
    // 写入已退出 PID 的锁：应能安全接管并释放
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: "dead-holder", startedAt: Date.now() }), "utf8");
    const rel = updater.acquireUpdateLock(lockFile);
    expect(rel).not.toBeNull();
    rel?.();
    expect(fs.existsSync(lockFile)).toBe(false);
    // P2-6: 过期的 {} 损坏锁（缺少 PID，避免 NaN!==NaN 卡死）必须可被安全回收
    fs.writeFileSync(lockFile, "{}", "utf8");
    const oldTime = new Date(Date.now() - 15 * 60_000);
    fs.utimesSync(lockFile, oldTime, oldTime);
    const relCorrupt = updater.acquireUpdateLock(lockFile);
    expect(relCorrupt).not.toBeNull();
    relCorrupt?.();
    expect(fs.existsSync(lockFile)).toBe(false);
    const gitBase = mkTmp("hamiji-p2-git-");
    const remoteRepo = path.join(gitBase, "remote.git");
    const localRepo = path.join(gitBase, "local");
    const stateDir = path.join(gitBase, "state");
    execFileSync("git", ["init", "--bare", remoteRepo], { stdio: "ignore" });
    execFileSync("git", ["clone", remoteRepo, localRepo], { stdio: "ignore" });
    const gitLocal = (args: string[]) =>
      execFileSync("git", args, {
        cwd: localRepo,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    fs.writeFileSync(path.join(localRepo, "a.txt"), "v1\n");
    fs.writeFileSync(path.join(localRepo, "package.json"), JSON.stringify({ name: "tmp", scripts: { build: "node -e \"\"" } }));
    gitLocal(["add", "."]);
    gitLocal(["commit", "-m", "init"]);
    gitLocal(["push", "-u", "origin", "HEAD"]);

    // 远端推进一笔新提交，本地置脏
    const otherRepo = path.join(gitBase, "other");
    execFileSync("git", ["clone", remoteRepo, otherRepo], { stdio: "ignore" });
    fs.writeFileSync(path.join(otherRepo, "a.txt"), "v2\n");
    execFileSync("git", ["add", "."], { cwd: otherRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v2"], {
      cwd: otherRepo,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    execFileSync("git", ["push"], { cwd: otherRepo, stdio: "ignore" });

    fs.writeFileSync(path.join(localRepo, "a.txt"), "dirty\n");
    const dirtyRes = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(dirtyRes.ok).toBe(false);
    expect(dirtyRes.dirty).toBe(true);

    // 清理脏改并合并后，若 update-state.json 标记 pendingBuild=true，即使 behindCount=0 也应检测到待续建
    gitLocal(["checkout", "--", "a.txt"]);
    const cleanRes = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(cleanRes.ok).toBe(true);
    expect(cleanRes.updated).toBe(true);
    const headFull = execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepo, encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(stateDir, "update-state.json"),
      JSON.stringify({ appliedCommit: "old", targetCommit: headFull, pendingInstall: false, pendingBuild: true, pendingRestart: true }),
      "utf8"
    );
    const resumeCheck = updater.checkForUpdate({ repoRoot: localRepo, stateDir });
    expect(resumeCheck.behindCount).toBe(0);
    expect(resumeCheck.pendingSteps).toBe(true);
    expect(resumeCheck.available).toBe(true);

    // 追平但待续建期间若本地出现脏改，必须拒绝续建
    fs.writeFileSync(path.join(localRepo, "a.txt"), "dirty-during-resume\n");
    const dirtyResume = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(dirtyResume.ok).toBe(false);
    expect(dirtyResume.dirty).toBe(true);
    gitLocal(["checkout", "--", "a.txt"]);

    // 远端修改 server/ 文件并以 --no-restart 拉取时，pendingRestart 必须保持 true 直到新进程确认生效
    fs.mkdirSync(path.join(otherRepo, "server"), { recursive: true });
    fs.writeFileSync(path.join(otherRepo, "server", "dummy.ts"), "// v3\n");
    execFileSync("git", ["add", "."], { cwd: otherRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v3-server"], {
      cwd: otherRepo,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    execFileSync("git", ["push"], { cwd: otherRepo, stdio: "ignore" });
    const deferRes = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(deferRes.ok).toBe(true);
    expect(deferRes.pendingRestart).toBe(true);
    const savedState = JSON.parse(fs.readFileSync(path.join(stateDir, "update-state.json"), "utf8")) as { pendingRestart: boolean };
    expect(savedState.pendingRestart).toBe(true);
    expect(updater.checkForUpdate({ repoRoot: localRepo, stateDir }).pendingSteps).toBe(true);

    // P2-5: pendingBuild=true 时 confirmAppliedUpdate 绝不可提前确认生效；仅 install/build 均 false 时才确认
    const curHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepo, encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(stateDir, "update-state.json"),
      JSON.stringify({ appliedCommit: "old", fromCommit: curHead, targetCommit: curHead, pendingInstall: false, pendingBuild: true, pendingRestart: true }),
      "utf8"
    );
    expect(updater.confirmAppliedUpdate({ repoRoot: localRepo, stateDir }).confirmed).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, "update-state.json"), "utf8")).pendingBuild).toBe(true);

    // P2-4: 模拟 B 有 pendingBuild=true，向远端 docs-only C 合并前中断（fromCommit=B, targetCommit=C），重试仍必须执行 build
    fs.writeFileSync(path.join(otherRepo, "README.md"), "docs only\n");
    execFileSync("git", ["add", "."], { cwd: otherRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v4-docs"], {
      cwd: otherRepo,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    execFileSync("git", ["push"], { cwd: otherRepo, stdio: "ignore" });
    const commitC = execFileSync("git", ["rev-parse", "HEAD"], { cwd: otherRepo, encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(stateDir, "update-state.json"),
      JSON.stringify({ appliedCommit: "old", fromCommit: curHead, targetCommit: commitC, pendingInstall: false, pendingBuild: true, pendingRestart: true }),
      "utf8"
    );
    const recoverRes = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(recoverRes.ok).toBe(true);
    expect(recoverRes.needBuild).toBe(true);
    expect(updater.confirmAppliedUpdate({ repoRoot: localRepo, stateDir }).confirmed).toBe(true);

    // P2-2 (round-5) 方向 A：常规 B 已生效（appliedCommit=B），已拉取 C 到本地且写 from=B,target=C 后合并前崩溃、恢复时断网 -> 必须识别 pending 并续合并本地 C
    fs.writeFileSync(path.join(otherRepo, "a.txt"), "v5-local-c\n");
    execFileSync("git", ["add", "."], { cwd: otherRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v5-local-c"], {
      cwd: otherRepo,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    execFileSync("git", ["push"], { cwd: otherRepo, stdio: "ignore" });
    gitLocal(["fetch", "--quiet"]);
    const fetchedC = execFileSync("git", ["rev-parse", "@{u}"], { cwd: localRepo, encoding: "utf8" }).trim();
    const headB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepo, encoding: "utf8" }).trim();
    gitLocal(["remote", "set-url", "origin", "/nonexistent/offline-remote.git"]);
    fs.writeFileSync(
      path.join(stateDir, "update-state.json"),
      JSON.stringify({ appliedCommit: headB, fromCommit: headB, targetCommit: fetchedC, pendingInstall: false, pendingBuild: true, pendingRestart: true }),
      "utf8"
    );
    const offlineLocalC = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(offlineLocalC.ok).toBe(true);
    expect(offlineLocalC.updated).toBe(true);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepo, encoding: "utf8" }).trim()).toBe(fetchedC);

    // P2-2 (round-5) 方向 B：B 自身未生效（appliedCommit=old），本地有已撤回的 C，但在线 fetch 确认上游已回到 B（behindCount=0）-> 绝不可合并已撤回的 C
    gitLocal(["remote", "set-url", "origin", remoteRepo]);
    gitLocal(["reset", "--hard", headB]);
    execFileSync("git", ["reset", "--hard", headB], { cwd: otherRepo, stdio: "ignore" });
    execFileSync("git", ["push", "--force"], { cwd: otherRepo, stdio: "ignore" });
    fs.writeFileSync(
      path.join(stateDir, "update-state.json"),
      JSON.stringify({ appliedCommit: "old", fromCommit: headB, targetCommit: fetchedC, pendingInstall: false, pendingBuild: true, pendingRestart: false }),
      "utf8"
    );
    const onlineReverted = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(onlineReverted.ok).toBe(true);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepo, encoding: "utf8" }).trim()).toBe(headB);

    // P2-4 (round-4): 合并前中断（HEAD=当前, targetCommit=尚未拉取的假提交）且 fetch 失败时，绝不可在旧 HEAD 上构建并吞掉原目标
    const headC = execFileSync("git", ["rev-parse", "HEAD"], { cwd: localRepo, encoding: "utf8" }).trim();
    const unreachedTarget = "1111111111111111111111111111111111111111";
    gitLocal(["remote", "set-url", "origin", "/nonexistent/offline-remote.git"]);
    fs.writeFileSync(
      path.join(stateDir, "update-state.json"),
      JSON.stringify({ appliedCommit: "old", fromCommit: headC, targetCommit: unreachedTarget, pendingInstall: false, pendingBuild: true, pendingRestart: true }),
      "utf8"
    );
    const offlinePreMerge = updater.performUpdate({ repoRoot: localRepo, stateDir, noRestart: true });
    expect(offlinePreMerge.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, "update-state.json"), "utf8")).targetCommit).toBe(unreachedTarget);
  }, 20_000);
});
