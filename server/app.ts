/**
 * Input: node:http、node:fs、node:path、node:url 内置模块与 TelemetryProvider 领域服务接口。
 * Output: 导出 createTelemetryHttpServer HTTP 服务工厂及查询参数解析、CSV 序列化工具函数。
 * Pos: 服务端只读 HTTP API 路由层、CSV/JSON 报表导出层与前端静态资源安全托管层。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import type {
  ConversationUsageSummary,
  QuotaCycleMode,
  TelemetryFilterOptions,
  TelemetryProvider,
} from "../src/types/telemetry";

const VALID_CYCLES = new Set<QuotaCycleMode>(["5h", "prev-5h", "7d", "prev-7d", "today", "all"]); // 合法配额周期枚举集合
const WINDOW_CYCLE_RE = /^window:\d+:\d+$/; // 任意历史周周期窗口标识正则
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // 仓库根目录
const UPDATE_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "update.mjs"); // 一键自更新脚本路径
const SERVICE_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "service.mjs"); // 常驻服务脚本路径
const UPDATE_CHECK_TTL_MS = 5 * 60_000; // 更新检测结果缓存 5 分钟，避免反复 git fetch

/**
 * 职责：异步调用 scripts/update.mjs 并解析其 JSON 输出，不阻塞主事件循环。
 * 参数：args — 传给 update.mjs 的参数列表；timeoutMs — 执行超时毫秒数。
 * 返回值：Promise<Record<string, unknown>>。
 */
function runUpdateScriptJson(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (!fs.existsSync(UPDATE_SCRIPT_PATH)) {
      resolve({ ok: false, available: false, behindCount: 0, message: "更新脚本不存在" });
      return;
    }
    execFile(
      process.execPath,
      [UPDATE_SCRIPT_PATH, ...args],
      { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        const text = (stdout || "").trim();
        if (text) {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            resolve(parsed);
            return;
          } catch {
            /* 解析失败走下方兜底 */
          }
        }
        resolve({
          ok: false,
          available: false,
          behindCount: 0,
          message: err instanceof Error ? err.message : "执行更新脚本失败",
        });
      }
    );
  });
}

/** HTTP 服务可选配置项 */
export interface TelemetryHttpServerOptions {
  staticDir?: string; // 前端构建产物静态托管目录路径
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}; // 静态文件后缀到 Content-Type 响应头的映射表

const CSV_COLUMNS = [
  "conversationId",
  "title",
  "workspaceName",
  "primaryModel",
  "callCount",
  "inputTokens",
  "cacheReadTokens",
  "outputTokens",
  "thinkingTokens",
  "responseTokens",
  "totalTokens",
  "cacheHitRate",
  "estimatedCostUsd",
  "cacheSavedUsd",
  "parentConversationId",
  "archived",
  "lastModifiedAt",
] as const; // CSV 导出固定表头字段序列

/**
 * 职责：为响应对象注入本地开发跨域访问所需的 CORS 响应头。
 * 参数：res — Node HTTP 服务端响应对象。
 * 返回值：无返回值。
 */
function setCorsHeaders(res: http.ServerResponse): void {
  // 0. 设置跨域许可头，兼容本地 Vite 开发端口访问
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

/**
 * 职责：安全读取有界 HTTP 请求体并解析为 JSON 对象（上限 8KB 防止滥用）。
 * 参数：req — Node HTTP 请求对象。
 * 返回值：解析后的 Record 对象。
 */
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 8192) throw new Error("请求体过大");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求体必须为 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 职责：序列化 JSON 载荷并以指定 HTTP 状态码写回客户端。
 * 参数：res — HTTP 响应对象；statusCode — HTTP 状态码；payload — 待序列化数据；extraHeaders — 附加响应头。
 * 返回值：无返回值。
 */
function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  // 0. 序列化响应体并注入统一头信息
  const body = JSON.stringify(payload);
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  // 1.1. 输出 UTF-8 JSON 正文并结束响应
  res.end(body);
}

/**
 * 职责：从请求 URL 查询字符串中提取并归一化遥测过滤参数。
 * 思路：1) 将 days 转为正整数；2) 过滤 workspace/model 的空值与 all 占位值；3) 解析归档与强制刷新开关。
 * 参数：url — 已解析的标准 URL 实例。
 * 返回值：标准化的 TelemetryFilterOptions 过滤对象。
 */
