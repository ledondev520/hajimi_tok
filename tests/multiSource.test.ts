/**
 * Input: vitest 断言工具、node:crypto/fs/http/os/path/sqlite 以及 server/{sources,multiSource,app,cliRender,protobuf}。
 * Output: 验证 T3 Code 多账号自动发现、多数据源合并/隔离聚合、HTTP /api/sources 与 ?source= 路由及 CLI --source 渲染。
 * Pos: 多账号与 T3 Code 兼容性自动化测试套件（tests/multiSource.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryHttpServer } from "../server/app";
import { parseCliArgs, renderCliReport } from "../server/cliRender";
import { createMultiSourceTelemetryService } from "../server/multiSource";
import { concatBytes, encodeBytesField, encodeStringField, encodeVarintField } from "../server/protobuf";
import { discoverLocalDataSources, sanitizeSourceSlug } from "../server/sources";
import type { DashboardSummaryPayload, DataSourceInfo } from "../src/types/telemetry";

const tempDirs: string[] = []; // 测试沙箱临时目录列表
const activeServers: http.Server[] = []; // 待关闭的测试 HTTP 服务列表

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造临时沙箱目录并纳入自动清理 */
function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 生成最小合法 gen_metadata Protobuf 二进制 */
function buildMockGenBlob(opts: {
  input: number;
  cache: number;
  output: number;
  thinking: number;
  response: number;
  modelId: string;
  modelName: string;
}): Uint8Array {
  const usage = concatBytes(
    encodeVarintField(2, opts.input),
    encodeVarintField(3, opts.output),
    encodeVarintField(5, opts.cache),
    encodeVarintField(9, opts.thinking),
    encodeVarintField(10, opts.response)
  );
  const mapStep = concatBytes(encodeStringField(1, "last_step_index"), encodeStringField(2, "0"));
  const inner = concatBytes(
    encodeBytesField(4, usage),
    encodeStringField(19, opts.modelId),
    encodeBytesField(20, mapStep),
    encodeStringField(21, opts.modelName)
  );
  return encodeBytesField(1, inner);
}

/** 在指定 AntiGravity 数据目录下写入 1 条真实可读 SQLite 会话 */
function seedAntigravityDataDir(
  dataDir: string,
  opts: {
    conversationId: string;
    title: string;
    workspace: string;
    modelId: string;
    modelName: string;
    input: number;
    cache: number;
    output: number;
    timestampMs: number;
  }
): void {
  const convDir = path.join(dataDir, "conversations");
  fs.mkdirSync(convDir, { recursive: true });

  const isoTime = new Date(opts.timestampMs).toISOString();
  const summaryDb = new DatabaseSync(path.join(dataDir, "conversation_summaries.db"));
  summaryDb.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text,
      step_count integer,
      last_modified_time text,
      workspace_uris text,
      status text,
      agent_name text,
      parent_conversation_id text,
      nesting_depth integer
    );
  `);
  summaryDb
    .prepare("INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      opts.conversationId,
      opts.title,
      2,
      isoTime,
      JSON.stringify([`file:///Users/demo/${opts.workspace}`]),
      "done",
      "",
      "",
      0
    );
  summaryDb.close();

  const convDb = new DatabaseSync(path.join(convDir, `${opts.conversationId}.db`));
  convDb.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer);");
  const blob = buildMockGenBlob({
    input: opts.input,
    cache: opts.cache,
    output: opts.output,
    thinking: Math.floor(opts.output * 0.4),
    response: opts.output - Math.floor(opts.output * 0.4),
    modelId: opts.modelId,
    modelName: opts.modelName,
  });
  convDb.prepare("INSERT INTO gen_metadata VALUES (0, ?, ?)").run(blob, blob.byteLength);
  convDb.close();
}

