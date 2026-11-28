/**
 * Input: vitest 断言原语、node:fs、node:os、node:path、node:sqlite，以及 ../server/{scanner,aggregator,multiSource} 与 ../src/lib/format。
 * Output: 校验 worktree/Swarm 项目归并、未绑定与临时目录合并为「临时对话」、空壳/老 .pb 会话过滤、跨源去重及前端单价重算工作区一致性。
 * Pos: 工作区名称归一化、空壳会话治理与跨源去重专项单测（tests/workspaceNormalize.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryService } from "../server/aggregator";
import { createMultiSourceTelemetryService } from "../server/multiSource";
import { createTelemetryScanner, parseWorkspaceUris, TEMP_CHAT_WORKSPACE } from "../server/scanner";
import { resolveScanCachePath } from "../server/scanCache";
import { createT3ThreadIndex } from "../server/t3Threads";
import { extractTodayCallSummary } from "../src/components/DailyUsageCard";
import { groupByMainConversation } from "../src/lib/conversationGroups";

const createdDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function createSummaryTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text primary key,
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
}

function writeJsonlStep(dataDir: string, id: string, ts: string, inputTokens: number): void {
  const logDir = path.join(dataDir, "brain", id, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "transcript.jsonl"),
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      created_at: ts,
      model: "gemini-4-neon",
      input_tokens: inputTokens,
      cache_read_tokens: 0,
      output_tokens: 100,
    }) + "\n"
  );
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseWorkspaceUris worktree & temp normalization", () => {
  it("resolves live git worktree .git pointer back to main repository name and path", () => {
    const sandbox = makeTempDir("hajimi-wt-test-");
    const mainRepo = path.join(sandbox, "project-alpha");
    const wtDir = path.join(sandbox, ".t3", "worktrees", "project-alpha", "t3-e6a34486-386339c26e802b93");
    fs.mkdirSync(path.join(mainRepo, ".git", "worktrees", "t3-e6a34486-386339c26e802b93"), { recursive: true });
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(
      path.join(wtDir, ".git"),
      `gitdir: ${path.join(mainRepo, ".git", "worktrees", "t3-e6a34486-386339c26e802b93")}\n`
    );

    const parsed = parseWorkspaceUris(JSON.stringify([`file://${encodeURI(wtDir)}`]));
    expect(parsed.workspaceName).toBe("project-alpha");
    expect(parsed.workspacePath).toBe(mainRepo);
  });

  it("extracts official project name from deleted T3 worktree paths", () => {
    const uri = "file:///Users/demo/.t3/worktrees/hajimi_tok/t3-17f97585-68ff3fb86b8374b3";
    const parsed = parseWorkspaceUris(JSON.stringify([uri]));
    expect(parsed.workspaceName).toBe("hajimi_tok");
  });

  it("merges unbound, macOS temp dirs, t3 setup probes, and brain scratch dirs into 临时对话", () => {
    expect(parseWorkspaceUris("").workspaceName).toBe(TEMP_CHAT_WORKSPACE);
    expect(parseWorkspaceUris("[]").workspaceName).toBe(TEMP_CHAT_WORKSPACE);
    const samples = [
      "file:///var/folders/m7/nvwypzm13hs3yj_yzr3173dr0000gn/T/t3-antigravity-setup-vWMKnd",
      "file:///var/folders/m7/nvwypzm13hs3yj_yzr3173dr0000gn/T/tmp_7o5wfc3",
      "file:///var/folders/m7/nvwypzm13hs3yj_yzr3173dr0000gn/T/agy-rule-check-qobdebk6",
      "file:///private/tmp",
      "file:///Users/demo/.gemini/antigravity/brain/89bcae13-4191-42c7-ad0c-676eb7390ebd/scratch/hook-test",
    ];
    for (const uri of samples) {
      expect(parseWorkspaceUris(JSON.stringify([uri])).workspaceName).toBe(TEMP_CHAT_WORKSPACE);
    }
    // Named project under /tmp/ws1 stays intact for backwards compatibility
    expect(parseWorkspaceUris(JSON.stringify(["file:///tmp/ws1"])).workspaceName).toBe("ws1");
  });
});

describe("scanner workspace normalization, empty-shell filtering, and cross-source dedup", () => {
  it("merges Swarm/T3 worktrees, collapses unbound+temp into 临时对话, drops 0-call shells while keeping parents of active subagents", () => {
    const dataDir = makeTempDir("hajimi-scan-norm-");
    fs.mkdirSync(path.join(dataDir, "conversations"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "brain"), { recursive: true });

    const db = new DatabaseSync(path.join(dataDir, "conversation_summaries.db"));
    createSummaryTable(db);

    const coordId = "7577917e-99db-41cd-8b4e-84db882db24f";
    const swarmChildId = "72d8fba2-afc9-4dce-9199-0185ac9846b5";
    const swarmPathOnlyId = "bab5cf27-5e7f-4514-86be-62599298c58c";
    const orphanSwarmId = "11111111-2222-3333-4444-555555555555";
    const t3WtConvId = "22222222-3333-4444-5555-666666666666";
    const setupProbeActiveId = "33333333-4444-5555-6666-777777777777";
    const unboundChatId = "44444444-5555-6666-7777-888888888888";
    const zeroShellProbeId = "55555555-6666-7777-8888-999999999999";
    const legacyPbProjectId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const zeroParentWithChildId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const activeChildOfZeroParentId = "88888888-9999-aaaa-bbbb-cccccccccccc";

    const ins = db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run(coordId, "主会话", 2, "2026-11-28T05:00:00Z", JSON.stringify(["file:///Users/demo/Cursor/demo-app"]), "done", "", "", 0);
    ins.run(
      swarmChildId,
      "",
      2,
      "2026-11-28T05:01:00Z",
      JSON.stringify([`file:///Users/demo/.t3/userdata/providers/antigravity/abc/antigravity-acp/worktrees/${coordId}/swarm-dev-frontend-ux-352dff9a`]),
      "done",
      "dev-frontend-ux",
      coordId,
      1
    );
    ins.run(
      swarmPathOnlyId,
      "独立扫描到的 Swarm 成员",
      2,
      "2026-11-28T05:02:00Z",
      JSON.stringify([`file:///Users/demo/.t3/userdata/providers/antigravity/abc/antigravity-acp/worktrees/${coordId}/swarm-dev-sec-ops-fb1d1f2d`]),
      "done",
      "dev-sec-ops",
      "",
      1
    );
    ins.run(
      orphanSwarmId,
      "孤儿 Swarm",
      1,
      "2026-11-28T05:03:00Z",
      JSON.stringify(["file:///Users/demo/.t3/userdata/providers/antigravity/abc/antigravity-acp/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/swarm-orphan-1234abcd"]),
      "done",
      "orphan",
      "",
      1
    );
    ins.run(
      t3WtConvId,
      "T3 分支任务",
      2,
      "2026-11-28T05:04:00Z",
      JSON.stringify(["file:///Users/demo/.t3/worktrees/demo-app/t3-e6a34486-386339c26e802b93"]),
      "done",
      "",
      "",
      0
    );
    ins.run(
      setupProbeActiveId,
      "Hook Test",
      1,
      "2026-11-28T05:05:00Z",
      JSON.stringify(["file:///var/folders/m7/xyz/T/agy-rule-check-qobdebk6"]),
      "done",
      "",
      "",
      0
    );
    ins.run(unboundChatId, "原生随手聊", 2, "2026-11-28T05:06:00Z", "", "done", "", "", 0);
    // 0-call system probe with Go zero time -> must be dropped
    ins.run(
      zeroShellProbeId,
      "",
      0,
      "0001-01-01 00:00:00+00:00",
      JSON.stringify(["file:///var/folders/m7/xyz/T/t3-antigravity-setup-vWMKnd"]),
      "CASCADE_RUN_STATUS_IDLE",
      "",
      "",
      0
    );
    // Legacy .pb index-only project with 0 calls / 0 tokens -> must be dropped
    ins.run(
      legacyPbProjectId,
      "",
      63,
      "2026-03-08 10:19:48+00:00",
      JSON.stringify(["file:///Users/demo/Cursor/legacy_app"]),
      "CASCADE_RUN_STATUS_IDLE",
      "",
      "",
      0
    );
    // 0-call parent that HAS an active subagent -> parent must be preserved
    ins.run(
      zeroParentWithChildId,
      "空壳父会话",
      1,
      "2026-11-28T05:07:00Z",
      JSON.stringify(["file:///Users/demo/Cursor/demo-app"]),
      "done",
      "",
      "",
      0
    );
    ins.run(
      activeChildOfZeroParentId,
      "",
      1,
      "2026-11-28T05:08:00Z",
      "",
      "done",
      "research",
      zeroParentWithChildId,
      1
    );
    db.close();

    writeJsonlStep(dataDir, coordId, "2026-11-28T05:00:00Z", 1000);
    writeJsonlStep(dataDir, swarmChildId, "2026-11-28T05:01:00Z", 2000);
    writeJsonlStep(dataDir, swarmPathOnlyId, "2026-11-28T05:02:00Z", 3000);
    writeJsonlStep(dataDir, orphanSwarmId, "2026-11-28T05:03:00Z", 400);
    writeJsonlStep(dataDir, t3WtConvId, "2026-11-28T05:04:00Z", 4000);
    writeJsonlStep(dataDir, setupProbeActiveId, "2026-11-28T05:05:00Z", 100);
    writeJsonlStep(dataDir, unboundChatId, "2026-11-28T05:06:00Z", 500);
    writeJsonlStep(dataDir, activeChildOfZeroParentId, "2026-11-28T05:08:00Z", 600);

    const service = createTelemetryService(dataDir, undefined, { isolated: true });
    const summary = service.getSummary({ cycle: "all" });

    const wsNames = summary.byWorkspace.map((w) => w.workspaceName).sort();
    expect(wsNames).toEqual(["demo-app", TEMP_CHAT_WORKSPACE]);
    expect(summary.availableWorkspaces.sort()).toEqual(["demo-app", TEMP_CHAT_WORKSPACE]);

    // Legacy 0-token project and 0001-01-01 setup probe are gone
    expect(summary.conversations.some((c) => c.conversationId === zeroShellProbeId)).toBe(false);
    expect(summary.conversations.some((c) => c.conversationId === legacyPbProjectId)).toBe(false);
    // Zero-call parent of active child stays and passes project name down
    expect(summary.conversations.some((c) => c.conversationId === zeroParentWithChildId)).toBe(true);

    const demoApp = summary.byWorkspace.find((w) => w.workspaceName === "demo-app")!;
    expect(demoApp.conversationCount).toBe(6);
    expect(demoApp.inputTokens).toBe(1000 + 2000 + 3000 + 4000 + 600);

    const tempWs = summary.byWorkspace.find((w) => w.workspaceName === TEMP_CHAT_WORKSPACE)!;
    expect(tempWs.conversationCount).toBe(3);
    expect(tempWs.inputTokens).toBe(400 + 100 + 500);
  });

  it("deduplicates identical conversationId across merged multi-account sources", () => {
    const dirA = makeTempDir("hajimi-dedup-a-");
    const dirB = makeTempDir("hajimi-dedup-b-");
    const sharedId = "99999999-aaaa-bbbb-cccc-dddddddddddd";

    for (const [dir, status, tokens] of [
      [dirA, "unknown", 500],
      [dirB, "CASCADE_RUN_STATUS_IDLE", 1500],
    ] as const) {
      fs.mkdirSync(path.join(dir, "brain"), { recursive: true });
      const db = new DatabaseSync(path.join(dir, "conversation_summaries.db"));
      createSummaryTable(db);
      db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        sharedId,
        "共享历史会话",
        1,
        "2026-11-28T06:00:00Z",
        JSON.stringify(["file:///Users/demo/Cursor/hajimi_tok"]),
        status,
        "",
        "",
        0
      );
      db.close();
      writeJsonlStep(dir, sharedId, "2026-11-28T06:00:00Z", tokens);
    }

    const multi = createMultiSourceTelemetryService(undefined, undefined, {
      isolated: true,
      sources: [
        { id: "src:a", label: "A", kind: "t3", dataDir: dirA },
        { id: "src:b", label: "B", kind: "t3", dataDir: dirB },
      ],
    });
    const all = multi.getSummary({ cycle: "all" });
    expect(all.conversations).toHaveLength(1);
    expect(all.conversations[0].inputTokens).toBe(1500);
    expect(all.conversations[0].sourceLabel).toBe("B");
  });

  it("links T3 statev2.sqlite fresh_session runs to the same thread, applies official T3 title, and folds them into 1 group", () => {
    const dataDir = makeTempDir("hajimi-t3-runs-");
    const t3Dir = makeTempDir("hajimi-t3-state-");
    const run1 = "aaaa1111-1111-4111-8111-111111111111";
    const run2 = "bbbb2222-2222-4222-8222-222222222222";
    const sub1 = "cccc3333-3333-4333-8333-333333333333";

    fs.mkdirSync(path.join(dataDir, "brain"), { recursive: true });
    const sumDb = new DatabaseSync(path.join(dataDir, "conversation_summaries.db"));
    createSummaryTable(sumDb);
    const ins = sumDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run(run1, "定时日报生成任务", 2, "2026-11-27T10:00:00Z", JSON.stringify(["file:///Users/demo/project-alpha"]), "done", "", "", 0);
    ins.run(run2, "定時日報生成任務", 2, "2026-11-28T08:00:00Z", JSON.stringify(["file:///Users/demo/project-alpha"]), "done", "", "", 0);
    ins.run(sub1, "", 1, "2026-11-28T08:01:00Z", JSON.stringify(["file:///Users/demo/project-alpha"]), "done", "research", run2, 1);
    sumDb.close();

    writeJsonlStep(dataDir, run1, "2026-11-27T10:00:00Z", 1000);
    writeJsonlStep(dataDir, run2, "2026-11-28T08:00:00Z", 2000);
    writeJsonlStep(dataDir, sub1, "2026-11-28T08:01:00Z", 500);

    const stateDb = new DatabaseSync(path.join(t3Dir, "statev2.sqlite"));
    stateDb.exec(`
      CREATE TABLE orchestration_v2_projection_threads (thread_id text primary key, title text);
      CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id text primary key, thread_id text, payload_json text);
      CREATE TABLE scheduled_tasks (task_id text primary key, title text, thread_id text);
    `);
    const sharedThread = "thread:project:demo:84235c1b-faf6-49b8-9bb2-952dda52db72";
    stateDb.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run(
      sharedThread,
      "每日增量巡检任务"
    );
    stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)").run(
      `provider-thread:provider:antigravity:native-thread:${run1}`,
      sharedThread,
      JSON.stringify({ nativeThreadRef: { driver: "antigravity", nativeId: run1 } })
    );
    stateDb.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)").run(
      "provider-thread:provider:antigravity:native-thread:pending:2",
      sharedThread,
      JSON.stringify({ nativeThreadRef: { driver: "antigravity", nativeId: run2 } })
    );
    stateDb.close();

    const svc = createTelemetryService(dataDir, undefined, { isolated: true, t3UserdataDir: t3Dir });
    const summary = svc.getSummary({ cycle: "all" });
    expect(summary.conversations).toHaveLength(3);

    const c1 = summary.conversations.find((c) => c.conversationId === run1)!;
    const c2 = summary.conversations.find((c) => c.conversationId === run2)!;
    expect(c1.title).toBe("每日增量巡检任务");
    expect(c1.runTitle).toBe("定时日报生成任务");
    expect(c2.title).toBe("每日增量巡检任务");
    expect(c2.runTitle).toBe("定時日報生成任務");
    expect(c1.t3ThreadId).toBe(c2.t3ThreadId);
    expect(c1.t3ThreadId).toMatch(/^t3-[0-9a-f]{12}$/);

    const groups = groupByMainConversation(summary.conversations);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.conversationId).toBe(run2);
    expect(groups[0].siblingRunCount).toBe(2);
    expect(groups[0].subagentChildCount).toBe(1);
    expect(groups[0].children).toHaveLength(2);
    expect(groups[0].rolledInputTokens).toBe(1000 + 2000 + 500);
  });

  it("reads live WAL+SHM statev2.sqlite via zero-copy readOnly path without invoking temp snapshot copy", () => {
    const t3Dir = makeTempDir("hajimi-t3-wal-zero-copy-");
    const dbPath = path.join(t3Dir, "statev2.sqlite");
    const runId = "dddd4444-4444-4444-8444-444444444444";

    const writer = new DatabaseSync(dbPath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE orchestration_v2_projection_threads (thread_id text primary key, title text);
      CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id text primary key, thread_id text, payload_json text);
      CREATE TABLE scheduled_tasks (task_id text primary key, title text, thread_id text);
    `);
    writer.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run(
      "thread:project:demo:wal-live",
      "活跃 WAL 正式标题"
    );
    writer.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)").run(
      `provider-thread:provider:antigravity:native-thread:${runId}`,
      "thread:project:demo:wal-live",
      JSON.stringify({ nativeThreadRef: { driver: "antigravity", nativeId: runId } })
    );

    try {
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);

      let fallbackCalls = 0;
      const idx = createT3ThreadIndex(() => {
        fallbackCalls += 1;
        throw new Error("should not fall back to temp snapshot copy when live WAL+SHM is readable");
      }, t3Dir);
      const map = idx.load(true);
      expect(fallbackCalls).toBe(0);
      expect(map.get(runId)?.t3ThreadTitle).toBe("活跃 WAL 正式标题");
    } finally {
      writer.close();
    }
  });

  it("strictly caps callTimeline to nodeLimit even on high-volume today while preserving full today totals", () => {
    const dataDir = makeTempDir("hajimi-nodelimit-today-");
    const convId = "eeee5555-5555-4555-8555-555555555555";
    const now = new Date();
    const baseMs = now.getTime() - 10 * 60_000;
    const logDir = path.join(dataDir, "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        step_index: i + 1,
        type: "PLANNER_RESPONSE",
        created_at: new Date(baseMs + i * 60_000).toISOString(),
        input_tokens: 1000,
        cache_read_tokens: 4000,
        output_tokens: 200,
      })
    );
    fs.writeFileSync(path.join(logDir, "transcript.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const svc = createTelemetryService(dataDir, undefined, { isolated: true });
    const summary = svc.getSummary({ cycle: "7d", nodeLimit: 2, nowMs: now.getTime() });
    expect(summary.callTimeline).toHaveLength(2);
    expect(summary.totals.callCount).toBe(5);

    const { todayNodes, todayByModel, todayTotalCalls } = extractTodayCallSummary(
      summary.callTimeline,
      summary.byModel,
      summary.dailyTrend
    );
    expect(todayNodes).toHaveLength(2);
    expect(todayTotalCalls).toBe(5);
    expect(todayByModel.reduce((acc, m) => acc + m.totalTokens, 0)).toBe(5 * 5200);
  });

  it("fast-scans large GENERIC JSONL lines without full JSON.parse while preserving stepCount and timestamps", () => {
    const dataDir = makeTempDir("hajimi-jsonl-fast-");
    const convId = "ffff6666-6666-4666-8666-666666666666";
    const logDir = path.join(dataDir, "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const hugeToolOutput = "x".repeat(4096);
    const jsonlFile = path.join(logDir, "transcript.jsonl");
    fs.writeFileSync(
      jsonlFile,
      [
        JSON.stringify({ step_index: 1, type: "USER_INPUT", created_at: "2026-11-28T01:00:00Z", content: "hello fast scan" }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", created_at: "2026-11-28T01:01:00Z", input_tokens: 1200, cache_read_tokens: 800, output_tokens: 100 }),
        JSON.stringify({ step_index: 9, type: "GENERIC", created_at: "2026-11-28T01:05:00Z", content: hugeToolOutput }),
      ].join("\n"),
      "utf8"
    );
    const oldTime = new Date("2026-11-28T00:00:00Z");
    fs.utimesSync(jsonlFile, oldTime, oldTime);

    const svc = createTelemetryService(dataDir, undefined, { isolated: true });
    const summary = svc.getSummary({ cycle: "all" });
    expect(summary.conversations).toHaveLength(1);
    const conv = summary.conversations[0];
    expect(conv.callCount).toBe(1);
    expect(conv.stepCount).toBe(10);
    expect(conv.lastModifiedAt).toBe("2026-11-28T01:05:00.000Z");
    expect(conv.firstPromptPreview).toBe("hello fast scan");
  });

  it("persists scan cache across fresh scanner instances and auto-invalidates on pricing change", () => {
    const dataDir = makeTempDir("hajimi-scan-cache-data-");
    const stateDir = makeTempDir("hajimi-scan-cache-state-");
    const convId = "12121212-1212-4121-8121-121212121212";
    writeJsonlStep(dataDir, convId, "2026-11-28T02:00:00Z", 1_000_000);

    const cachePath = resolveScanCachePath(stateDir, dataDir);
    const rateA = [{ modelPattern: "*", label: "A", inputPerMillion: 10, cacheReadPerMillion: 1, outputPerMillion: 20 }];
    const rateB = [{ modelPattern: "*", label: "B", inputPerMillion: 30, cacheReadPerMillion: 3, outputPerMillion: 60 }];

    // 1. 首扫落盘生成 .json.gz 缓存
    const sc1 = createTelemetryScanner(dataDir, rateA, null, undefined, cachePath);
    const snap1 = sc1.scan(false);
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(snap1.conversations[0].estimatedCostUsd).toBeCloseTo(10 + (100 / 1_000_000) * 20, 6);

    // 2. 新扫描实例按同费率命中磁盘缓存（即使不重新解析也保留完整明细）
    const sc2 = createTelemetryScanner(dataDir, rateA, null, undefined, cachePath);
    const snap2 = sc2.scan(false);
    expect(snap2.conversations[0].inputTokens).toBe(1_000_000);
    expect(snap2.conversations[0].estimatedCostUsd).toBeCloseTo(snap1.conversations[0].estimatedCostUsd, 6);

    // 3. 费率变更时自动失效旧磁盘缓存并按新费率重算成本
    const sc3 = createTelemetryScanner(dataDir, rateB, null, undefined, cachePath);
    const snap3 = sc3.scan(false);
    expect(snap3.conversations[0].estimatedCostUsd).toBeCloseTo(30 + (100 / 1_000_000) * 60, 6);
  });
});
