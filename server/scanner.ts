/**
 * Input: node:sqlite、node:fs、node:path、node:os，以及 ./protobuf、./pricing 与 src/types/telemetry.ts。
 * Output: 导出 resolveDefaultDataDir、openSqliteSafe、parseWorkspaceUris、parsePbtxtAnnotation 与 createTelemetryScanner。
 * Pos: 服务端数据采集核心层，零侵入只读融合 SQLite gen_metadata、transcript.jsonl、conversation_summaries 与 pbtxt。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationDetail, DataSourceHealth, ModelPriceRate, StepUsageRecord } from "../src/types/telemetry";
import { calculateStepCost, DEFAULT_MODEL_PRICING, matchModelRate } from "./pricing";
import { decodeGenMetadata, type ParsedGenMetadata } from "./protobuf";

const UNBOUND_WORKSPACE = "(未绑定工作区)"; // 空工作区默认展示名
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false }); // pbtxt 八进制转义解码器

/** conversation_summaries 表查询行结构 */
interface SummaryDbRow {
  conversation_id: string; title: string | null; step_count: number | null;
  last_modified_time: string | number | null; workspace_uris: string | null;
  status: string | null; agent_name: string | null; parent_conversation_id: string | null; nesting_depth: number | null;
}

/** transcript.jsonl 中单条 PLANNER_RESPONSE 解析结构 */
interface JsonlStepItem {
  stepIndex: number; timestamp: string; inputTokens: number; cacheReadTokens: number;
  outputTokens: number; inferredModelName: string; toolNames: string[];
}

/** 单会话增量缓存项 */
interface CachedConversationEntry {
  fingerprint: string; // 多源文件 mtimeMs:size 组合指纹
  detail: ConversationDetail; // 已构建的会话详情快照
  readMode: "wal-readonly" | "immutable-fallback" | "none"; // 最近一次 SQLite 读取模式
}

/**
 * 职责：解析默认 AntiGravity 本地数据根目录。
 * 参数：无。
 * 返回值：数据目录绝对路径。
 */
export function resolveDefaultDataDir(): string {
  // 0. 环境变量优先，默认指向 ~/.gemini/antigravity
  return process.env.AGY_DATA_DIR || path.join(os.homedir(), ".gemini", "antigravity");
}

/**
 * 职责：以只读方式安全打开 SQLite 数据库，锁受限时自动降级 immutable=1 模式。
 * 思路：先尝试标准 readOnly 并用 SELECT 1 校验句柄；若抛异常则关闭半开句柄并降级 URI ?immutable=1。
 * 参数：dbPath — SQLite 文件绝对路径。
 * 返回值：包含 DatabaseSync 实例与读取模式的对象。
 */
export function openSqliteSafe(dbPath: string): { db: DatabaseSync; mode: "wal-readonly" | "immutable-fallback" } {
  // 0. 优先尝试标准只读模式（支持合并活跃 .db-wal）
  let primaryDb: DatabaseSync | null = null;
  try {
    primaryDb = new DatabaseSync(dbPath, { readOnly: true });
    primaryDb.prepare("SELECT 1").get();
    return { db: primaryDb, mode: "wal-readonly" };
  } catch {
    try { primaryDb?.close(); } catch { /* 忽略半开句柄关闭异常 */ }
    // 1. 回退至 immutable=1 快照模式
    const fallbackDb = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true });
    fallbackDb.prepare("SELECT 1").get();
    return { db: fallbackDb, mode: "immutable-fallback" };
  }
}

/**
 * 职责：读取文件 mtimeMs 与字节大小生成指纹，供增量缓存比对。
 * 参数：filePath — 文件路径。
 * 返回值："{mtimeMs}:{size}" 或缺失时的 "0:0"。
 */
function getFileSig(filePath: string): string {
  // 0. statSync 获取修改时间与大小
  try { const st = fs.statSync(filePath); return `${st.mtimeMs}:${st.size}`; } catch { return "0:0"; }
}

/**
 * 职责：将原始时间字段归一化为 ISO-8601 字符串。
 * 参数：raw — 原始时间值（ISO/秒/毫秒）；fallbackIso — 兜底 ISO 字符串。
 * 返回值：标准 ISO-8601 时间串。
 */