describe("T3 Code & Multi-Source Discovery (server/sources.ts)", () => {
  it("auto-discovers T3 Code accounts with settings.json displayName mapping and native dir", () => {
    const homeDir = mkTempDir("agy-ms-home-");
    const t3Root = path.join(homeDir, ".t3", "userdata");
    const hashAlpha = crypto.createHash("sha256").update("antigravity").digest("hex");
    const hashBeta = crypto.createHash("sha256").update("work_acct").digest("hex");
    const hashUnnamed = crypto.createHash("sha256").update("unmapped_acct").digest("hex");

    fs.mkdirSync(t3Root, { recursive: true });
    fs.writeFileSync(
      path.join(t3Root, "settings.json"),
      JSON.stringify({
        providerInstances: {
          antigravity: { driver: "antigravity", displayName: "Account Alpha" },
          work_acct: { driver: "antigravity", displayName: "Account Beta" },
          codex_main: { driver: "codex", displayName: "Ignored Codex" },
        },
      })
    );

    const alphaDir = path.join(t3Root, "providers", "antigravity", hashAlpha, "antigravity-acp");
    const betaDir = path.join(t3Root, "providers", "antigravity", hashBeta, "antigravity-acp");
    const unnamedDir = path.join(t3Root, "providers", "antigravity", hashUnnamed, "antigravity-acp");
    const nativeDir = path.join(homeDir, ".gemini", "antigravity");
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });
    fs.mkdirSync(unnamedDir, { recursive: true });
    seedAntigravityDataDir(nativeDir, {
      conversationId: "conv-native-1",
      title: "Native session",
      workspace: "native-ws",
      modelId: "gemini-4-argon-high",
      modelName: "Gemini 4 Argon (High)",
      input: 1000,
      cache: 9000,
      output: 500,
      timestampMs: Date.now(),
    });

    const sources = discoverLocalDataSources({
      customDataDir: "",
      homeDir,
      stateRootDir: path.join(homeDir, ".hamiji-sta"),
    });

    expect(sources).toHaveLength(4);
    expect(sources.find((s) => s.id === "t3:antigravity")?.label).toBe("Account Alpha");
    expect(sources.find((s) => s.id === "t3:work_acct")?.label).toBe("Account Beta");
    expect(sources.find((s) => s.dataDir === unnamedDir)?.label).toBe(`T3 (${hashUnnamed.slice(0, 8)})`);
    expect(sources.find((s) => s.id === "native")?.kind).toBe("native");
    expect(sanitizeSourceSlug("t3:work/acct..1")).toBe("t3_work_acct_1");
  });

  it("supports explicit single and delimiter-separated multi customDataDir overrides", () => {
    const dirA = mkTempDir("agy-custom-a-");
    const dirB = mkTempDir("agy-custom-b-");

    const single = discoverLocalDataSources({ customDataDir: dirA });
    expect(single).toHaveLength(1);
    expect(single[0].id).toBe("custom");
    expect(single[0].dataDir).toBe(dirA);

    const multi = discoverLocalDataSources({ customDataDir: `${dirA}${path.delimiter}${dirB}` });
    expect(multi).toHaveLength(2);
    expect(multi.map((s) => s.id)).toEqual(["custom:1", "custom:2"]);
  });
});