export function parseSummaryQuery(url: URL): TelemetryFilterOptions {
  // 0. 解析配额周期模式与最近天数，仅接受合法枚举、window:<start>:<end> 与正整数
  const rawCycle = url.searchParams.get("cycle")?.trim();
  const cycle =
    rawCycle && (VALID_CYCLES.has(rawCycle as QuotaCycleMode) || WINDOW_CYCLE_RE.test(rawCycle))
      ? (rawCycle as QuotaCycleMode)
      : undefined;
  const rawDays = Number(url.searchParams.get("days"));
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : undefined;

  // 1.1. 归一化工作区、模型与搜索词参数（all 或空白均视为不过滤）
  const rawWorkspace = url.searchParams.get("workspace")?.trim();
  const workspace =
    rawWorkspace && rawWorkspace.toLowerCase() !== "all" ? rawWorkspace : undefined;

  const rawModel = url.searchParams.get("model")?.trim();
  const model = rawModel && rawModel.toLowerCase() !== "all" ? rawModel : undefined;

  const rawSearch = url.searchParams.get("search")?.trim();
  const search = rawSearch ? rawSearch : undefined;

  // 1.2. 解析归档会话开关（默认 true）与强制刷新标志
  const includeArchived = url.searchParams.get("includeArchived") !== "false";
  const rawRefresh = url.searchParams.get("refresh");
  const forceRefresh = rawRefresh === "1" || rawRefresh === "true";

  return {
    ...(cycle ? { cycle } : {}),
    days,
    workspace,
    model,
    search,
    includeArchived,
    forceRefresh,
  };
}

/**
 * 职责：对单个 CSV 单元格执行 RFC 4180 转义以兼容引号、逗号与换行符。
 * 参数：value — 原始字段值（字符串、数值或布尔值）。
 * 返回值：安全转义后的 CSV 单元格文本。
 */