function normalizeIsoTime(raw: unknown, fallbackIso: string): string {
  // 0. 区分数值型时间戳与日期字符串
  if (raw === null || raw === undefined || raw === "") return fallbackIso;
  if (typeof raw === "number" || typeof raw === "bigint") {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? new Date(n < 1e11 ? n * 1000 : n).toISOString() : fallbackIso;
  }
  if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return new Date(Number(s) < 1e11 ? Number(s) * 1000 : Number(s)).toISOString();
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallbackIso;
}

/**
 * 职责：解析 workspace_uris JSON 字段，解码 file:// URI 为本地路径与目录名。
 * 思路：提取首个 URI 字符串，通过 URL 解码本地路径并取 basename，空值回退 "(未绑定工作区)"。
 * 参数：rawUris — conversation_summaries.workspace_uris 原始值。
 * 返回值：{ workspaceUri, workspacePath, workspaceName }。
 */
export function parseWorkspaceUris(rawUris: unknown): { workspaceUri: string; workspacePath: string; workspaceName: string } {
  // 0. 提取首个工作区 URI 并解码为本地路径
  let workspaceUri = "";
  if (typeof rawUris === "string" && rawUris.trim()) {
    try { const arr = JSON.parse(rawUris); if (Array.isArray(arr) && typeof arr[0] === "string") workspaceUri = arr[0].trim(); }
    catch { if (rawUris.trim().startsWith("file://")) workspaceUri = rawUris.trim(); }
  }
  let workspacePath = "";
  if (workspaceUri.startsWith("file://")) {
    try { workspacePath = decodeURIComponent(new URL(workspaceUri).pathname); }
    catch { workspacePath = decodeURIComponent(workspaceUri.replace(/^file:\/\//, "")); }
  } else if (workspaceUri) workspacePath = workspaceUri;
  if (workspacePath.length > 1) workspacePath = workspacePath.replace(/\/+$/, "");
  return { workspaceUri, workspacePath, workspaceName: workspacePath ? path.basename(workspacePath) || workspacePath : UNBOUND_WORKSPACE };
}

/**
 * 职责：解析 annotations/<id>.pbtxt 获取备用标题与归档标记。
 * 参数：pbtxtPath — 注解文件路径。
 * 返回值：{ title, archived }。
 */
export function parsePbtxtAnnotation(pbtxtPath: string): { title: string; archived: boolean } {
  // 0. 读取 pbtxt 文本并还原八进制转义标题与归档布尔值
  if (!fs.existsSync(pbtxtPath)) return { title: "", archived: false };
  try {
    const raw = fs.readFileSync(pbtxtPath, "utf8"), archived = /\barchived\s*:\s*true\b/i.test(raw);
    const m = raw.match(/\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return { title: "", archived };
    const title = m[1].replace(/(?:\\[0-7]{1,3})+/g, (seq) => UTF8_DECODER.decode(Uint8Array.from(seq.slice(1).split("\\").map((o) => Number.parseInt(o, 8)))))
      .replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, " ").trim();
    return { title, archived };
  } catch { return { title: "", archived: false }; }
}

/**
 * 职责：解析 transcript.jsonl 实时流日志，提取提示词摘要、模型切换记录与单步响应。
 * 参数：jsonlPath — JSONL 文件路径；fallbackIso — 缺失时间戳时的兜底时间。
 * 返回值：步骤数组、首条提示词、当前设置模型名、最大步号与起止时间。
 */
function parseTranscriptJsonl(jsonlPath: string, fallbackIso: string) {
  // 0. 初始化解析累加变量
  const steps: JsonlStepItem[] = []; // PLANNER_RESPONSE 记录列表
  let activeModelFromSettings = "", firstPromptPreview = "", earliestAt = "", latestAt = "";
  let maxStepIndex = -1;
  if (!fs.existsSync(jsonlPath)) return { steps, firstPromptPreview, activeModelFromSettings, maxStepIndex, earliestAt, latestAt };

  // 1. 逐行解析 JSON，容错未刷盘残行
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const stepIndex = typeof obj.step_index === "number" ? obj.step_index : typeof obj.stepIndex === "number" ? obj.stepIndex : i;
      if (stepIndex > maxStepIndex) maxStepIndex = stepIndex;
      const ts = normalizeIsoTime(obj.created_at ?? obj.timestamp, "");
      if (ts && (!earliestAt || ts < earliestAt)) earliestAt = ts;
      if (ts && (!latestAt || ts > latestAt)) latestAt = ts;

      if (obj.type === "USER_INPUT") {
        const content = typeof obj.content === "string" ? obj.content : "";
        const sm = content.match(/changed setting `Model Selection` from .*? to ([^\n<>]+?)(?:\.\s|\.$|<|\n|$)/);
        if (sm) activeModelFromSettings = sm[1].trim().replace(/\.+$/, "").trim();
        if (!firstPromptPreview && content) {
          const req = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
          const text = (req ? req[1] : content).replace(/\s+/g, " ").trim();
          if (text) firstPromptPreview = text.slice(0, 140);
        }
      } else if (obj.type === "PLANNER_RESPONSE") {
        const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
        const toolNames = calls.map((t) => (t && typeof (t as { name?: unknown }).name === "string" ? (t as { name: string }).name : "")).filter(Boolean);
        steps.push({
          stepIndex, timestamp: ts || fallbackIso,
          inputTokens: Math.max(0, Number(obj.input_tokens ?? 0)),
          cacheReadTokens: Math.max(0, Number(obj.cache_read_tokens ?? 0)),
          outputTokens: Math.max(0, Number(obj.output_tokens ?? 0)),
          inferredModelName: activeModelFromSettings, toolNames,
        });
      }
    } catch { /* 忽略损坏行 */ }
  }
  return { steps, firstPromptPreview, activeModelFromSettings, maxStepIndex, earliestAt, latestAt };
}

/**
 * 职责：构造带等效成本核算的单步 StepUsageRecord 对象。
 * 参数：partial — 核心指标输入；rates — 费率配置表。
 * 返回值：完整的 StepUsageRecord。
 */
function buildStepRecord(
  partial: Omit<StepUsageRecord, "callIndex" | "totalTokens" | "estimatedCostUsd" | "cacheSavedUsd">,
  rates: ModelPriceRate[],
): StepUsageRecord {
  // 0. 汇总总 Token、上下文回退值与模型等效 API 成本
  const totalTokens = partial.inputTokens + partial.cacheReadTokens + partial.outputTokens;
  const rate = matchModelRate(partial.modelName, partial.modelId, rates);
  const { estimatedCostUsd, cacheSavedUsd } = calculateStepCost(partial.inputTokens, partial.cacheReadTokens, partial.outputTokens, rate);
  return { ...partial, callIndex: 0, totalTokens, contextUsed: partial.contextUsed > 0 ? partial.contextUsed : totalTokens, estimatedCostUsd, cacheSavedUsd };
}

/**
 * 职责：零重复融合 gen_metadata 与 transcript.jsonl 步骤记录。
 * 思路：先按 lastStepIndex + 1 === stepIndex 精确匹配，再按顺序下标配对生成 hybrid；多余实时步标 jsonl，纯库步标 db。
 * 参数：dbMetas — DB 元数据列表；jsonlSteps — JSONL 步骤列表；fallbackTime — 兜底时间；rates — 单价表。
 * 返回值：排序并重编 callIndex 的 StepUsageRecord 数组。
 */
function mergeHybridSteps(dbMetas: ParsedGenMetadata[], jsonlSteps: JsonlStepItem[], fallbackTime: string, rates: ModelPriceRate[]): StepUsageRecord[] {
  // 0. 过滤全 0 Token 的取消/中断空元数据行，避免错配 JSONL 步号或以最新时间漂移至图表尾部形成伪 0% 跌零
  const activeDbMetas = dbMetas.filter((m) => m.inputTokens + m.cacheReadTokens + m.outputTokens > 0);

  // 0.1. 双轮配对索引（1: 精确步号关联；2: 顺序 callIndex 关联）
  const usedDb = new Set<number>();
  const jsonlToDb = new Map<number, number>();
  for (let j = 0; j < jsonlSteps.length; j++) {
    const idx = activeDbMetas.findIndex((m, d) => !usedDb.has(d) && m.lastStepIndex !== null && m.lastStepIndex + 1 === jsonlSteps[j].stepIndex);
    if (idx !== -1) { usedDb.add(idx); jsonlToDb.set(j, idx); }
  }
  let cursor = 0;
  for (let j = 0; j < jsonlSteps.length; j++) {
    if (jsonlToDb.has(j)) continue;
    if (j < activeDbMetas.length && !usedDb.has(j)) { usedDb.add(j); jsonlToDb.set(j, j); continue; }
    while (cursor < activeDbMetas.length && usedDb.has(cursor)) cursor++;
    if (cursor < activeDbMetas.length && activeDbMetas[cursor].lastStepIndex === null) { usedDb.add(cursor); jsonlToDb.set(j, cursor++); }
  }

  // 1. 生成 hybrid 与尾部实时 jsonl 步骤
  const steps: StepUsageRecord[] = [];
  let lastModelName = "", lastModelId = "";
  for (let j = 0; j < jsonlSteps.length; j++) {
    const js = jsonlSteps[j], dbIdx = jsonlToDb.get(j);
    if (dbIdx !== undefined) {
      const dm = activeDbMetas[dbIdx];
      const modelId = dm.modelId || lastModelId || "unknown";
      const modelName = dm.modelName || js.inferredModelName || dm.modelId || lastModelName || "Unknown Model";
      if (modelName !== "Unknown Model") lastModelName = modelName;
      if (dm.modelId) lastModelId = dm.modelId;
      const outputTokens = js.outputTokens || dm.outputTokens;
      const responseTokens = dm.responseTokens > 0 || dm.thinkingTokens > 0 ? dm.responseTokens : outputTokens;
      steps.push(buildStepRecord({
        stepIndex: js.stepIndex, timestamp: js.timestamp || fallbackTime, modelId, modelName,
        inputTokens: js.inputTokens || dm.inputTokens, cacheReadTokens: js.cacheReadTokens || dm.cacheReadTokens,
        outputTokens, thinkingTokens: dm.thinkingTokens, responseTokens, contextUsed: dm.contextUsed,
        contextLimit: dm.contextLimit, latencyMs: dm.latencyMs, ttftMs: dm.ttftMs, toolNames: js.toolNames, dataSource: "hybrid",
      }, rates));
    } else {
      const modelName = js.inferredModelName || lastModelName || "Unknown Model";
      if (modelName !== "Unknown Model") lastModelName = modelName;
      const modelId = js.inferredModelName ? "unknown" : lastModelId || "unknown";
      steps.push(buildStepRecord({
        stepIndex: js.stepIndex, timestamp: js.timestamp || fallbackTime, modelId, modelName,
        inputTokens: js.inputTokens, cacheReadTokens: js.cacheReadTokens, outputTokens: js.outputTokens,
        thinkingTokens: 0, responseTokens: js.outputTokens, contextUsed: 0, contextLimit: 0,
        latencyMs: 0, ttftMs: 0, toolNames: js.toolNames, dataSource: "jsonl",
      }, rates));
    }
  }

  // 2. 补充仅有 .db 的有效步骤并按步序编号
  for (let d = 0; d < activeDbMetas.length; d++) {
    if (usedDb.has(d)) continue;
    const dm = activeDbMetas[d];
    steps.push(buildStepRecord({
      stepIndex: dm.lastStepIndex !== null ? dm.lastStepIndex + 1 : d, timestamp: fallbackTime,
      modelId: dm.modelId || "unknown", modelName: dm.modelName || dm.modelId || "Unknown Model",
      inputTokens: dm.inputTokens, cacheReadTokens: dm.cacheReadTokens, outputTokens: dm.outputTokens,
      thinkingTokens: dm.thinkingTokens, responseTokens: dm.responseTokens, contextUsed: dm.contextUsed,
      contextLimit: dm.contextLimit, latencyMs: dm.latencyMs, ttftMs: dm.ttftMs, toolNames: [], dataSource: "db",
    }, rates));
  }
  steps.sort((a, b) => a.stepIndex - b.stepIndex);
  steps.forEach((s, idx) => { s.callIndex = idx; });
  return steps;
}

/**
 * 职责：创建带 mtimeMs+size 增量缓存的 AntiGravity 遥测扫描器。
 * 思路：合并索引库、会话库与轨迹流三类 ID 并集，按文件指纹跳过未变更会话，最后回填子代理数与健康指标。
 * 参数：customDataDir — 可选数据目录；customRates — 可选单价配置。
 * 返回值：暴露 scan(forceRefresh) 的扫描器实例。
 */
export function createTelemetryScanner(customDataDir?: string, customRates?: ModelPriceRate[]) {
  const dataDir = customDataDir || resolveDefaultDataDir(); // 实际扫描根目录
  const rates = customRates && customRates.length > 0 ? customRates : DEFAULT_MODEL_PRICING; // 生效单价表
  const cache = new Map<string, CachedConversationEntry>(); // 会话级增量缓存
  const SCAN_TTL_MS = 2500; // 短时扫描结果复用窗口（毫秒），避免切换模型池时重复 stat/SQLite 阻塞
  let scanVersion = 0; // 数据实际变更版本号，供聚合层安全命中结果缓存
  let lastScanAt = 0; // 上次完整增量扫描的时间戳
  let lastSnapshot: { conversations: ConversationDetail[]; health: DataSourceHealth; version: number } | null = null;

  return {
    /**
     * 职责：执行增量或强制全量扫描。
     * 参数：forceRefresh — 是否清空缓存强制重读。
     * 返回值：{ conversations, health, version }。
     */
    scan(forceRefresh = false): { conversations: ConversationDetail[]; health: DataSourceHealth; version: number } {
      const now = Date.now();
      if (!forceRefresh && lastSnapshot && now - lastScanAt < SCAN_TTL_MS) {
        return lastSnapshot;
      }
      const t0 = performance.now();
      if (forceRefresh) cache.clear();
      let changed = forceRefresh || lastSnapshot === null;
      const warnings: string[] = [];
      let sqliteReadMode: "wal-readonly" | "immutable-fallback" | "none" = "none";
      const trackMode = (m: "wal-readonly" | "immutable-fallback" | "none") => {
        if (m === "immutable-fallback") sqliteReadMode = "immutable-fallback";
        else if (m === "wal-readonly" && sqliteReadMode === "none") sqliteReadMode = "wal-readonly";
      };

      if (!fs.existsSync(dataDir)) {
        scanVersion++;
        lastScanAt = Date.now();
        lastSnapshot = {
          conversations: [],
          health: {
            dataDir, exists: false, summaryDbAvailable: false, conversationDbCount: 0, transcriptCount: 0,
            sqliteReadMode: "none", scanDurationMs: Math.round(performance.now() - t0),
            scannedAt: new Date().toISOString(), warnings: [`数据目录不存在: ${dataDir}`],
          },
          version: scanVersion,
        };
        return lastSnapshot;
      }

      // 1. 读取 conversation_summaries.db
      const summaryMap = new Map<string, SummaryDbRow>();
      let summaryDbAvailable = false;
      const sumDbPath = path.join(dataDir, "conversation_summaries.db");
      if (fs.existsSync(sumDbPath)) {
        let opened: ReturnType<typeof openSqliteSafe> | null = null;
        try {
          opened = openSqliteSafe(sumDbPath);
          trackMode(opened.mode);
          const rows = opened.db
            .prepare("SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, status, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries")
            .all() as unknown as SummaryDbRow[];
          summaryDbAvailable = true;
          for (const r of rows) if (r.conversation_id) summaryMap.set(r.conversation_id, r);
        } catch (e) { warnings.push(`读取 conversation_summaries.db 失败: ${(e as Error).message}`); }
        finally { try { opened?.db.close(); } catch { /* ignore */ } }
      }

      // 2. 收集会话 ID 并集
      const allIds = new Set<string>(summaryMap.keys());
      let conversationDbCount = 0, transcriptCount = 0;
      const convDir = path.join(dataDir, "conversations"), brainDir = path.join(dataDir, "brain");
      if (fs.existsSync(convDir)) {
        for (const ent of fs.readdirSync(convDir, { withFileTypes: true })) {
          if (ent.isFile() && ent.name.endsWith(".db")) { conversationDbCount++; allIds.add(ent.name.slice(0, -3)); }
        }
      }
      if (fs.existsSync(brainDir)) {
        for (const ent of fs.readdirSync(brainDir, { withFileTypes: true })) {
          if (ent.isDirectory() && fs.existsSync(path.join(brainDir, ent.name, ".system_generated", "logs", "transcript.jsonl"))) {
            transcriptCount++; allIds.add(ent.name);
          }
        }
      }

      // 3. 逐会话增量扫描
      const conversations: ConversationDetail[] = [];
      for (const id of allIds) {
        const dbPath = path.join(convDir, `${id}.db`), jsonlPath = path.join(brainDir, id, ".system_generated", "logs", "transcript.jsonl");
        const pbtxtPath = path.join(dataDir, "annotations", `${id}.pbtxt`), sRow = summaryMap.get(id);
        const fp = `${getFileSig(dbPath)}#${getFileSig(`${dbPath}-wal`)}#${getFileSig(jsonlPath)}#${getFileSig(pbtxtPath)}#${sRow ? `${sRow.title ?? ""}|${sRow.step_count ?? 0}|${sRow.last_modified_time ?? ""}|${sRow.workspace_uris ?? ""}|${sRow.status ?? ""}|${sRow.parent_conversation_id ?? ""}` : ""}`;
        const hit = cache.get(id);
        if (hit && hit.fingerprint === fp) { trackMode(hit.readMode); conversations.push(hit.detail); continue; }
        changed = true;

        const latestMtime = Math.max(fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).mtimeMs : 0, fs.existsSync(dbPath) ? fs.statSync(dbPath).mtimeMs : 0);
        const fallbackIso = normalizeIsoTime(sRow?.last_modified_time, new Date(latestMtime > 0 ? latestMtime : Date.now()).toISOString());
        const pbtxt = parsePbtxtAnnotation(pbtxtPath), jsonl = parseTranscriptJsonl(jsonlPath, fallbackIso);
        const dbMetas: ParsedGenMetadata[] = [];
        let convMode: "wal-readonly" | "immutable-fallback" | "none" = "none";
        if (fs.existsSync(dbPath)) {
          let opened: ReturnType<typeof openSqliteSafe> | null = null;
          try {
            opened = openSqliteSafe(dbPath); convMode = opened.mode; trackMode(opened.mode);
            const rows = opened.db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").all() as Array<{ idx: number; data: Uint8Array }>;
            for (const r of rows) if (r.data instanceof Uint8Array) { const d = decodeGenMetadata(r.data); if (d) dbMetas.push(d); }
          } catch (e) { warnings.push(`读取会话库 ${id}.db 失败: ${(e as Error).message}`); }
          finally { try { opened?.db.close(); } catch { /* ignore */ } }
        }

        const steps = mergeHybridSteps(dbMetas, jsonl.steps, fallbackIso, rates), ws = parseWorkspaceUris(sRow?.workspace_uris);
        const modelMap = new Map<string, number>(), toolUsageCounts: Record<string, number> = {};
        let inputTokens = 0, cacheReadTokens = 0, outputTokens = 0, thinkingTokens = 0, responseTokens = 0;
        let peakContextUsed = 0, contextLimit = 0, totalLatencyMs = 0, estimatedCostUsd = 0, cacheSavedUsd = 0;
        for (const s of steps) {
          inputTokens += s.inputTokens; cacheReadTokens += s.cacheReadTokens; outputTokens += s.outputTokens;
          thinkingTokens += s.thinkingTokens; responseTokens += s.responseTokens;
          if (s.contextUsed > peakContextUsed) peakContextUsed = s.contextUsed;
          if (s.contextLimit > contextLimit) contextLimit = s.contextLimit;
          totalLatencyMs += s.latencyMs; estimatedCostUsd += s.estimatedCostUsd; cacheSavedUsd += s.cacheSavedUsd;
          modelMap.set(s.modelName, (modelMap.get(s.modelName) ?? 0) + s.totalTokens);
          for (const t of s.toolNames) toolUsageCounts[t] = (toolUsageCounts[t] ?? 0) + 1;
        }
        const models = [...modelMap.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
        const totalTokens = inputTokens + cacheReadTokens + outputTokens, promptSum = inputTokens + cacheReadTokens;
        const lastStep = steps[steps.length - 1];
        const latestContextUsed = lastStep ? (lastStep.contextUsed > 0 ? lastStep.contextUsed : lastStep.inputTokens + lastStep.cacheReadTokens) : 0;
        const lastModifiedAt = jsonl.latestAt && jsonl.latestAt > fallbackIso ? jsonl.latestAt : fallbackIso;
        const detail: ConversationDetail = {
          conversationId: id, title: sRow?.title?.trim() || pbtxt.title || jsonl.firstPromptPreview || `会话 ${id.slice(0, 8)}`,
          firstPromptPreview: jsonl.firstPromptPreview, workspaceUri: ws.workspaceUri, workspaceName: ws.workspaceName, workspacePath: ws.workspacePath,
          parentConversationId: sRow?.parent_conversation_id ?? "", nestingDepth: Number(sRow?.nesting_depth ?? 0),
          agentName: sRow?.agent_name ?? "", archived: pbtxt.archived, status: sRow?.status || "unknown",
          createdAt: jsonl.earliestAt || steps[0]?.timestamp || lastModifiedAt, lastModifiedAt, models,
          primaryModel: models[0] || jsonl.activeModelFromSettings || "Unknown Model", callCount: steps.length,
          stepCount: Math.max(Number(sRow?.step_count ?? 0), jsonl.maxStepIndex + 1, steps.length),
          inputTokens, cacheReadTokens, outputTokens, thinkingTokens, responseTokens, totalTokens,
          cacheHitRate: promptSum > 0 ? cacheReadTokens / promptSum : 0, peakContextUsed, latestContextUsed, contextLimit,
          totalLatencyMs, estimatedCostUsd, cacheSavedUsd, subagentCount: 0, steps, toolUsageCounts,
        };
        cache.set(id, { fingerprint: fp, detail, readMode: convMode });
        conversations.push(detail);
      }

      // 4. 清理过期缓存、回填直接子代理数并美化无标题子代理名称
      for (const k of cache.keys()) if (!allIds.has(k)) { cache.delete(k); changed = true; }
      const byId = new Map(conversations.map((c) => [c.conversationId, c]));
      const childCounts = new Map<string, number>();
      for (const c of conversations) {
        if (c.parentConversationId) {
          childCounts.set(c.parentConversationId, (childCounts.get(c.parentConversationId) ?? 0) + 1);
          const parent = byId.get(c.parentConversationId);
          if (parent && c.title.startsWith("会话 ")) {
            const roleTag = c.agentName || c.conversationId.slice(0, 8);
            c.title = `${parent.title} · 子代理 (${roleTag})`;
          }
          // 4.1. 未落库的子代理若缺少模型标记，默认继承父会话主模型（对应 Model: inherit）
          if (parent && parent.primaryModel && parent.primaryModel !== "Unknown Model") {
            let inherited = false;
            for (const s of c.steps) {
              if (!s.modelName || s.modelName === "Unknown Model") {
                s.modelName = parent.primaryModel;
                inherited = true;
              }
            }
            if (c.primaryModel === "Unknown Model") {
              c.primaryModel = parent.primaryModel;
              inherited = true;
            }
            if (inherited) {
              c.models = [...new Set(c.steps.map((s) => s.modelName).filter(Boolean))];
              if (c.models.length === 0) c.models = [parent.primaryModel];
            }
          }
        }
      }
      for (const c of conversations) c.subagentCount = childCounts.get(c.conversationId) ?? 0;

      if (changed) scanVersion++;
      lastScanAt = Date.now();
      lastSnapshot = {
        conversations,
        health: {
          dataDir, exists: true, summaryDbAvailable, conversationDbCount, transcriptCount,
          sqliteReadMode, scanDurationMs: Math.round(performance.now() - t0), scannedAt: new Date().toISOString(), warnings,
        },
        version: scanVersion,
      };
      return lastSnapshot;
    },
  };
}
