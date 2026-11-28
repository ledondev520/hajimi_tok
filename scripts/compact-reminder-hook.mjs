#!/usr/bin/env node
/**
 * Input: Antigravity PreInvocation / Stop Hook stdin JSON（含 hookEventName、transcriptPath、modelName 等），或命令行参数 --install / --uninstall。
 * Output: 上下文 Prompt（input_tokens + cache_read_tokens）在当前压缩周期首次达到 400K 时，通过 PreInvocation 注入纯 systemMessage 引导模型在回复末尾渲染醒目压缩卡片与 `/compact` 指令（省略 metadata 规避宿主 scrubMessage panic），并由 Stop Hook 兜底确保长轮次遗漏时补发一次可见卡片（绝不死循环、绝不熔断）；支持安全无侵入安装/卸载至 ~/.gemini/config/hooks.json。
 * Pos: Antigravity 全局 400K 上下文压缩软提醒 Hook 脚本（service:install 自动无侵入注册，支持随时卸载）（scripts/compact-reminder-hook.mjs）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_HOOKS_PATH = path.join(os.homedir(), ".gemini", "config", "hooks.json");

export const HOOK_KEY = "context-compact-reminder"; // 注册到 hooks.json 的独立顶级键名
export const REMIND_THRESHOLD_TOKENS = 400_000; // 触发软提醒的 Prompt Token 水位线（400K）
export const REMINDER_MARKER = "[CONTEXT_COMPACT_400K]"; // PreInvocation 写入 systemMessage 的去重标记
export const STOP_REMINDER_MARKER = "[CONTEXT_COMPACT_400K_STOP]"; // Stop 兜底补发卡片的周期去重标记
export const CARD_HEADING_PREFIX = "上下文压缩提醒（已达 "; // 模型实际输出可见卡片的标题前缀（用于检测是否已渲染）

const CYCLE_RESET_TOKENS = 250_000; // 若无显式 CHECKPOINT，Prompt 回落至 250K 以下视为新压缩周期
const CHUNK_BYTES = 256 * 1024; // 逆向分块读取步长（256KB），避免大 transcript 全量读入
const OWNED_HOOK_KEYS = new Set(["enabled", "PreInvocation", "Stop"]);

/** 校验单个 Hook 事件处理器数组是否严格归属本脚本 */
function isOwnedHandlerList(list, expectedCmd) {
  if (!Array.isArray(list) || list.length !== 1) return false;
  const cmd = typeof list[0]?.command === "string" ? list[0].command.trim() : "";
  return cmd === expectedCmd || cmd.includes("compact-reminder-hook.mjs");
}

/** 使用进程+随机唯一临时文件原子落盘 JSON */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

/** 校验 hooks.json 中同名条目是否严格归属本脚本，防止覆盖用户自定义同名 Hook（兼容旧版仅 PreInvocation 条目） */
function isOwnedHookConfig(existing, expectedCmd) {
  if (existing === undefined) return true;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  if (Object.keys(existing).some((k) => !OWNED_HOOK_KEYS.has(k))) return false;
  if (!isOwnedHandlerList(existing.PreInvocation, expectedCmd)) return false;
  if (existing.Stop !== undefined && !isOwnedHandlerList(existing.Stop, expectedCmd)) return false;
  return true;
}

/** 构造统一可见 Markdown 压缩提醒卡片模板（桌面端、T3 Code 桌面/移动端与 CLI 均直接可见） */
export function buildCompactCardMarkdown(usedK, limitSuffix) {
  return [
    "---",
    `### ***${CARD_HEADING_PREFIX}${usedK}K${limitSuffix}）***`,
    "",
    "> [!WARNING]",
    "> ***当前上下文已超过 400K 提醒线。建议立即复制下方 `/compact` 指令压缩续跑，避免拖到约 510K 触顶卡顿或掉缓存冷读（本压缩周期仅提醒一次，不中断当前任务）。***",
    "",
    "```text",
    "/compact 保留<本阶段核心结论、关键文件路径与约束>；接下来继续<下一步明确动作>",
    "```",
    "---",
  ].join("\n");
}

/**
 * 职责：逆向分块扫描 transcript.jsonl 当前压缩周期尾部，提取最新 Prompt Token 及提醒/可见卡片状态。
 * 思路：从 EOF 按 256KB 原始字节块倒扫，按 0x0a 换行切分避免拆碎多字节 UTF-8；遇低于阈值、已双确认、CHECKPOINT 或回落至 250K 以下即提前中止。
 * 参数：transcriptPath - 当前会话 transcript.jsonl 绝对路径；threshold - 提醒阈值（默认 400K）。
 * 返回值：{ latestPrompt: number | null, alreadyReminded: boolean, stopReminded: boolean, cardRendered: boolean }。
 */
