/**
 * Input: vitest 断言原语、node:fs、node:os、node:path、node:sqlite，以及 ../server/scanner 与 ../server/aggregator。
 * Output: 校验 T3 worktree、git worktree、Swarm 子代理工作树及临时/scratch 目录自动归并到正式项目名的端到端行为。
 * Pos: 工作区名称归一化与项目去噪专项单测（tests/workspaceNormalize.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryService } from "../server/aggregator";
import { parseWorkspaceUris } from "../server/scanner";

const createdDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
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
    const mainRepo = path.join(sandbox, "比稿--轻文化");
    const wtDir = path.join(sandbox, ".t3", "worktrees", "比稿--轻文化", "t3-e6a34486-386339c26e802b93");
    fs.mkdirSync(path.join(mainRepo, ".git", "worktrees", "t3-e6a34486-386339c26e802b93"), { recursive: true });
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(
      path.join(wtDir, ".git"),
      `gitdir: ${path.join(mainRepo, ".git", "worktrees", "t3-e6a34486-386339c26e802b93")}\n`
    );

    const parsed = parseWorkspaceUris(JSON.stringify([`file://${encodeURI(wtDir)}`]));
    expect(parsed.workspaceName).toBe("比稿--轻文化");
    expect(parsed.workspacePath).toBe(mainRepo);
  });

  it("extracts official project name from deleted T3 worktree paths", () => {
    const uri = "file:///Users/demo/.t3/worktrees/hajimi_tok/t3-17f97585-68ff3fb86b8374b3";
    const parsed = parseWorkspaceUris(JSON.stringify([uri]));
    expect(parsed.workspaceName).toBe("hajimi_tok");
  });

  it("collapses macOS temp dirs, t3 setup probes, and brain scratch dirs into (临时/测试工作区)", () => {
    const samples = [
      "file:///var/folders/m7/nvwypzm13hs3yj_yzr3173dr0000gn/T/t3-antigravity-setup-vWMKnd",
      "file:///var/folders/m7/nvwypzm13hs3yj_yzr3173dr0000gn/T/tmp_7o5wfc3",
      "file:///var/folders/m7/nvwypzm13hs3yj_yzr3173dr0000gn/T/agy-rule-check-qobdebk6",
      "file:///private/tmp",
      "file:///Users/demo/.gemini/antigravity/brain/89bcae13-4191-42c7-ad0c-676eb7390ebd/scratch/hook-test",
    ];
    for (const uri of samples) {
      expect(parseWorkspaceUris(JSON.stringify([uri])).workspaceName).toBe("(临时/测试工作区)");
    }
    // Named project under /tmp/ws1 stays intact for backwards compatibility
    expect(parseWorkspaceUris(JSON.stringify(["file:///tmp/ws1"])).workspaceName).toBe("ws1");
  });
});

describe("scanner parent-project inheritance for Swarm workers and aggregation", () => {
  it("merges Swarm workers and T3 worktrees into parent projects and collapses orphan Swarm / temp dirs", () => {
    const dataDir = makeTempDir("hajimi-scan-norm-");
    fs.mkdirSync(path.join(dataDir, "conversations"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "brain"), { recursive: true });

    const db = new DatabaseSync(path.join(dataDir, "conversation_summaries.db"));
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

    const coordId = "7577917e-99db-41cd-8b4e-84db882db24f";
    const swarmChildId = "72d8fba2-afc9-4dce-9199-0185ac9846b5";
    const swarmPathOnlyId = "bab5cf27-5e7f-4514-86be-62599298c58c";
    const orphanSwarmId = "11111111-2222-3333-4444-555555555555";
    const t3WtConvId = "22222222-3333-4444-5555-666666666666";
    const setupProbeId = "33333333-4444-5555-6666-777777777777";

    const ins = db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run(coordId, "主会话", 2, "2026-11-28T05:00:00Z", JSON.stringify(["file:///Users/demo/Cursor/jiesong_system"]), "done", "", "", 0);
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
      JSON.stringify(["file:///Users/demo/.t3/worktrees/jiesong_system/t3-e6a34486-386339c26e802b93"]),
      "done",
      "",
      "",
      0
    );
    ins.run(
      setupProbeId,
      "Setup Probe",
      1,
      "2026-11-28T05:05:00Z",
      JSON.stringify(["file:///var/folders/m7/xyz/T/t3-antigravity-setup-vWMKnd"]),
      "done",
      "",
      "",
      0
    );
    db.close();

    const writeStep = (id: string, ts: string, tokens: number) => {
      const logDir = path.join(dataDir, "brain", id, ".system_generated", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, "transcript.jsonl"),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: ts,
          model: "gemini-4-neon",
          input_tokens: tokens,
          cache_read_tokens: 0,
          output_tokens: 100,
        }) + "\n"
      );
    };
    writeStep(coordId, "2026-11-28T05:00:00Z", 1000);
    writeStep(swarmChildId, "2026-11-28T05:01:00Z", 2000);
    writeStep(swarmPathOnlyId, "2026-11-28T05:02:00Z", 3000);
    writeStep(orphanSwarmId, "2026-11-28T05:03:00Z", 400);
    writeStep(t3WtConvId, "2026-11-28T05:04:00Z", 4000);
    writeStep(setupProbeId, "2026-11-28T05:05:00Z", 100);

    const service = createTelemetryService(dataDir);
    const summary = service.getSummary({ cycle: "all" });

    const wsNames = summary.byWorkspace.map((w) => w.workspaceName).sort();
    expect(wsNames).toEqual(["(临时/测试工作区)", "jiesong_system"]);

    const jiesong = summary.byWorkspace.find((w) => w.workspaceName === "jiesong_system")!;
    expect(jiesong.conversationCount).toBe(4);
    expect(jiesong.inputTokens).toBe(1000 + 2000 + 3000 + 4000);

    const tempWs = summary.byWorkspace.find((w) => w.workspaceName === "(临时/测试工作区)")!;
    expect(tempWs.conversationCount).toBe(2);
    expect(tempWs.inputTokens).toBe(400 + 100);
  });
});
