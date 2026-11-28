/**
 * Input: node:http、node:fs、node:path、node:url 内置模块与 TelemetryProvider 领域服务接口。
 * Output: 导出 createTelemetryHttpServer HTTP 服务工厂、resolveUpdateServiceAction 动作归一化及查询参数解析、CSV 序列化工具函数。
 * Pos: 服务端只读 HTTP API 路由层、CSV/JSON 报表导出层与前端静态资源安全托管层。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import zlib from "node:zlib";
import type {
  ConversationUsageSummary,
  QuotaCycleMode,
  TelemetryFilterOptions,
  TelemetryProvider,
} from "../src/types/telemetry";

const VALID_CYCLES = new Set<QuotaCycleMode>(["5h", "prev-5h", "7d", "prev-7d", "today", "all"]); // 合法配额周期枚举集合
const WINDOW_CYCLE_RE = /^window:\d+:\d+$/; // 任意历史周周期窗口标识正则
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i; // 仅允许本地回环 Host 头，防御 DNS Rebinding
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]); // 受信回环 Origin 主机名集合
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // 仓库根目录
const UPDATE_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "update.mjs"); // 一键自更新脚本路径
const SERVICE_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "service.mjs"); // 常驻服务脚本路径
const UPDATE_LOCK_PATH = path.join(
  process.env.AGY_STATE_DIR?.trim() || path.join(os.homedir(), ".hamiji-sta"),
  "update.lock"
); // 与 scripts/update.mjs 共享的跨进程更新锁路径
const UPDATE_CHECK_TTL_MS = 5 * 60_000; // 更新检测结果缓存 5 分钟，避免反复检测
const sharedUpdateState: {
  checkCache: { data: Record<string, unknown>; expiresAt: number } | null;
  cacheVersion: number;
  inFlight: boolean;
} = { checkCache: null, cacheVersion: 0, inFlight: false }; // 跨回环多监听实例共享更新状态与缓存版本

/** 校验并归一化 update.mjs 返回的服务动作（显式 null 时不触发服务重启）。 */
export function resolveUpdateServiceAction(result: Record<string, unknown>): "install" | "restart" | null {
  if (result.serviceAction === "install" || result.serviceAction === "restart") return result.serviceAction;
  if (result.serviceAction === null) return null;
  return result.needRestart ? "restart" : null;
}

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
 * 职责：校验请求 Host 头是否为合法本地回环地址（防御 DNS Rebinding）。
 * 参数：hostHeader — 请求 Host 头。
 * 返回值：受信回环 Host 返回 true，否则 false。
 */
function isTrustedLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return LOOPBACK_HOST_RE.test(hostHeader.trim());
}

/**
 * 职责：校验可选浏览器 Origin 头是否来自本地回环源（仅放行 http://127.0.0.1|localhost|[::1]）。
 * 参数：originHeader — 请求 Origin 头。
 * 返回值：{ allowed, origin }，无 Origin 头时视为同源/CLI 请求返回 allowed=true, origin=null。
 */
function resolveTrustedOrigin(originHeader: string | undefined): {
  allowed: boolean;
  origin: string | null;
} {
  if (!originHeader) return { allowed: true, origin: null };
  const raw = originHeader.trim();
  try {
    const parsed = new URL(raw);
    if (
      parsed.origin === raw &&
      parsed.protocol === "http:" &&
      LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())
    ) {
      return { allowed: true, origin: raw };
    }
  } catch {
    /* 非法 Origin（如 "null"）一律拒绝 */
  }
  return { allowed: false, origin: null };
}

/**
 * 职责：仅对受信本地回环 Origin 反射精确 CORS 响应头（绝不返回通配符 *）。
 * 参数：res — Node HTTP 服务端响应对象；trustedOrigin — 已验证的本地回环 Origin 或 null。
 * 返回值：无返回值。
 */
function setCorsHeaders(res: http.ServerResponse, trustedOrigin: string | null): void {
  if (trustedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", trustedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, If-None-Match");
  }
}

/**
 * 职责：安全读取有界 HTTP 请求体并解析为 JSON 对象。
 * 参数：req — Node HTTP 请求对象；maxBytes — 允许的最大字节数（默认 8KB，批量校准迁移放宽至 256KB）。
 * 返回值：解析后的 Record 对象。
 */
