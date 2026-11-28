/**
 * Input: vitest 断言工具、node:fs/os/path/child_process，以及 scripts/compact-reminder-hook.mjs 导出函数。
 * Output: 覆盖 400K 上下文软提醒 Hook 的触发阈值、零熔断、防宿主 metadata panic 回归、Stop 兜底补卡与防死循环、周期去重、CHECKPOINT/回落重置、跨块 UTF-8 边界、CLI 管道及无侵入安装卸载测试。
 * Pos: 可选 400K 压缩软提醒 Hook 单元测试套件（tests/compactReminder.test.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_ABS = path.resolve(process.cwd(), "scripts/compact-reminder-hook.mjs");

interface HookModule {
  HOOK_KEY: string;
  REMINDER_MARKER: string;
  STOP_REMINDER_MARKER: string;
  CARD_HEADING_PREFIX: string;
  handlePreInvocation: (payload: Record<string, unknown>) => Record<string, unknown>;
  handleStop: (payload: Record<string, unknown>) => Record<string, unknown>;
  installCompactReminderHook: (opts?: { hooksPath?: string; expectedCmd?: string }) => {
    installed: boolean;
    reason: string;
  };
  uninstallCompactReminderHook: (opts?: { hooksPath?: string; expectedCmd?: string }) => {
    removed: boolean;
    reason: string;
  };
}

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(dir: string, name: string, rows: Array<Record<string, unknown> | string>): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(
    filePath,
    `${rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("400K Context Compact Soft-Reminder Hook", () => {
  it("triggers once at >=400K without termination, suppresses repeats until CHECKPOINT/drop, and handles UTF-8 chunk boundaries", async () => {
    const mod = (await import(pathToFileURL(SCRIPT_ABS).href)) as HookModule;
    const dir = mkTmp("hamiji-compact-hook-");

    // 1. 缺失/损坏/未达阈值均静默返回空对象
    expect(mod.handlePreInvocation({ transcriptPath: path.join(dir, "missing.jsonl") })).toEqual({});
    const badPath = writeJsonl(dir, "bad.jsonl", ["{broken"]);
    expect(mod.handlePreInvocation({ transcriptPath: badPath })).toEqual({});
    const underPath = writeJsonl(dir, "under.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 99_999, cache_read_tokens: 300_000 },
    ]);
    expect(mod.handlePreInvocation({ transcriptPath: underPath, modelName: "gemini-4-neon-xhigh" })).toEqual({});

    // 2. 首次跨过 400K：输出纯 systemMessage 结尾指令（省略 metadata 防 Antigravity scrubMessage panic），且绝不熔断（terminationBehavior === ""）
    const crossPath = writeJsonl(dir, "cross.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 400_000 },
    ]);
    const res1 = mod.handlePreInvocation({ transcriptPath: crossPath, modelName: "gemini-4-neon-xhigh" }) as {
      terminationBehavior: string;
      injectSteps: Array<{ systemMessage: { systemMessage: string; metadata?: Record<string, string> } }>;
    };
    expect(res1.terminationBehavior).toBe("");
    expect(res1.injectSteps).toHaveLength(1);
    expect(res1.injectSteps[0].systemMessage.systemMessage.startsWith(mod.REMINDER_MARKER)).toBe(true);
    expect(res1.injectSteps[0].systemMessage.systemMessage).toContain("405K / 512K");
    expect(res1.injectSteps[0].systemMessage.metadata).toBeUndefined();

    // 3. 同压缩周期涨到 470K 或立即重试均不重复提醒
    const repeatPath = writeJsonl(dir, "repeat.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 400_000 },
      { type: "SYSTEM_MESSAGE", content: `wrapper\n${mod.REMINDER_MARKER} sent` },
      { type: "PLANNER_RESPONSE", input_tokens: 20_000, cache_read_tokens: 450_000 },
    ]);
    expect(mod.handlePreInvocation({ transcriptPath: repeatPath, modelName: "gemini-4-neon-xhigh" })).toEqual({});

    const retryPath = writeJsonl(dir, "retry.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 405_000 },
      { type: "SYSTEM_MESSAGE", content: `${mod.REMINDER_MARKER} sent` },
    ]);
    expect(mod.handlePreInvocation({ transcriptPath: retryPath, modelName: "gemini-4-neon-xhigh" })).toEqual({});

    // 4. CHECKPOINT 压缩后下一周期再达 400K 时重新提醒一次；非 Gemini 4 模型不硬拼 / 512K
    const nextCyclePath = writeJsonl(dir, "next.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 400_000 },
      { type: "SYSTEM_MESSAGE", content: `${mod.REMINDER_MARKER} old` },
      { type: "CHECKPOINT", input_tokens: 5_000, cache_read_tokens: 505_000 },
      { type: "PLANNER_RESPONSE", input_tokens: 25_000, cache_read_tokens: 0 },
      { type: "PLANNER_RESPONSE", input_tokens: 10_000, cache_read_tokens: 392_000 },
    ]);
    const res2 = mod.handlePreInvocation({ transcriptPath: nextCyclePath, modelName: "claude-opus-5.5" }) as {
      injectSteps: Array<{ systemMessage: { systemMessage: string; metadata?: Record<string, string> } }>;
    };
    expect(res2.injectSteps).toHaveLength(1);
    expect(res2.injectSteps[0].systemMessage.systemMessage).toContain("402K");
    expect(res2.injectSteps[0].systemMessage.systemMessage).not.toContain("512K");
    expect(res2.injectSteps[0].systemMessage.metadata).toBeUndefined();

    // 5. 超过 256KB 分块且含多字节 UTF-8 中文时仍准确去重
    const bigRows: Array<Record<string, unknown>> = [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 400_000 },
      { type: "SYSTEM_MESSAGE", content: `${mod.REMINDER_MARKER} 中文多字节边界验证` },
    ];
    const pad = "中文日志输出填充内容测试边界".repeat(120);
    for (let i = 0; i < 65; i++) bigRows.push({ type: "GENERIC", content: `${i}:${pad}` });
    bigRows.push({ type: "PLANNER_RESPONSE", input_tokens: 10_000, cache_read_tokens: 455_000 });
    const bigPath = writeJsonl(dir, "big.jsonl", bigRows);
    expect(fs.statSync(bigPath).size).toBeGreaterThan(256 * 1024);
    expect(mod.handlePreInvocation({ transcriptPath: bigPath, modelName: "gemini-4-neon-xhigh" })).toEqual({});

    // 6. CLI stdin 管道端到端调用
    const stdout = execFileSync(process.execPath, [SCRIPT_ABS], {
      input: JSON.stringify({ transcriptPath: crossPath, modelName: "gemini-4-neon-xhigh" }),
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout.trim()) as {
      terminationBehavior: string;
      injectSteps: Array<{ systemMessage: { systemMessage: string; metadata?: Record<string, string> } }>;
    };
    expect(parsed.terminationBehavior).toBe("");
    expect(parsed.injectSteps).toHaveLength(1);
    expect(parsed.injectSteps[0].systemMessage.metadata).toBeUndefined();
    expect(parsed.injectSteps[0].systemMessage.systemMessage).toContain(mod.CARD_HEADING_PREFIX);
  });

  it("uses Stop hook as a single-shot visible-card fallback without looping when model omits the card", async () => {
    const mod = (await import(pathToFileURL(SCRIPT_ABS).href)) as HookModule;
    const dir = mkTmp("hamiji-compact-stop-");

    // 1. PreInvocation 已注入但模型长轮次遗漏卡片：首次 NO_TOOL_CALL (executionNum=0) 触发一次补卡
    const forgotPath = writeJsonl(dir, "forgot.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 410_000, content: "" },
      { type: "SYSTEM_MESSAGE", content: `${mod.REMINDER_MARKER} sent` },
      { type: "PLANNER_RESPONSE", input_tokens: 6_000, cache_read_tokens: 420_000, content: "任务已完成，未附带压缩卡。" },
    ]);
    const stopRes = mod.handleStop({
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false,
      executionNum: 0,
      transcriptPath: forgotPath,
      modelName: "gemini-4-neon-xhigh",
    }) as { decision?: string; reason?: string };
    expect(stopRes.decision).toBe("continue");
    expect(stopRes.reason).toContain(mod.STOP_REMINDER_MARKER);
    expect(stopRes.reason).toContain(`${mod.CARD_HEADING_PREFIX}426K / 512K`);

    // 2. 防死循环硬门禁：executionNum > 0、continuationActive=true、非 NO_TOOL_CALL 均放行停止
    expect(
      mod.handleStop({
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
        continuationActive: false,
        executionNum: 1,
        transcriptPath: forgotPath,
      })
    ).toEqual({});
    expect(
      mod.handleStop({
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
        continuationActive: true,
        executionNum: 0,
        transcriptPath: forgotPath,
      })
    ).toEqual({});
    expect(
      mod.handleStop({
        hookEventName: "Stop",
        terminationReason: "ERROR",
        continuationActive: false,
        executionNum: 0,
        transcriptPath: forgotPath,
      })
    ).toEqual({});

    // 3. 若模型已渲染可见卡片或本周期已触发过 Stop 补卡：零额外调用直接放行
    const renderedPath = writeJsonl(dir, "rendered.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 410_000, content: "" },
      { type: "SYSTEM_MESSAGE", content: `${mod.REMINDER_MARKER} sent` },
      {
        type: "PLANNER_RESPONSE",
        input_tokens: 6_000,
        cache_read_tokens: 420_000,
        content: `已完成。\n### ***${mod.CARD_HEADING_PREFIX}426K / 512K）***\n/compact 保留核心结论`,
      },
    ]);
    expect(
      mod.handleStop({
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
        continuationActive: false,
        executionNum: 0,
        transcriptPath: renderedPath,
      })
    ).toEqual({});

    const stopAlreadySentPath = writeJsonl(dir, "stop-sent.jsonl", [
      { type: "PLANNER_RESPONSE", input_tokens: 5_000, cache_read_tokens: 410_000, content: "done" },
      { type: "SYSTEM_MESSAGE", content: `Stop hook blocked termination: ${mod.STOP_REMINDER_MARKER}` },
      { type: "PLANNER_RESPONSE", input_tokens: 6_000, cache_read_tokens: 420_000, content: "next turn" },
    ]);
    expect(
      mod.handleStop({
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
        continuationActive: false,
        executionNum: 0,
        transcriptPath: stopAlreadySentPath,
      })
    ).toEqual({});

    // 4. CLI 管道路由 hookEventName: "Stop"
    const stopStdout = execFileSync(process.execPath, [SCRIPT_ABS], {
      input: JSON.stringify({
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
        continuationActive: false,
        executionNum: 0,
        transcriptPath: forgotPath,
        modelName: "gemini-4-neon-xhigh",
      }),
      encoding: "utf8",
    });
    const stopParsed = JSON.parse(stopStdout.trim()) as { decision?: string; reason?: string };
    expect(stopParsed.decision).toBe("continue");
    expect(stopParsed.reason).toContain(mod.STOP_REMINDER_MARKER);
  });

  it("installs and uninstalls safely into hooks.json without clobbering existing or custom hooks", async () => {
    const mod = (await import(pathToFileURL(SCRIPT_ABS).href)) as HookModule;
    const dir = mkTmp("hamiji-compact-install-");
    const hooksPath = path.join(dir, "hooks.json");

    // 1. 已有 ponytail Hook 时无侵入合并安装
    fs.writeFileSync(hooksPath, JSON.stringify({ ponytail: { enabled: true, SessionStart: [] } }), "utf8");
    const installed = mod.installCompactReminderHook({ hooksPath });
    expect(installed.installed).toBe(true);
    const afterInstall = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as Record<string, { PreInvocation?: unknown[]; Stop?: unknown[] }>;
    expect(afterInstall.ponytail).toEqual({ enabled: true, SessionStart: [] });
    expect(afterInstall[mod.HOOK_KEY]?.PreInvocation).toHaveLength(1);
    expect(afterInstall[mod.HOOK_KEY]?.Stop).toHaveLength(1);

    // 1.5 旧版仅含 PreInvocation 的本脚本条目可无损升级补齐 Stop（同时保留 ponytail）
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({
        ponytail: { enabled: true, SessionStart: [] },
        [mod.HOOK_KEY]: {
          enabled: true,
          PreInvocation: [{ type: "command", command: `node "${SCRIPT_ABS}"`, timeout: 5 }],
        },
      }),
      "utf8"
    );
    expect(mod.installCompactReminderHook({ hooksPath }).installed).toBe(true);
    const upgraded = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as Record<string, { Stop?: unknown[] }>;
    expect(upgraded[mod.HOOK_KEY]?.Stop).toHaveLength(1);

    // 2. 卸载只删除本 Hook，完整保留 ponytail
    const removed = mod.uninstallCompactReminderHook({ hooksPath });
    expect(removed.removed).toBe(true);
    const afterUninstall = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
    expect(afterUninstall.ponytail).toEqual({ enabled: true, SessionStart: [] });
    expect(mod.HOOK_KEY in afterUninstall).toBe(false);

    // 3. 遇到自定义同名 Hook 或损坏 JSON 拒绝覆盖
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ [mod.HOOK_KEY]: { enabled: true, PreInvocation: [{ type: "command", command: "custom.sh" }] } }),
      "utf8"
    );
    expect(mod.installCompactReminderHook({ hooksPath }).installed).toBe(false);
    expect(mod.uninstallCompactReminderHook({ hooksPath }).removed).toBe(false);

    fs.writeFileSync(hooksPath, "{broken", "utf8");
    expect(mod.installCompactReminderHook({ hooksPath }).installed).toBe(false);
  });
});