describe("Multi-Source Service, HTTP API & CLI (server/multiSource.ts)", () => {
  it("merges multi-account totals, isolates per-account calibrations/resets, and exposes HTTP & CLI filters", async () => {
    const homeDir = mkTempDir("agy-e2e-home-");
    const t3Root = path.join(homeDir, ".t3", "userdata");
    const stateRoot = path.join(homeDir, ".hamiji-sta");
    const hashA = crypto.createHash("sha256").update("acct_a").digest("hex");
    const hashB = crypto.createHash("sha256").update("acct_b").digest("hex");
    const dirA = path.join(t3Root, "providers", "antigravity", hashA, "antigravity-acp");
    const dirB = path.join(t3Root, "providers", "antigravity", hashB, "antigravity-acp");
    const nowMs = Date.now();

    fs.mkdirSync(t3Root, { recursive: true });
    fs.writeFileSync(
      path.join(t3Root, "settings.json"),
      JSON.stringify({
        providerInstances: {
          acct_a: { driver: "antigravity", displayName: "Studio Alpha" },
          acct_b: { driver: "antigravity", displayName: "Personal Beta" },
        },
      })
    );

    seedAntigravityDataDir(dirA, {
      conversationId: "conv-alpha-01",
      title: "Alpha Heavy Task",
      workspace: "alpha-proj",
      modelId: "claude-opus-5-5-medium",
      modelName: "Claude Opus 5.5 (Medium)",
      input: 100_000,
      cache: 900_000,
      output: 20_000,
      timestampMs: nowMs - 60_000,
    });
    seedAntigravityDataDir(dirB, {
      conversationId: "conv-beta-01",
      title: "Beta Quick Task",
      workspace: "beta-proj",
      modelId: "gemini-4-argon-high",
      modelName: "Gemini 4 Argon (High)",
      input: 20_000,
      cache: 180_000,
      output: 5_000,
      timestampMs: nowMs - 30_000,
    });

    const service = createMultiSourceTelemetryService("", undefined, {
      homeDir,
      t3UserdataDir: t3Root,
      stateRootDir: stateRoot,
    });

    // 1. 合并总览汇总两账号且按成本降序返回 sources 明细
    const merged = service.getSummary({ cycle: "all" });
    expect(merged.activeSource).toBe("all");
    expect(merged.sources).toHaveLength(2);
    expect(merged.sources?.[0].id).toBe("t3:acct_a");
    expect(merged.sources?.[0].label).toBe("Studio Alpha");
    expect(merged.sources?.[1].id).toBe("t3:acct_b");
    expect(merged.totals.totalTokens).toBe(1_020_000 + 205_000);
    expect(merged.conversations).toHaveLength(2);
    expect(merged.conversations.find((c) => c.conversationId === "conv-alpha-01")?.sourceLabel).toBe(
      "Studio Alpha"
    );

    // 1.1. 合并视图 7d 窗口下各账号分摊加总必须与全局 KPI 完全对齐（杜绝单源独立重置锚点造成卡片与 KPI 金额偏差）
    const merged7d = service.getSummary({ cycle: "7d" });
    const sumSourceCost = (merged7d.sources ?? []).reduce((s, x) => s + x.estimatedCostUsd, 0);
    const sumSourceTokens = (merged7d.sources ?? []).reduce((s, x) => s + x.totalTokens, 0);
    expect(sumSourceCost).toBeCloseTo(merged7d.totals.estimatedCostUsd, 6);
    expect(sumSourceTokens).toBe(merged7d.totals.totalTokens);

    // 2. 单账号筛选精准隔离
    const onlyB = service.getSummary({ cycle: "all", source: "t3:acct_b" });
    expect(onlyB.activeSource).toBe("t3:acct_b");
    expect(onlyB.totals.totalTokens).toBe(205_000);
    expect(onlyB.conversations.map((c) => c.conversationId)).toEqual(["conv-beta-01"]);

    // 3. 跨账号按 ID 查详情保留 sourceLabel
    const detailB = service.getConversationDetail("conv-beta-01");
    expect(detailB?.sourceId).toBe("t3:acct_b");
    expect(detailB?.sourceLabel).toBe("Personal Beta");

    // 4. 各账号周校准与重置记录存储完全隔离
    const calKey = "pool:claude:2026-11-22T00:00:00.000Z";
    service.setCalibration?.(
      calKey,
      { remainingPct: 60, calibratedCostUsd: 10, calibratedTokens: 1_000_000, calibratedAt: new Date(nowMs).toISOString() },
      { source: "manual" },
      "t3:acct_a"
    );
    expect(service.getCalibrations?.("t3:acct_a")[calKey]?.remainingPct).toBe(60);
    expect(service.getCalibrations?.("t3:acct_b")[calKey]).toBeUndefined();
    service.addReset?.({ timestamp: new Date(nowMs - 3600_000).toISOString(), pool: "claude", note: "alpha-only" }, "t3:acct_a");
    expect(service.getResets?.("t3:acct_a").some((r) => r.note === "alpha-only")).toBe(true);
    expect(service.getResets?.("t3:acct_b").some((r) => r.note === "alpha-only")).toBe(false);

    // 5. HTTP 路由 /api/sources、/api/summary?source=...、/api/calibrations?source=...
    const server = createTelemetryHttpServer(service);
    activeServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const sourcesRes = (await (await fetch(`${baseUrl}/api/sources`)).json()) as {
      sources: DataSourceInfo[];
    };
    expect(sourcesRes.sources).toHaveLength(2);

    const summaryARes = (await (
      await fetch(`${baseUrl}/api/summary?cycle=all&source=${encodeURIComponent("t3:acct_a")}`)
    ).json()) as DashboardSummaryPayload;
    expect(summaryARes.activeSource).toBe("t3:acct_a");
    expect(summaryARes.totals.totalTokens).toBe(1_020_000);

    const calARes = (await (
      await fetch(`${baseUrl}/api/calibrations?source=${encodeURIComponent("t3:acct_a")}`)
    ).json()) as { calibrations: Record<string, { remainingPct: number }> };
    expect(calARes.calibrations[calKey]?.remainingPct).toBe(60);

    const calBRes = (await (
      await fetch(`${baseUrl}/api/calibrations?source=${encodeURIComponent("t3:acct_b")}`)
    ).json()) as { calibrations: Record<string, { remainingPct: number }> };
    expect(calBRes.calibrations[calKey]).toBeUndefined();

    // 6. CLI --source 参数与 [By Account / Source] 多账号汇总表渲染
    expect(parseCliArgs(["-s", "t3:acct_a", "--days", "7"]).source).toBe("t3:acct_a");
    const report = renderCliReport(merged, 5);
    expect(report).toContain("[By Account / Source]");
    expect(report).toContain("Studio Alpha");
    expect(report).toContain("Personal Beta");
    expect(report).toContain("t3:acct_a");
  });

  it("applies shared-resets.json to merged and T3 accounts, isolates dismissal, and supports nodeLimit & ETag 304", async () => {
    const homeDir = mkTempDir("agy-shared-reset-home-");
    const t3Root = path.join(homeDir, ".t3", "userdata");
    const stateRoot = path.join(homeDir, ".hamiji-sta");
    const sharedFile = path.join(homeDir, "shared-resets.json");
    const hashA = crypto.createHash("sha256").update("acct_a").digest("hex");
    const hashB = crypto.createHash("sha256").update("acct_b").digest("hex");
    const dirA = path.join(t3Root, "providers", "antigravity", hashA, "antigravity-acp");
    const dirB = path.join(t3Root, "providers", "antigravity", hashB, "antigravity-acp");

    fs.mkdirSync(t3Root, { recursive: true });
    fs.writeFileSync(
      path.join(t3Root, "settings.json"),
      JSON.stringify({
        providerInstances: {
          acct_a: { driver: "antigravity", displayName: "Acct A" },
          acct_b: { driver: "antigravity", displayName: "Acct B" },
        },
      })
    );
    fs.writeFileSync(
      sharedFile,
      JSON.stringify([
        { id: "s-nov24", timestamp: "2026-11-23T23:38:23.000Z", pool: "gemini", note: "周二提前重置" },
        { id: "s-nov26", timestamp: "2026-11-26T07:04:48.000Z", pool: "gemini", note: "周四提前重置" },
      ])
    );

    // 分别在 11-23（旧期）、11-25（11-24 重置后）与 11-27（11-26 重置后）写入调用
    seedAntigravityDataDir(dirA, {
      conversationId: "conv-a-old",
      title: "A before Nov24",
      workspace: "ws-a",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 1000,
      cache: 0,
      output: 100,
      timestampMs: Date.parse("2026-11-23T10:00:00.000Z"),
    });
    seedAntigravityDataDir(dirA, {
      conversationId: "conv-a-new",
      title: "A after Nov26",
      workspace: "ws-a",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 2000,
      cache: 0,
      output: 200,
      timestampMs: Date.parse("2026-11-27T10:00:00.000Z"),
    });
    seedAntigravityDataDir(dirB, {
      conversationId: "conv-b-mid",
      title: "B between Nov24 and Nov26",
      workspace: "ws-b",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 3000,
      cache: 0,
      output: 300,
      timestampMs: Date.parse("2026-11-25T10:00:00.000Z"),
    });
    seedAntigravityDataDir(dirB, {
      conversationId: "conv-b-new",
      title: "B after Nov26",
      workspace: "ws-b",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 4000,
      cache: 0,
      output: 400,
      timestampMs: Date.parse("2026-11-27T12:00:00.000Z"),
    });

    const service = createMultiSourceTelemetryService("", undefined, {
      homeDir,
      t3UserdataDir: t3Root,
      stateRootDir: stateRoot,
      sharedResetsPath: sharedFile,
    });
    const nowMs = Date.parse("2026-11-28T03:00:00.000Z");

    // 1. 合并视图与两个 T3 单账号均继承 shared-resets.json，当前 7d 起点严格对齐 11-26 15:04 (07:04:48Z)
    const all7d = service.getSummary({ source: "all", cycle: "7d", model: "pool:gemini", nowMs });
    expect(all7d.quotaWindow?.windowStart).toBe("2026-11-26T07:04:48.000Z");
    expect(all7d.totals.totalTokens).toBe(2200 + 4400);

    const a7d = service.getSummary({ source: "t3:acct_a", cycle: "7d", model: "pool:gemini", nowMs });
    expect(a7d.quotaWindow?.windowStart).toBe("2026-11-26T07:04:48.000Z");
    expect(a7d.totals.totalTokens).toBe(2200);
    expect(service.getResets?.("t3:acct_a").map((r) => r.id)).toEqual(["s-nov24", "s-nov26"]);

    const b7d = service.getSummary({ source: "t3:acct_b", cycle: "7d", model: "pool:gemini", nowMs });
    expect(b7d.quotaWindow?.windowStart).toBe("2026-11-26T07:04:48.000Z");
    expect(b7d.totals.totalTokens).toBe(4400);

    // 2. 隐藏单账号下的公共重置不影响另一账号
    service.deleteReset?.("s-nov26", "t3:acct_a");
    expect(service.getResets?.("t3:acct_a").map((r) => r.id)).toEqual(["s-nov24"]);
    expect(service.getResets?.("t3:acct_b").map((r) => r.id)).toEqual(["s-nov24", "s-nov26"]);

    // 3. HTTP nodeLimit 与 ETag / 304 Not Modified 短路
    const server = createTelemetryHttpServer(service);
    activeServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const limitedRes = await fetch(`${baseUrl}/api/summary?cycle=all&nodeLimit=1`);
    expect(limitedRes.status).toBe(200);
    const etag = limitedRes.headers.get("etag");
    expect(etag).toBeTruthy();
    const limitedJson = (await limitedRes.json()) as DashboardSummaryPayload;
    expect(limitedJson.callTimeline).toHaveLength(1);

    const notModifiedRes = await fetch(`${baseUrl}/api/summary?cycle=all&nodeLimit=1`, {
      headers: { "If-None-Match": etag! },
    });
    expect(notModifiedRes.status).toBe(304);
  });

  it("auto-merges T3 and native directories sharing the same Google account email, binds live-quota without crosstalk, and exposes weeklyQuota badges", () => {
    const homeDir = mkTempDir("agy-acct-merge-home-");
    const t3Root = path.join(homeDir, ".t3", "userdata");
    const stateRoot = path.join(homeDir, ".hamiji-sta");
    const hashWork = crypto.createHash("sha256").update("work_t3").digest("hex");
    const hashSelf = crypto.createHash("sha256").update("self_t3").digest("hex");
    const workDir = path.join(t3Root, "providers", "antigravity", hashWork, "antigravity-acp");
    const selfDir = path.join(t3Root, "providers", "antigravity", hashSelf, "antigravity-acp");
    const nativeAppDir = path.join(homeDir, ".gemini", "antigravity");
    const nativeCliDir = path.join(homeDir, ".gemini", "antigravity-cli");
    const nowMs = Date.parse("2026-11-28T05:00:00.000Z");

    fs.mkdirSync(t3Root, { recursive: true });
    fs.writeFileSync(
      path.join(t3Root, "settings.json"),
      JSON.stringify({
        providerInstances: {
          work_t3: { driver: "antigravity", displayName: "Work Acct" },
          self_t3: { driver: "antigravity", displayName: "Personal Acct" },
        },
      })
    );

    // 写入非敏感启动日志标明两个 T3 账号分别属于不同邮箱（并模拟 Work Acct 偶发 1 次串号日志，验证多数投票与 T3 实例互不合并保护）
    fs.mkdirSync(path.join(workDir, "log"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, "log", "acp-server-20261128_100001-1.log"),
      "I1128 10:00:01 server_oauth.go:221] applyAuthResult: email=work@example.com, authMethod=consumer\n"
    );
    fs.writeFileSync(
      path.join(workDir, "log", "acp-server-20261128_100002-2.log"),
      "I1128 10:00:02 server_oauth.go:221] applyAuthResult: email=work@example.com, authMethod=consumer\n"
    );
    fs.writeFileSync(
      path.join(workDir, "log", "acp-server-20261128_100009-3.log"),
      "I1128 10:00:09 server_oauth.go:221] applyAuthResult: email=self@example.com, authMethod=consumer\n"
    );
    fs.mkdirSync(path.join(selfDir, "log"), { recursive: true });
    fs.writeFileSync(
      path.join(selfDir, "log", "acp-server-20261128_100000-2.log"),
      "I1128 10:00:02 server_oauth.go:221] applyAuthResult: email=self@example.com, authMethod=consumer\n"
    );
    fs.mkdirSync(nativeCliDir, { recursive: true });
    fs.writeFileSync(
      path.join(nativeCliDir, "cli.log"),
      "I1128 10:05:00 server_oauth.go:221] applyAuthResult: email=self@example.com, authMethod=consumer\n"
    );

    // 四个目录分别写入会话，验证 self_t3 + nativeApp + nativeCli 三目录合并至 Personal Acct
    seedAntigravityDataDir(workDir, {
      conversationId: "conv-work-1",
      title: "Work Task",
      workspace: "ws-work",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 50_000,
      cache: 450_000,
      output: 10_000,
      timestampMs: nowMs - 3_600_000,
    });
    seedAntigravityDataDir(selfDir, {
      conversationId: "conv-self-t3",
      title: "Self T3 Task",
      workspace: "ws-self",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 100_000,
      cache: 900_000,
      output: 20_000,
      timestampMs: nowMs - 3_600_000,
    });
    seedAntigravityDataDir(nativeAppDir, {
      conversationId: "conv-self-native",
      title: "Self Native App Task",
      workspace: "ws-self",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 10_000,
      cache: 90_000,
      output: 2_000,
      timestampMs: nowMs - 2_400_000,
    });
    seedAntigravityDataDir(nativeCliDir, {
      conversationId: "conv-self-cli",
      title: "Self Native CLI Task",
      workspace: "ws-self",
      modelId: "gemini-4-neon-high",
      modelName: "Gemini 4 Neon (High)",
      input: 5_000,
      cache: 45_000,
      output: 1_000,
      timestampMs: nowMs - 1_800_000,
    });

    // 写入官方 live-quota.json（归属 self@example.com）
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(stateRoot, "live-quota.json"),
      JSON.stringify({
        updatedAt: new Date(nowMs - 60_000).toISOString(),
        accountEmail: "self@example.com",
        pools: {
          "pool:gemini": {
            remainingPct: 62.1,
            resetTime: "2026-12-03T07:05:28Z",
            updatedAt: new Date(nowMs - 60_000).toISOString(),
          },
          "pool:claude": {
            remainingPct: 96.4,
            resetTime: "2026-12-01T23:55:17Z",
            updatedAt: new Date(nowMs - 60_000).toISOString(),
          },
        },
      })
    );

    const discovered = discoverLocalDataSources({ homeDir, t3UserdataDir: t3Root, stateRootDir: stateRoot });
    expect(discovered).toHaveLength(2);
    const selfSrc = discovered.find((s) => s.id === "t3:self_t3");
    const workSrc = discovered.find((s) => s.id === "t3:work_t3");
    expect(selfSrc?.mergedKinds).toEqual(["t3", "native"]);
    expect(selfSrc?.extraDataDirs).toEqual([nativeAppDir, nativeCliDir]);
    expect(selfSrc?.liveQuotaPath).toBe(path.join(stateRoot, "live-quota.json"));
    expect(workSrc?.liveQuotaPath).toBeUndefined();

    const service = createMultiSourceTelemetryService("", undefined, {
      homeDir,
      t3UserdataDir: t3Root,
      stateRootDir: stateRoot,
    });

    // 1. 合并后的 Personal Acct 汇总 3 个目录全部 1,173,000 tokens，并精准携带实时周剩百分比；Work Acct 绝不串号
    const allSummary = service.getSummary({ source: "all", cycle: "7d", model: "pool:gemini", nowMs });
    expect(allSummary.sources).toHaveLength(2);
    const selfCard = allSummary.sources?.find((s) => s.id === "t3:self_t3");
    const workCard = allSummary.sources?.find((s) => s.id === "t3:work_t3");
    expect(selfCard?.totalTokens).toBe(1_020_000 + 102_000 + 51_000);
    expect(selfCard?.mergedKinds).toEqual(["t3", "native"]);
    expect(selfCard?.weeklyQuota?.gemini?.remainingPct).toBe(62.1);
    expect(selfCard?.weeklyQuota?.gemini?.source).toBe("live");
    expect(selfCard?.weeklyQuota?.claude?.remainingPct).toBe(96.4);
    expect(workCard?.weeklyQuota).toBeUndefined();

    // 2. 单账号切到 Personal Acct 时，liveQuota 的采样分母 poolTokensAtSample 覆盖三目录合并后的全部消耗
    const selfSummary = service.getSummary({ source: "t3:self_t3", cycle: "7d", model: "pool:gemini", nowMs });
    expect(selfSummary.liveQuota?.["pool:gemini"]?.remainingPct).toBe(62.1);
    expect(selfSummary.liveQuota?.["pool:gemini"]?.poolTokensAtSample).toBe(1_020_000 + 102_000 + 51_000);

    // 3. Work Acct 手工校准一次后，顶部卡片也实时展示 calibrated 周剩百分比
    const workSummary = service.getSummary({ source: "t3:work_t3", cycle: "7d", model: "pool:gemini", nowMs });
    expect(workSummary.liveQuota).toBeUndefined();
    const winStart = workSummary.quotaWindow!.windowStart;
    service.setCalibration?.(
      `pool:gemini:${winStart}`,
      {
        remainingPct: 75,
        calibratedCostUsd: workSummary.totals.estimatedCostUsd,
        calibratedTokens: workSummary.totals.totalTokens,
        calibratedAt: new Date(nowMs - 30_000).toISOString(),
      },
      { source: "manual" },
      "t3:work_t3"
    );
    const afterManual = service.getSummary({ source: "all", cycle: "7d", model: "pool:gemini", nowMs });
    const workCardAfter = afterManual.sources?.find((s) => s.id === "t3:work_t3");
    expect(workCardAfter?.weeklyQuota?.gemini?.source).toBe("calibrated");
    expect(workCardAfter?.weeklyQuota?.gemini?.remainingPct).toBe(75);
  });
});