async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 8192,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("请求体过大");
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
  trustedOrigin: string | null = null,
  req?: http.IncomingMessage,
  enableEtag = false,
): void {
  // 0. 序列化响应体，按需执行 ETag 304 短路与大载荷（>=16KB）快速 gzip 压缩
  const body = JSON.stringify(payload);
  setCorsHeaders(res, trustedOrigin);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  };
  if (enableEtag && statusCode === 200) {
    const etag = `"${crypto.createHash("sha1").update(body).digest("base64url")}"`;
    headers.ETag = etag;
    headers["Cache-Control"] = "no-cache";
    const inm = String(req?.headers["if-none-match"] || "").trim();
    if (inm === etag || inm === `W/${etag}`) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  const acceptEnc = String(req?.headers["accept-encoding"] || "");
  if (body.length >= 16_384 && /\bgzip\b/i.test(acceptEnc)) {
    const gz = zlib.gzipSync(body, { level: 1 });
    headers["Content-Encoding"] = "gzip";
    headers.Vary = trustedOrigin ? "Origin, Accept-Encoding" : "Accept-Encoding";
    res.writeHead(statusCode, headers);
    res.end(gz);
    return;
  }
  // 1.1. 输出 UTF-8 JSON 正文并结束响应
  res.writeHead(statusCode, headers);
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

  const rawSource = url.searchParams.get("source")?.trim();
  const source = rawSource ? rawSource : undefined;

  // 1.2. 解析归档会话开关（默认 true）与强制刷新标志
  const includeArchived = url.searchParams.get("includeArchived") !== "false";
  const rawRefresh = url.searchParams.get("refresh");
  const forceRefresh = rawRefresh === "1" || rawRefresh === "true";
  const rawNodeLimit = url.searchParams.get("nodeLimit");
  const parsedLimit = rawNodeLimit !== null && rawNodeLimit !== "" ? Number(rawNodeLimit) : NaN;
  const nodeLimit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? Math.min(5000, Math.floor(parsedLimit)) : undefined;

  return {
    ...(source ? { source } : {}),
    ...(cycle ? { cycle } : {}),
    days,
    workspace,
    model,
    search,
    includeArchived,
    forceRefresh,
    ...(nodeLimit !== undefined ? { nodeLimit } : {}),
  };
}

/**
 * 职责：对单个 CSV 单元格执行电子表格公式注入防护与 RFC 4180 转义（保留数值列语义）。
 * 参数：value — 原始字段值（字符串、数值或布尔值）。
 * 返回值：安全转义后的 CSV 单元格文本。
 */