export function scanCurrentCycle(transcriptPath, threshold = REMIND_THRESHOLD_TOKENS) {
  const empty = { latestPrompt: null, alreadyReminded: false, stopReminded: false, cardRendered: false };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return empty;
  }

  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const { size } = fs.fstatSync(fd);
    if (size <= 0) return empty;

    let pos = size;
    let carry = Buffer.alloc(0);
    let latestPrompt = null;
    let alreadyReminded = false;
    let stopReminded = false;
    let cardRendered = false;

    while (pos > 0) {
      const readLen = Math.min(CHUNK_BYTES, pos);
      pos -= readLen;
      const chunk = Buffer.allocUnsafe(readLen);
      fs.readSync(fd, chunk, 0, readLen, pos);

      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let text;
      if (pos > 0) {
        // 按原始字节找首个换行符，避免 256KB 块边界切碎多字节 UTF-8 字符
        const nlIdx = combined.indexOf(0x0a);
        if (nlIdx === -1) {
          carry = combined;
          continue;
        }
        carry = combined.subarray(0, nlIdx);
        text = combined.subarray(nlIdx + 1).toString("utf8");
      } else {
        carry = Buffer.alloc(0);
        text = combined.toString("utf8");
      }

      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        if (
          !line.includes('"PLANNER_RESPONSE"') &&
          !line.includes('"SYSTEM_MESSAGE"') &&
          !line.includes('"CHECKPOINT"')
        ) {
          continue;
        }

        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        if (obj.type === "SYSTEM_MESSAGE") {
          if (typeof obj.content === "string") {
            if (obj.content.includes(REMINDER_MARKER)) alreadyReminded = true;
            if (obj.content.includes(STOP_REMINDER_MARKER)) stopReminded = true;
            if (latestPrompt !== null && alreadyReminded && (stopReminded || cardRendered)) {
              return { latestPrompt, alreadyReminded, stopReminded, cardRendered };
            }
          }
          continue;
        }

        if (obj.type === "CHECKPOINT") {
          return { latestPrompt, alreadyReminded, stopReminded, cardRendered };
        }

        if (obj.type === "PLANNER_RESPONSE") {
          if (
            typeof obj.content === "string" &&
            obj.content.includes(CARD_HEADING_PREFIX) &&
            obj.content.includes("/compact")
          ) {
            cardRendered = true;
          }
          const prompt =
            Math.max(0, Number(obj.input_tokens || 0)) +
            Math.max(0, Number(obj.cache_read_tokens || 0));
          if (prompt <= 0) continue;
          if (latestPrompt === null) {
            latestPrompt = prompt;
            if (latestPrompt < threshold) {
              return { latestPrompt, alreadyReminded, stopReminded, cardRendered };
            }
          } else if (prompt < CYCLE_RESET_TOKENS) {
            return { latestPrompt, alreadyReminded, stopReminded, cardRendered };
          }
        }
      }
    }

    return { latestPrompt, alreadyReminded, stopReminded, cardRendered };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 职责：根据 PreInvocation Hook 载荷决定是否输出一次性 400K 纯软提醒（绝不熔断）。
 * 参数：payload - Hook stdin 解析出的 JSON 对象。
 * 返回值：Antigravity Hook 响应对象（空对象或 injectSteps 软提醒）。
 */
export function handlePreInvocation(payload) {
  const transcriptPath = typeof payload?.transcriptPath === "string" ? payload.transcriptPath : "";
  const modelName = typeof payload?.modelName === "string" ? payload.modelName : "";
  const { latestPrompt, alreadyReminded, stopReminded, cardRendered } = scanCurrentCycle(transcriptPath);

  if (alreadyReminded || stopReminded || cardRendered || latestPrompt === null || latestPrompt < REMIND_THRESHOLD_TOKENS) {
    return {};
  }

  const usedK = Math.round(latestPrompt / 1000);
  const limitSuffix = /(?:neon|carbon|argon|hydrogen)/i.test(modelName) ? " / 512K" : "";

  const systemMessage =
    `${REMINDER_MARKER} 当前会话上下文已达 ${usedK}K${limitSuffix}（≥400K 纯软提醒，严禁因此停工、中断或拒答）。` +
    "请正常完成本轮全部工作，并在最终回复的最末尾原样附上以下可见提示卡片（仅把代码块内的 `/compact` 占位内容替换为结合本会话上下文的真实可复制指令）：\n\n" +
    buildCompactCardMarkdown(usedK, limitSuffix);

  // shortcut: 省略 metadata.user_markdown，因 Antigravity 宿主 utils.scrubMessage 会对 map<string,string> panic；改由正文卡片 + Stop 兜底保证可见
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage,
        },
      },
    ],
    terminationBehavior: "",
  };
}

/**
 * 职责：Stop Hook 兜底检查——若本周期已达 400K 但模型在长轮次中遗漏了可见卡片，则在首次正常结束时补发一次独立提醒卡片。
 * 思路：三重防死循环门禁（仅限 NO_TOOL_CALL、严格拦截 executionNum > 0 或 continuationActive、按周期检测已渲染卡片或 STOP 标记）。
 * 参数：payload - Stop Hook stdin JSON 对象。
 * 返回值：{}（放行停止）或 { decision: "continue", reason: string }（补发一次可见卡片）。
 */
