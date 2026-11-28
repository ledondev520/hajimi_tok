#!/usr/bin/env node
/**
 * Input: Antigravity PreInvocation Hook stdin JSON（含 transcriptPath、modelName），或命令行参数 --install / --uninstall。
 * Output: 上下文 Prompt（input_tokens + cache_read_tokens）在当前压缩周期首次达到 400K 时输出一次性纯软提醒 Hook JSON（向模型注入 systemMessage 引导在回复末尾拟好 `/compact` 指令，省略 metadata 以规避 Antigravity 宿主 scrubMessage panic，绝不熔断）；支持安全无侵入安装/卸载至 ~/.gemini/config/hooks.json。
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
export const REMINDER_MARKER = "[CONTEXT_COMPACT_400K]"; // 写入 systemMessage 的去重标记

const CYCLE_RESET_TOKENS = 250_000; // 若无显式 CHECKPOINT，Prompt 回落至 250K 以下视为新压缩周期
const CHUNK_BYTES = 256 * 1024; // 逆向分块读取步长（256KB），避免大 transcript 全量读入
const OWNED_HOOK_KEYS = new Set(["enabled", "PreInvocation"]);

/** 使用进程+随机唯一临时文件原子落盘 JSON */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

/** 校验 hooks.json 中同名条目是否严格归属本脚本，防止覆盖用户自定义同名 Hook */
function isOwnedHookConfig(existing, expectedCmd) {
  if (existing === undefined) return true;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  if (Object.keys(existing).some((k) => !OWNED_HOOK_KEYS.has(k))) return false;
  const list = existing.PreInvocation;
  if (!Array.isArray(list) || list.length !== 1) return false;
  const cmd = typeof list[0]?.command === "string" ? list[0].command.trim() : "";
  return cmd === expectedCmd || cmd.includes("compact-reminder-hook.mjs");
}

/**
 * 职责：逆向分块扫描 transcript.jsonl 当前压缩周期尾部，提取最新 Prompt Token 并判断是否已提醒过。
 * 思路：从 EOF 按 256KB 原始字节块倒扫，按 0x0a 换行切分避免拆碎多字节 UTF-8；遇低于阈值、已提醒、CHECKPOINT 或回落至 250K 以下即提前中止。
 * 参数：transcriptPath - 当前会话 transcript.jsonl 绝对路径；threshold - 提醒阈值（默认 400K）。
 * 返回值：{ latestPrompt: number | null, alreadyReminded: boolean }。
 */
export function scanCurrentCycle(transcriptPath, threshold = REMIND_THRESHOLD_TOKENS) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { latestPrompt: null, alreadyReminded: false };
  }

  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const { size } = fs.fstatSync(fd);
    if (size <= 0) return { latestPrompt: null, alreadyReminded: false };

    let pos = size;
    let carry = Buffer.alloc(0);
    let latestPrompt = null;

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
          if (typeof obj.content === "string" && obj.content.includes(REMINDER_MARKER)) {
            return { latestPrompt, alreadyReminded: true };
          }
          continue;
        }

        if (obj.type === "CHECKPOINT") {
          return { latestPrompt, alreadyReminded: false };
        }

        if (obj.type === "PLANNER_RESPONSE") {
          const prompt =
            Math.max(0, Number(obj.input_tokens || 0)) +
            Math.max(0, Number(obj.cache_read_tokens || 0));
          if (prompt <= 0) continue;
          if (latestPrompt === null) {
            latestPrompt = prompt;
            if (latestPrompt < threshold) {
              return { latestPrompt, alreadyReminded: false };
            }
          } else if (prompt < CYCLE_RESET_TOKENS) {
            return { latestPrompt, alreadyReminded: false };
          }
        }
      }
    }

    return { latestPrompt, alreadyReminded: false };
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
  const { latestPrompt, alreadyReminded } = scanCurrentCycle(transcriptPath);

  if (alreadyReminded || latestPrompt === null || latestPrompt < REMIND_THRESHOLD_TOKENS) {
    return {};
  }

  const usedK = Math.round(latestPrompt / 1000);
  const limitSuffix = /(?:neon|carbon|argon|hydrogen)/i.test(modelName) ? " / 512K" : "";

  const systemMessage =
    `${REMINDER_MARKER} 当前会话上下文已达 ${usedK}K${limitSuffix}（≥400K 纯软提醒，严禁因此停工、中断或拒答）。` +
    "请正常完成本轮全部工作，仅在最终回复的最末尾用 `### ***...***` 醒目附上一行可直接复制的 `/compact 保留<本阶段核心结论、关键文件路径与约束>；接下来继续<下一步明确动作>` 建议。";

  // shortcut: 省略 metadata.user_markdown，因 Antigravity 宿主 utils.scrubMessage 会对 map<string,string> panic；待宿主修复 proto_utils.go 后可恢复
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

  hooks[HOOK_KEY] = {
    enabled: true,
    PreInvocation: [
      {
        type: "command",
        command: expectedCmd,
        timeout: 5,
      },
    ],
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
        process.stdout.write(`${JSON.stringify(handlePreInvocation(payload))}\n`);
      } catch {
        // 异常静默降级，绝不阻塞主会话
        process.stdout.write("{}\n");
      }
    });
  }
}