function escapeCsvCell(value: string | number | boolean): string {
  // 0. 统一转换为字符串形式，对以 = + - @ 开头的文本单元格加前导单引号阻断电子表格公式执行
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\t\r ]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
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
  trustedOrigin: string | null = null,
  req?: http.IncomingMessage,
): void {
  // 0. 若未配置静态目录或目录不存在，直接返回 404 JSON
  if (!staticDir || !fs.existsSync(staticDir) || !fs.statSync(staticDir).isDirectory()) {
    sendJson(res, 404, { error: "Not found" }, undefined, trustedOrigin);
    return;
  }

  const staticRoot = path.resolve(staticDir); // 规范化静态资源根绝对路径
  const realStaticRoot = fs.realpathSync(staticRoot); // 真实物理根路径（阻断符号链接越界读取）
  const rawPathname = rawUrl.split("?")[0] || "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPathname);
  } catch {
    sendJson(res, 400, { error: "Malformed URL path" }, undefined, trustedOrigin);
    return;
  }

  // 1.1. 在 URL 归一化折叠前拦截原始或编码后的 .. 父目录穿越片段与空字节
  if (
    decodedPath.includes("\0") ||
    rawPathname.split("/").includes("..") ||
    decodedPath.split("/").includes("..")
  ) {
    sendJson(res, 403, { error: "Forbidden" }, undefined, trustedOrigin);
    return;
  }

  const relativeTarget = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolvedCandidate = path.resolve(staticRoot, relativeTarget);
  const relFromRoot = path.relative(staticRoot, resolvedCandidate);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    sendJson(res, 403, { error: "Forbidden" }, undefined, trustedOrigin);
    return;
  }

  // 1.2. 若请求路径精确命中静态文件，校验符号链接真实路径仍落在静态根内后输出
  if (fs.existsSync(resolvedCandidate) && fs.statSync(resolvedCandidate).isFile()) {
    const realCandidate = fs.realpathSync(resolvedCandidate);
    const realRel = path.relative(realStaticRoot, realCandidate);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      sendJson(res, 403, { error: "Forbidden" }, undefined, trustedOrigin);
      return;
    }
    const ext = path.extname(realCandidate).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const isHashedAsset = realRel.startsWith(`assets${path.sep}`) || realRel.startsWith("assets/");
    const rawBuf = fs.readFileSync(realCandidate);
    const acceptEnc = String(req?.headers["accept-encoding"] || "");
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    };
    setCorsHeaders(res, trustedOrigin);
    if (rawBuf.length >= 16_384 && /\bgzip\b/i.test(acceptEnc) && (ext === ".js" || ext === ".css" || ext === ".svg")) {
      headers["Content-Encoding"] = "gzip";
      headers.Vary = trustedOrigin ? "Origin, Accept-Encoding" : "Accept-Encoding";
      res.writeHead(200, headers);
      res.end(zlib.gzipSync(rawBuf, { level: 1 }));
      return;
    }
    res.writeHead(200, headers);
    res.end(rawBuf);
    return;
  }

  // 2. SPA 路由回退至 index.html（同样校验真实路径不越出静态根）
  const indexHtmlPath = path.join(staticRoot, "index.html");
  if (fs.existsSync(indexHtmlPath) && fs.statSync(indexHtmlPath).isFile()) {
    const realIndex = fs.realpathSync(indexHtmlPath);
    const realIndexRel = path.relative(realStaticRoot, realIndex);
    if (realIndexRel.startsWith("..") || path.isAbsolute(realIndexRel)) {
      sendJson(res, 403, { error: "Forbidden" }, undefined, trustedOrigin);
      return;
    }
    setCorsHeaders(res, trustedOrigin);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(fs.readFileSync(realIndex));
    return;
  }

  sendJson(res, 404, { error: "Not found" }, undefined, trustedOrigin);
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

  // 0.1. 构建无框架原生 HTTP 服务器并统一包裹安全来源边界与异常边界
  return http.createServer(async (req, res) => {
    let trustedOrigin: string | null = null;
    try {
      // 1.0. 严格校验本地回环 Host、Origin 与跨站请求边界，阻止外部网页窃取遥测数据或触发本地写操作
      if (!isTrustedLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: "Forbidden host" });
        return;
      }
      const originCheck = resolveTrustedOrigin(req.headers.origin);
      if (!originCheck.allowed) {
        sendJson(res, 403, { error: "Forbidden origin" });
        return;
      }
      trustedOrigin = originCheck.origin;

      const url = new URL(req.url ?? "/", "http://127.0.0.1"); // 解析请求路径与查询参数
      const { pathname } = url;
      const secFetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
      const isMutating = req.method === "POST" || req.method === "DELETE";
      if (secFetchSite === "cross-site" && !trustedOrigin && (isMutating || pathname.startsWith("/api/"))) {
        sendJson(res, 403, { error: "Forbidden cross-site request" });
        return;
      }

      // 1.1. 优先响应已通过回环校验的 CORS 预检请求
      if (req.method === "OPTIONS") {
        setCorsHeaders(res, trustedOrigin);
        res.writeHead(204);
        res.end();
        return;
      }

      const replyJson = (statusCode: number, payload: unknown, extraHeaders?: Record<string, string>) =>
        sendJson(res, statusCode, payload, extraHeaders, trustedOrigin);
      const sourceParam = url.searchParams.get("source")?.trim() || undefined;

      // 1.1.1. 配额重置记录读写接口（GET / POST / DELETE /api/resets）
      if (pathname === "/api/resets" && req.method === "GET") {
        replyJson(200, { resets: provider.getResets ? provider.getResets(sourceParam) : [] });
        return;
      }
      if (pathname === "/api/resets" && req.method === "POST") {
        if (!provider.addReset) {
          replyJson(501, { error: "Resets store unavailable" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
          const rawPool = body.pool === undefined || body.pool === "" ? "all" : body.pool;
          if (rawPool !== "gemini" && rawPool !== "claude" && rawPool !== "all") {
            replyJson(400, { error: "无效的配额池类型（仅支持 all / gemini / claude）" });
            return;
          }
          const note = typeof body.note === "string" ? body.note : "";
          const resets = provider.addReset({ timestamp, pool: rawPool, note }, sourceParam);
          replyJson(201, { resets });
        } catch (err) {
          replyJson(400, { error: err instanceof Error ? err.message : "参数不合法" });
        }
        return;
      }
      if (pathname.startsWith("/api/resets/") && req.method === "DELETE") {
        if (!provider.deleteReset) {
          replyJson(501, { error: "Resets store unavailable" });
          return;
        }
        const rawId = pathname.slice("/api/resets/".length);
        if (!rawId || rawId.includes("/")) {
          replyJson(404, { error: "Reset record not found" });
          return;
        }
        try {
          const resets = provider.deleteReset(decodeURIComponent(rawId), sourceParam);
          replyJson(200, { resets });
        } catch (err) {
          replyJson(400, { error: err instanceof Error ? err.message : "删除重置记录失败" });
        }
        return;
      }

      // 1.1.2. 周配额剩余%校准读写接口（GET / POST / DELETE /api/calibrations）
      if (pathname === "/api/calibrations" && req.method === "GET") {
        if (provider.getCalibrationsState) {
          const state = provider.getCalibrationsState(sourceParam);
          if (!state.ok) {
            replyJson(500, { error: state.error, corrupted: true });
            return;
          }
          replyJson(200, { calibrations: state.calibrations, initialized: state.initialized });
          return;
        }
        replyJson(200, {
          calibrations: provider.getCalibrations ? provider.getCalibrations(sourceParam) : {},
          initialized: provider.isCalibrationsInitialized ? provider.isCalibrationsInitialized(sourceParam) : false,
        });
        return;
      }
      if (pathname === "/api/calibrations" && req.method === "POST") {
        if (!provider.setCalibration) {
          replyJson(501, { error: "Calibrations store unavailable" });
          return;
        }
        try {
          const body = await readJsonBody(req, 256 * 1024);
          if (body.batch !== undefined) {
            if (!provider.migrateCalibrationsBatch) {
              replyJson(501, { error: "Calibrations atomic batch migration unavailable" });
              return;
            }
            if (!body.batch || typeof body.batch !== "object" || Array.isArray(body.batch)) {
              replyJson(400, { error: "批量迁移数据必须为 JSON 对象" });
              return;
            }
            const res = provider.migrateCalibrationsBatch(
              body.batch as Record<
                string,
                { remainingPct: number; calibratedCostUsd: number; calibratedTokens: number; calibratedAt: string }
              >,
              sourceParam
            );
            if (res.conflict) {
              replyJson(409, { calibrations: res.calibrations, initialized: true, alreadyInitialized: true });
              return;
            }
            replyJson(200, { calibrations: res.calibrations, initialized: true });
            return;
          }
          const key = typeof body.key === "string" ? body.key : "";
          const source = body.source === "auto" ? "auto" : "manual";
          let calibratedAt: string;
          if (body.calibratedAt === undefined) {
            if (source === "auto") {
              replyJson(400, { error: "自动采样写入必须提供有效的 calibratedAt 采样时间" });
              return;
            }
            calibratedAt = new Date().toISOString();
          } else if (typeof body.calibratedAt === "string" && body.calibratedAt.trim()) {
            calibratedAt = body.calibratedAt;
          } else {
            replyJson(400, { error: "无效的 calibratedAt 时间格式" });
            return;
          }
          const calibrations = provider.setCalibration(
            key,
            {
              remainingPct: body.remainingPct as number,
              calibratedCostUsd: body.calibratedCostUsd as number,
              calibratedTokens: body.calibratedTokens as number,
              calibratedAt,
            },
            { source },
            sourceParam
          );
          replyJson(200, { calibrations, initialized: true });
        } catch (err) {
          replyJson(400, { error: err instanceof Error ? err.message : "参数不合法" });
        }
        return;
      }
      if (pathname === "/api/calibrations" && req.method === "DELETE") {
        if (!provider.deleteCalibration) {
          replyJson(501, { error: "Calibrations store unavailable" });
          return;
        }
        try {
          const key = url.searchParams.get("key")?.trim() ?? "";
          const atParam = url.searchParams.get("at")?.trim();
          const calibrations = provider.deleteCalibration(key, atParam || undefined, sourceParam);
          replyJson(200, { calibrations });
        } catch (err) {
          replyJson(400, { error: err instanceof Error ? err.message : "删除周校准失败" });
        }
        return;
      }

      // 1.1.3. 本地仓库自更新检测与一键执行接口（GET / POST /api/update，死锁回收与互斥由 update.mjs 统一裁决）
      const isLockHeldByAlive = (): boolean => {
        if (!fs.existsSync(UPDATE_LOCK_PATH)) return false;
        try {
          const parsed = JSON.parse(fs.readFileSync(UPDATE_LOCK_PATH, "utf8")) as { pid?: unknown };
          const pid = Number(parsed?.pid);
          if (!Number.isInteger(pid) || pid <= 0) return false;
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "EPERM");
        }
      };
      if (pathname === "/api/update" && req.method === "GET") {
        const force = url.searchParams.get("force") === "1";
        if (!force && sharedUpdateState.checkCache && Date.now() < sharedUpdateState.checkCache.expiresAt) {
          replyJson(200, { ...sharedUpdateState.checkCache.data, updating: sharedUpdateState.inFlight || isLockHeldByAlive() });
          return;
        }
        const startVer = sharedUpdateState.cacheVersion;
        const data = await runUpdateScriptJson(["--check", "--json"], 55_000);
        if (data.ok === true && sharedUpdateState.cacheVersion === startVer) {
          sharedUpdateState.checkCache = { data, expiresAt: Date.now() + UPDATE_CHECK_TTL_MS };
        }
        replyJson(200, { ...data, updating: sharedUpdateState.inFlight || isLockHeldByAlive() });
        return;
      }
      if (pathname === "/api/update" && req.method === "POST") {
        if (sharedUpdateState.inFlight) {
          replyJson(409, { ok: false, updated: false, busy: true, message: "正在更新中，请稍候" });
          return;
        }
        sharedUpdateState.inFlight = true;
        try {
          const result = await runUpdateScriptJson(["--no-restart", "--no-notify", "--json"], 560_000);
          sharedUpdateState.cacheVersion += 1;
          sharedUpdateState.checkCache = null;
          const serviceAction = resolveUpdateServiceAction(result);
          const willRestart = Boolean(result.ok && result.updated && serviceAction);
          const statusCode = result.busy ? 409 : result.ok ? 200 : 400;
          replyJson(statusCode, { ...result, restarting: willRestart });
          if (willRestart && serviceAction && fs.existsSync(SERVICE_SCRIPT_PATH)) {
            setTimeout(() => {
              const child = spawn(process.execPath, [SERVICE_SCRIPT_PATH, serviceAction], {
                cwd: REPO_ROOT,
                detached: true,
                stdio: "ignore",
              });
              child.unref();
            }, 350);
          }
        } finally {
          sharedUpdateState.inFlight = false;
        }
        return;
      }

      if (req.method !== "GET") {
        replyJson(405, { error: "Method not allowed" });
        return;
      }

      // 1.2. 健康检查、数据源列表与汇总查询路由
      if (pathname === "/api/health") {
        replyJson(200, provider.getHealth(sourceParam));
        return;
      }

      if (pathname === "/api/sources") {
        replyJson(200, { sources: provider.getSources ? provider.getSources() : [] });
        return;
      }

      if (pathname === "/api/summary") {
        const filters = parseSummaryQuery(url);
        sendJson(
          res,
          200,
          provider.getSummary(filters),
          buildId ? { "X-Hamiji-Build": buildId } : undefined,
          trustedOrigin,
          req,
          true
        );
        return;
      }

      // 1.3. 单会话详情路由（支持 URL 编码 ID 与可选 source 过滤）
      if (pathname.startsWith("/api/conversations/")) {
        const rawId = pathname.slice("/api/conversations/".length);
        if (!rawId || rawId.includes("/")) {
          replyJson(404, { error: "Conversation not found" });
          return;
        }
        const conversationId = decodeURIComponent(rawId);
        const detail = provider.getConversationDetail(conversationId, sourceParam);
        if (!detail) {
          replyJson(404, { error: "Conversation not found" });
          return;
        }
        replyJson(200, detail);
        return;
      }

      // 1.4. JSON 与 UTF-8 BOM CSV 导出路由
      if (pathname === "/api/export.json") {
        const summary = provider.getSummary(parseSummaryQuery(url));
        replyJson(200, summary, {
          "Content-Disposition": 'attachment; filename="antigravity-tokens.json"',
        });
        return;
      }

      if (pathname === "/api/export.csv") {
        const summary = provider.getSummary(parseSummaryQuery(url));
        const csvPayload = serializeConversationsCsv(summary.conversations);
        setCorsHeaders(res, trustedOrigin);
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="antigravity-tokens.csv"',
        });
        res.end(csvPayload);
        return;
      }

      // 1.5. 未匹配的其他 /api/* 路径一律返回 404 JSON，避免误落入 SPA 回退
      if (pathname.startsWith("/api/")) {
        replyJson(404, { error: "API endpoint not found" });
        return;
      }

      // 2. 非 API GET 请求交由静态目录托管或 SPA 回退处理
      serveStaticOrFallback(req.url ?? "/", options?.staticDir, res, trustedOrigin, req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message }, undefined, trustedOrigin);
      } else {
        res.end();
      }
    }
  });
}