function escapeCsvCell(value: string | number | boolean): string {
  // 0. 统一转换为字符串形式
  const text = String(value ?? "");
  // 1.1. 包含双引号、逗号或回车换行时，内部双引号双写并在外层加双引号
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * 职责：将会话汇总列表编码为带 UTF-8 BOM 的 CSV 文本（保障 macOS Excel 中文正常显示）。
 * 参数：conversations — 已过滤的会话汇总数组。
 * 返回值：以 \uFEFF 开头的完整 CSV 字符串。
 */
export function serializeConversationsCsv(conversations: ConversationUsageSummary[]): string {
  // 0. 构建首行字段名表头
  const lines: string[] = [CSV_COLUMNS.join(",")];

  // 1.1. 逐条映射会话属性并做 CSV 单元格转义
  for (const item of conversations) {
    const row = [
      item.conversationId,
      item.title,
      item.workspaceName,
      item.primaryModel,
      item.callCount,
      item.inputTokens,
      item.cacheReadTokens,
      item.outputTokens,
      item.thinkingTokens,
      item.responseTokens,
      item.totalTokens,
      item.cacheHitRate,
      item.estimatedCostUsd,
      item.cacheSavedUsd,
      item.parentConversationId,
      item.archived,
      item.lastModifiedAt,
    ].map(escapeCsvCell);
    lines.push(row.join(","));
  }

  // 2. 拼接 UTF-8 BOM 前缀返回
  return `\uFEFF${lines.join("\n")}`;
}

/**
 * 职责：在静态目录存在时安全托管前端资源，防止路径穿越并对前端路由回退至 index.html。
 * 思路：1) 校验 staticDir 存在性；2) 解码原始请求路径并拦截空字节与 .. 穿越段；3) 命中文件直出，未命中回退 SPA 入口。
 * 参数：rawUrl — 原始未归一化 req.url；staticDir — 静态资源根目录；res — HTTP 响应对象。
 * 返回值：无返回值。
 */
function serveStaticOrFallback(
  rawUrl: string,
  staticDir: string | undefined,
  res: http.ServerResponse,
): void {
  // 0. 若未配置静态目录或目录不存在，直接返回 404 JSON
  if (!staticDir || !fs.existsSync(staticDir) || !fs.statSync(staticDir).isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const staticRoot = path.resolve(staticDir); // 规范化静态资源根绝对路径
  const rawPathname = rawUrl.split("?")[0] || "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPathname);
  } catch {
    sendJson(res, 400, { error: "Malformed URL path" });
    return;
  }

  // 1.1. 在 URL 归一化折叠前拦截原始或编码后的 .. 父目录穿越片段与空字节
  if (
    decodedPath.includes("\0") ||
    rawPathname.split("/").includes("..") ||
    decodedPath.split("/").includes("..")
  ) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const relativeTarget = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolvedCandidate = path.resolve(staticRoot, relativeTarget);
  const relFromRoot = path.relative(staticRoot, resolvedCandidate);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  // 1.2. 若请求路径精确命中静态文件，则按后缀输出对应 MIME 内容
  if (fs.existsSync(resolvedCandidate) && fs.statSync(resolvedCandidate).isFile()) {
    const ext = path.extname(resolvedCandidate).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    setCorsHeaders(res);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(fs.readFileSync(resolvedCandidate));
    return;
  }

  // 2. SPA 路由回退至 index.html
  const indexHtmlPath = path.join(staticRoot, "index.html");
  if (fs.existsSync(indexHtmlPath) && fs.statSync(indexHtmlPath).isFile()) {
    setCorsHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(indexHtmlPath));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

/**
 * 职责：创建只读 AntiGravity Token 遥测 HTTP 服务实例，挂载 API 路由、导出端点与静态托管。
 * 思路：1) 处理 OPTIONS 预检；2) 分发 /api/health、/api/summary、/api/conversations/:id 与导出接口；3) 兜底静态资源与异常捕获。
 * 参数：provider — 实现 TelemetryProvider 契约的数据提供者；options — 可选静态托管目录配置。
 * 返回值：Node.js 原生 http.Server 实例。
 */
export function createTelemetryHttpServer(
  provider: TelemetryProvider,
  options?: TelemetryHttpServerOptions,
): http.Server {
  let updateCheckCache: { data: Record<string, unknown>; expiresAt: number } | null = null;
  let updateInFlight = false;

  // 0. 读取前端构建指纹供前端检测后台静默更新后自动无感重载
  const buildId = (() => {
    try {
      const idxPath = options?.staticDir ? path.join(options.staticDir, "index.html") : "";
      if (!idxPath || !fs.existsSync(idxPath)) return "";
      const html = fs.readFileSync(idxPath, "utf8");
      const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
      return m ? m[0] : String(Math.round(fs.statSync(idxPath).mtimeMs));
    } catch {
      return "";
    }
  })();

  // 0.1. 构建无框架原生 HTTP 服务器并统一包裹异常边界
  return http.createServer(async (req, res) => {
    try {
      // 1.1. 优先响应 CORS 预检请求
      if (req.method === "OPTIONS") {
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1"); // 解析请求路径与查询参数
      const { pathname } = url;

      // 1.1.1. 配额重置记录读写接口（GET / POST / DELETE /api/resets）
      if (pathname === "/api/resets" && req.method === "GET") {
        sendJson(res, 200, { resets: provider.getResets ? provider.getResets() : [] });
        return;
      }
      if (pathname === "/api/resets" && req.method === "POST") {
        if (!provider.addReset) {
          sendJson(res, 501, { error: "Resets store unavailable" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
          const pool =
            body.pool === "gemini" || body.pool === "claude" || body.pool === "all"
              ? body.pool
              : "all";
          const note = typeof body.note === "string" ? body.note : "";
          const resets = provider.addReset({ timestamp, pool, note });
          sendJson(res, 201, { resets });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "参数不合法" });
        }
        return;
      }
      if (pathname.startsWith("/api/resets/") && req.method === "DELETE") {
        if (!provider.deleteReset) {
          sendJson(res, 501, { error: "Resets store unavailable" });
          return;
        }
        const rawId = pathname.slice("/api/resets/".length);
        if (!rawId || rawId.includes("/")) {
          sendJson(res, 404, { error: "Reset record not found" });
          return;
        }
        const resets = provider.deleteReset(decodeURIComponent(rawId));
        sendJson(res, 200, { resets });
        return;
      }

      // 1.1.2. 周配额剩余%校准读写接口（GET / POST / DELETE /api/calibrations）
      if (pathname === "/api/calibrations" && req.method === "GET") {
        sendJson(res, 200, {
          calibrations: provider.getCalibrations ? provider.getCalibrations() : {},
        });
        return;
      }
      if (pathname === "/api/calibrations" && req.method === "POST") {
        if (!provider.setCalibration) {
          sendJson(res, 501, { error: "Calibrations store unavailable" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const key = typeof body.key === "string" ? body.key : "";
          const calibrations = provider.setCalibration(key, {
            remainingPct: Number(body.remainingPct),
            calibratedCostUsd: Number(body.calibratedCostUsd),
            calibratedTokens: Number(body.calibratedTokens),
            calibratedAt:
              typeof body.calibratedAt === "string" ? body.calibratedAt : new Date().toISOString(),
          });
          sendJson(res, 200, { calibrations });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "参数不合法" });
        }
        return;
      }
      if (pathname === "/api/calibrations" && req.method === "DELETE") {
        if (!provider.deleteCalibration) {
          sendJson(res, 501, { error: "Calibrations store unavailable" });
          return;
        }
        const key = url.searchParams.get("key")?.trim() ?? "";
        const calibrations = provider.deleteCalibration(key);
        sendJson(res, 200, { calibrations });
        return;
      }

      // 1.1.3. 本地仓库自更新检测与一键执行接口（GET / POST /api/update）
      if (pathname === "/api/update" && req.method === "GET") {
        const force = url.searchParams.get("force") === "1";
        if (!force && updateCheckCache && Date.now() < updateCheckCache.expiresAt) {
          sendJson(res, 200, { ...updateCheckCache.data, updating: updateInFlight });
          return;
        }
        const data = await runUpdateScriptJson(["--check", "--json"], 15_000);
        updateCheckCache = { data, expiresAt: Date.now() + UPDATE_CHECK_TTL_MS };
        sendJson(res, 200, { ...data, updating: updateInFlight });
        return;
      }
      if (pathname === "/api/update" && req.method === "POST") {
        if (updateInFlight) {
          sendJson(res, 409, { ok: false, updated: false, message: "正在更新中，请稍候" });
          return;
        }
        updateInFlight = true;
        try {
          const result = await runUpdateScriptJson(["--no-restart", "--json"], 180_000);
          updateCheckCache = null;
          const willRestart = Boolean(result.ok && result.updated && result.needRestart);
          sendJson(res, result.ok ? 200 : 400, { ...result, restarting: willRestart });
          if (willRestart && fs.existsSync(SERVICE_SCRIPT_PATH)) {
            setTimeout(() => {
              const child = spawn(process.execPath, [SERVICE_SCRIPT_PATH, "restart"], {
                cwd: REPO_ROOT,
                detached: true,
                stdio: "ignore",
              });
              child.unref();
            }, 350);
          }
        } finally {
          updateInFlight = false;
        }
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      // 1.2. 健康检查与汇总查询路由
      if (pathname === "/api/health") {
        sendJson(res, 200, provider.getHealth());
        return;
      }

      if (pathname === "/api/summary") {
        const filters = parseSummaryQuery(url);
        sendJson(
          res,
          200,
          provider.getSummary(filters),
          buildId ? { "X-Hamiji-Build": buildId } : undefined
        );
        return;
      }

      // 1.3. 单会话详情路由（支持 URL 编码 ID）
      if (pathname.startsWith("/api/conversations/")) {
        const rawId = pathname.slice("/api/conversations/".length);
        if (!rawId || rawId.includes("/")) {
          sendJson(res, 404, { error: "Conversation not found" });
          return;
        }
        const conversationId = decodeURIComponent(rawId);
        const detail = provider.getConversationDetail(conversationId);
        if (!detail) {
          sendJson(res, 404, { error: "Conversation not found" });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      // 1.4. JSON 与 UTF-8 BOM CSV 导出路由
      if (pathname === "/api/export.json") {
        const summary = provider.getSummary(parseSummaryQuery(url));
        sendJson(res, 200, summary, {
          "Content-Disposition": 'attachment; filename="antigravity-tokens.json"',
        });
        return;
      }

      if (pathname === "/api/export.csv") {
        const summary = provider.getSummary(parseSummaryQuery(url));
        const csvPayload = serializeConversationsCsv(summary.conversations);
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="antigravity-tokens.csv"',
        });
        res.end(csvPayload);
        return;
      }

      // 1.5. 未匹配的其他 /api/* 路径一律返回 404 JSON，避免误落入 SPA 回退
      if (pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "API endpoint not found" });
        return;
      }

      // 2. 非 API GET 请求交由静态目录托管或 SPA 回退处理
      serveStaticOrFallback(req.url ?? "/", options?.staticDir, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        res.end();
      }
    }
  });
}