export function handleStop(payload) {
  if (payload?.terminationReason !== "NO_TOOL_CALL") return {};
  // Antigravity 实测 continuationActive 在续跑时可能仍为 false，必须同时以 executionNum > 0 硬拦死循环
  if (payload?.continuationActive === true || Number(payload?.executionNum || 0) > 0) return {};

  const transcriptPath = typeof payload?.transcriptPath === "string" ? payload.transcriptPath : "";
  const modelName = typeof payload?.modelName === "string" ? payload.modelName : "";
  const { latestPrompt, stopReminded, cardRendered } = scanCurrentCycle(transcriptPath);

  if (cardRendered || stopReminded || latestPrompt === null || latestPrompt < REMIND_THRESHOLD_TOKENS) {
    return {};
  }

  const usedK = Math.round(latestPrompt / 1000);
  const limitSuffix = /(?:neon|carbon|argon|hydrogen)/i.test(modelName) ? " / 512K" : "";

  return {
    decision: "continue",
    reason:
      `${STOP_REMINDER_MARKER} 当前会话上下文已达 ${usedK}K${limitSuffix}（≥400K 纯软提醒），且上一条回复未包含压缩提醒卡片。` +
      "严禁调用任何工具，也不要重复上一条回复内容；请直接单独输出下方完整可见卡片（仅把代码块内的 `/compact` 占位内容替换为结合本会话上下文的真实可复制指令）：\n\n" +
      buildCompactCardMarkdown(usedK, limitSuffix),
  };
}

/** 按 hookEventName 路由 PreInvocation（默认）与 Stop 载荷 */
export function handleHookPayload(payload) {
  return payload?.hookEventName === "Stop" ? handleStop(payload) : handlePreInvocation(payload);
}

/**
 * 职责：安全无侵入将本脚本注册为 Antigravity 全局 PreInvocation Hook（保留所有已有 Hook）。
 * 参数：options - 可选自定义 hooksPath 与 expectedCmd（供测试隔离）。
 * 返回值：{ installed: boolean, reason: string }。
 */
export function installCompactReminderHook(options = {}) {
  const hooksPath = options.hooksPath || DEFAULT_HOOKS_PATH;
  const expectedCmd = options.expectedCmd || `"${process.execPath}" "${SCRIPT_PATH}"`;

  let hooks = {};
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { installed: false, reason: "hooks.json 根节点非对象，已跳过防覆盖" };
      }
      hooks = parsed;
    } catch {
      return { installed: false, reason: "hooks.json 解析失败，已跳过防覆盖" };
    }
  }

  if (!isOwnedHookConfig(hooks[HOOK_KEY], expectedCmd)) {
    return { installed: false, reason: `检测到已有自定义 ${HOOK_KEY} 配置，未覆盖` };
  }

  const handler = {
    type: "command",
    command: expectedCmd,
    timeout: 5,
  };
  hooks[HOOK_KEY] = {
    enabled: true,
    PreInvocation: [handler],
    Stop: [{ ...handler }],
  };
  writeJsonAtomic(hooksPath, hooks);
  return { installed: true, reason: `已注册 400K 上下文软提醒 Hook (${hooksPath})` };
}

/**
 * 职责：安全卸载本脚本在 hooks.json 中的条目，完整保留用户其他 Hook。
 * 参数：options - 可选自定义 hooksPath 与 expectedCmd（供测试隔离）。
 * 返回值：{ removed: boolean, reason: string }。
 */
export function uninstallCompactReminderHook(options = {}) {
  const hooksPath = options.hooksPath || DEFAULT_HOOKS_PATH;
  const expectedCmd = options.expectedCmd || `"${process.execPath}" "${SCRIPT_PATH}"`;

  if (!fs.existsSync(hooksPath)) {
    return { removed: false, reason: `未找到配置文件 (${hooksPath})` };
  }

  let hooks;
  try {
    hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
      return { removed: false, reason: "hooks.json 根节点非对象，已跳过" };
    }
  } catch {
    return { removed: false, reason: "hooks.json 解析失败，已跳过" };
  }

  if (!(HOOK_KEY in hooks)) {
    return { removed: false, reason: `未安装 ${HOOK_KEY}，无需卸载` };
  }
  if (!isOwnedHookConfig(hooks[HOOK_KEY], expectedCmd)) {
    return { removed: false, reason: `检测到自定义 ${HOOK_KEY} 配置，未移除` };
  }

  delete hooks[HOOK_KEY];
  writeJsonAtomic(hooksPath, hooks);
  return { removed: true, reason: `已卸载 ${HOOK_KEY} (${hooksPath})` };
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  if (process.argv.includes("--install")) {
    const res = installCompactReminderHook();
    console.log(res.installed ? `✓ ${res.reason}` : `· ${res.reason}`);
  } else if (process.argv.includes("--uninstall")) {
    const res = uninstallCompactReminderHook();
    console.log(res.removed ? `✓ ${res.reason}` : `· ${res.reason}`);
  } else {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      try {
        const payload = raw.trim() ? JSON.parse(raw) : {};
        process.stdout.write(`${JSON.stringify(handleHookPayload(payload))}\n`);
      } catch {
        // 异常静默降级，绝不阻塞主会话
        process.stdout.write("{}\n");
      }
    });
  }
}
