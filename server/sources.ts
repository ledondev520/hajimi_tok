/**
 * Input: node:crypto、node:fs、node:os、node:path 与 ../src/types/telemetry 的 DataSourceKind 类型。
 * Output: 导出 discoverLocalDataSources() 自动发现本机原生 Antigravity（含 antigravity-cli）与 T3 Code 多账号数据目录，按同 Google 账号无侵入自动归并并绑定官方 live-quota.json。
 * Pos: 本地多数据源发现与同账号归并层（零硬编码个人路径、零凭证读取，自动兼容原生 ~/.gemini 与 T3 Code 多实例）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DataSourceKind } from "../src/types/telemetry";

/** 发现到的单个本地 AntiGravity 数据源描述符 */
export interface DiscoveredDataSource {
  id: string; // 唯一源 ID（native / t3:<instance> / custom）
  label: string; // 界面可读名称
  kind: DataSourceKind; // 数据源分类
  dataDir: string; // AntiGravity 主数据目录绝对路径
  profileDir?: string; // T3 Code 实例隔离根目录（GEMINI_HOME，包含 antigravity-acp 与 antigravity-cli）
  extraDataDirs?: string[]; // 按同 Google 账号自动归并进来的额外本地数据目录（如原生 App / CLI）
  stateDir?: string; // 该数据源独立状态目录（用于隔离周校准与重置记录）
  liveQuotaPath?: string; // 明确绑定的官方 live-quota.json 路径（仅绑给与 agy 钥匙串同账号的源，绝不串号）
  accountEmail?: string; // 内部归并用的小写账号邮箱（仅服务端本地匹配，不暴露前端）
  mergedKinds?: DataSourceKind[]; // 归并包含的客户端类型列表（如 ["t3", "native"]）
}

/** 自动发现可选覆盖参数（主要供单元测试隔离宿主机路径） */
export interface DiscoverSourcesOptions {
  customDataDir?: string; // 显式指定单目录或 path.delimiter 分隔多目录
  homeDir?: string; // 覆盖 os.homedir()
  t3UserdataDir?: string; // 覆盖 ~/.t3/userdata
  stateRootDir?: string; // 覆盖 ~/.hamiji-sta
}

const LOG_FAST_READ_BYTES = 16 * 1024; // 实测 applyAuthResult 位于前 10KB，优先读 16KB 减少一半 I/O，未命中再补读至 32KB
const LOG_HEAD_READ_BYTES = 32 * 1024;
const ISOLATED_UNANIMOUS_EARLY_STOP = 10; // 最新连续 10 份隔离日志指向同一邮箱时提前结束抽样
const AUTH_EMAIL_RE = /applyAuthResult:\s*email=([^\s,]+@[^\s,]+)/i;
const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 职责：将任意源 ID 清洗为安全的文件系统目录名，防止路径穿越或非法字符。
 * 参数：rawId — 原始数据源 ID。
 * 返回值：仅含字母、数字、下划线与连字符的安全目录名。
 */
export function sanitizeSourceSlug(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "source";
}

/** 归一化合法邮箱字符串 */
function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().toLowerCase();
  return SIMPLE_EMAIL_RE.test(cleaned) ? cleaned : undefined;
}

/** 仅读取单个普通 .log 文件头部（优先 16KB，未命中补读至 32KB）并提取启动认证邮箱与文件隔离标记（绝不碰凭证文件） */
function readLogAuthHint(filePath: string): { email: string; isolatedFileStorage: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(LOG_HEAD_READ_BYTES);
    let totalRead = fs.readSync(fd, buf, 0, LOG_FAST_READ_BYTES, 0);
    if (totalRead <= 0) return undefined;
    let text = buf.subarray(0, totalRead).toString("utf8");
    let m = text.match(AUTH_EMAIL_RE);
    if (!m && totalRead === LOG_FAST_READ_BYTES) {
      const more = fs.readSync(fd, buf, totalRead, LOG_HEAD_READ_BYTES - totalRead, totalRead);
      if (more > 0) {
        totalRead += more;
        text = buf.subarray(0, totalRead).toString("utf8");
        m = text.match(AUTH_EMAIL_RE);
      }
    }
    const email = m ? normalizeEmail(m[1]) : undefined;
    if (!email) return undefined;
    return { email, isolatedFileStorage: text.includes("Using file-based token storage") };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }
}

/** 从投票桶中选出票数最高（平票取最新）的邮箱 */
function pickMajorityEmail(counts: Map<string, { count: number; firstIndex: number }>): string | undefined {
  let winner = "";
  let bestCount = -1;
  let bestFirst = Infinity;
  for (const [email, stat] of counts.entries()) {
    if (stat.count > bestCount || (stat.count === bestCount && stat.firstIndex < bestFirst)) {
      winner = email;
      bestCount = stat.count;
      bestFirst = stat.firstIndex;
    }
  }
  return winner || undefined;
}

/**
 * 职责：从候选数据目录的普通启动日志（cli.log / log/*.log）只读推断归属 Google 账号邮箱。
 * 思路：抽样最新最多 50 份日志做多数投票（优先采纳明确启用文件隔离存储的日志，免疫 agy 1.5.16~1.5.18 钥匙串回退串号）。
 * 参数：dirs — 按优先级排列的数据目录列表。
 * 返回值：规范化小写邮箱，无法推断时返回 undefined。
 */
export function detectAccountEmailFromLogs(dirs: string[]): string | undefined {
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const directCliLog = path.join(dir, "cli.log");
    if (fs.existsSync(directCliLog)) {
      const hit = readLogAuthHint(directCliLog);
      if (hit) return hit.email;
    }
    const logDir = path.join(dir, "log");
    if (!fs.existsSync(logDir)) continue;
    try {
      const files = fs
        .readdirSync(logDir)
        .filter((name) => name.endsWith(".log"))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 50);
      const isolatedCounts = new Map<string, { count: number; firstIndex: number }>();
      const allCounts = new Map<string, { count: number; firstIndex: number }>();
      for (let i = 0; i < files.length; i += 1) {
        const hit = readLogAuthHint(path.join(logDir, files[i]));
        if (!hit) continue;
        const addVote = (map: Map<string, { count: number; firstIndex: number }>) => {
          const cur = map.get(hit.email);
          if (cur) cur.count += 1;
          else map.set(hit.email, { count: 1, firstIndex: i });
        };
        addVote(allCounts);
        if (hit.isolatedFileStorage) {
          addVote(isolatedCounts);
          if (isolatedCounts.size === 1 && isolatedCounts.get(hit.email)!.count >= ISOLATED_UNANIMOUS_EARLY_STOP) {
            break;
          }
        }
      }
      const winner = pickMajorityEmail(isolatedCounts) ?? pickMajorityEmail(allCounts);
      if (winner) return winner;
    } catch {
      /* 忽略无权限日志目录 */
    }
  }
  return undefined;
}

/** 从 live-quota.json 读取由 agy 官方 statusLine 写入的登录邮箱 */
function readLiveQuotaAccountEmail(liveQuotaPath: string): string | undefined {
  if (!liveQuotaPath || !fs.existsSync(liveQuotaPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(liveQuotaPath, "utf8")) as { accountEmail?: unknown };
    return normalizeEmail(parsed?.accountEmail);
  } catch {
    return undefined;
  }
}

/** 将额外目录与端类型合并进目标主数据源，自动去重 */
function mergeIntoSource(
  target: DiscoveredDataSource,
  dirs: string[],
  kind: DataSourceKind
): void {
  const existingDirs = new Set([target.dataDir, ...(target.extraDataDirs ?? [])]);
  const extras = [...(target.extraDataDirs ?? [])];
  for (const d of dirs) {
    if (d && !existingDirs.has(d)) {
      existingDirs.add(d);
      extras.push(d);
    }
  }
  if (extras.length > 0) target.extraDataDirs = extras;
  const kinds = new Set<DataSourceKind>(target.mergedKinds ?? [target.kind]);
  kinds.add(kind);
  if (kinds.size > 1) target.mergedKinds = [...kinds];
}

/**
 * 职责：检测指定数据目录是否包含任意可读的 AntiGravity 会话产物。
 * 参数：dir — 候选数据根目录。
 * 返回值：存在至少一个 SQLite 会话库、摘要库或 transcript.jsonl 时返回 true。
 */
function hasTelemetryArtifacts(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, "conversation_summaries.db"))) return true;
  const convDir = path.join(dir, "conversations");
  if (fs.existsSync(convDir)) {
    try {
      if (fs.readdirSync(convDir).some((n) => n.endsWith(".db"))) return true;
    } catch {
      /* 忽略无权限目录 */
    }
  }
  const brainDir = path.join(dir, "brain");
  if (fs.existsSync(brainDir)) {
    try {
      for (const ent of fs.readdirSync(brainDir, { withFileTypes: true })) {
        if (
          ent.isDirectory() &&
          fs.existsSync(path.join(brainDir, ent.name, ".system_generated", "logs", "transcript.jsonl"))
        ) {
          return true;
        }
      }
    } catch {
      /* 忽略无权限目录 */
    }
  }
  return false;
}

/**
 * 职责：读取 T3 Code 的 settings.json，将 antigravity 实例名哈希映射到展示名称。
 * 思路：T3 Code 按 sha256(providerInstanceKey) 切分 providers/antigravity/<hash>/antigravity-acp，
 *      因此对所有 driver === "antigravity" 的键计算 SHA-256 即可精准回填用户在 T3 中配置的显示名。
 * 参数：t3Root — T3 Code userdata 根目录。
 * 返回值：hash -> { instanceKey, label } 映射表。
 */
function readT3ProviderLabels(
  t3Root: string
): Map<string, { instanceKey: string; label: string }> {
  const map = new Map<string, { instanceKey: string; label: string }>();
  const settingsPath = path.join(t3Root, "settings.json");
  if (!fs.existsSync(settingsPath)) return map;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      providerInstances?: Record<string, { driver?: string; displayName?: string }>;
    };
    const instances = parsed?.providerInstances;
    if (!instances || typeof instances !== "object") return map;
    for (const [key, cfg] of Object.entries(instances)) {
      if (!cfg || cfg.driver !== "antigravity") continue;
      const hash = crypto.createHash("sha256").update(key).digest("hex");
      const label = typeof cfg.displayName === "string" && cfg.displayName.trim()
        ? cfg.displayName.trim()
        : key;
      map.set(hash, { instanceKey: key, label });
    }
  } catch {
    /* settings.json 缺失或格式变动时静默回退为短哈希标签 */
  }
  return map;
}

/**
 * 职责：按优先级发现本机全部 AntiGravity 遥测数据目录，并自动将同一 Google 账号的 T3 与原生目录归并为统一账号视图。
 * 参数：options — 可选自定义目录与测试覆盖路径。
 * 返回值：至少包含 1 个元素的 DiscoveredDataSource 数组。
 */
export function discoverLocalDataSources(
  options: DiscoverSourcesOptions = {}
): DiscoveredDataSource[] {
  const homeDir = options.homeDir ?? os.homedir();
  const stateRoot =
    options.stateRootDir ||
    process.env.AGY_STATE_DIR?.trim() ||
    path.join(homeDir, ".hamiji-sta");
  const rootLiveQuotaPath = options.stateRootDir
    ? path.join(stateRoot, "live-quota.json")
    : process.env.AGY_LIVE_QUOTA_FILE?.trim() || path.join(stateRoot, "live-quota.json");

  // 0. 显式传入 customDataDir 或环境变量 AGY_DATA_DIR 时严格按指定路径运行（支持 path.delimiter 多路径）
  const explicitRaw = (options.customDataDir ?? process.env.AGY_DATA_DIR ?? "").trim();
  if (explicitRaw) {
    const parts = explicitRaw
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean);
    const uniqueParts = [...new Set(parts)];
    if (uniqueParts.length === 1) {
      const dir = uniqueParts[0];
      return [
        {
          id: "custom",
          label: path.basename(dir) || "自定义目录",
          kind: "custom",
          dataDir: dir,
        },
      ];
    }
    return uniqueParts.map((dir, idx) => {
      const id = `custom:${idx + 1}`;
      const base = path.basename(dir);
      const parent = path.basename(path.dirname(dir));
      const label = base === "antigravity-acp" && parent ? `源 ${idx + 1} (${parent.slice(0, 8)})` : base || `源 ${idx + 1}`;
      return {
        id,
        label,
        kind: "custom" as const,
        dataDir: dir,
        stateDir: path.join(stateRoot, "sources", sanitizeSourceSlug(id)),
      };
    });
  }

  // 1. 扫描 T3 Code 多账号隔离目录（用户显式配置的各 T3 实例互不合并，保留独立身份与历史记录）
  const t3Root =
    options.t3UserdataDir ||
    process.env.T3_USERDATA_DIR?.trim() ||
    path.join(homeDir, ".t3", "userdata");
  const t3ProvidersDir = path.join(t3Root, "providers", "antigravity");
  const labelMap = readT3ProviderLabels(t3Root);
  const results: DiscoveredDataSource[] = [];

  if (fs.existsSync(t3ProvidersDir)) {
    try {
      const entries = fs
        .readdirSync(t3ProvidersDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        const acpDir = path.join(t3ProvidersDir, ent.name, "antigravity-acp");
        if (!fs.existsSync(acpDir) || !fs.statSync(acpDir).isDirectory()) continue;
        const meta = labelMap.get(ent.name);
        const instanceKey = meta?.instanceKey || ent.name.slice(0, 8);
        const id = `t3:${instanceKey}`;
        const label = meta?.label || `T3 (${ent.name.slice(0, 8)})`;
        const accountEmail = detectAccountEmailFromLogs([acpDir]);

        results.push({
          id,
          label,
          kind: "t3",
          dataDir: acpDir,
          profileDir: path.join(t3ProvidersDir, ent.name),
          stateDir: path.join(stateRoot, "sources", sanitizeSourceSlug(id)),
          ...(accountEmail ? { accountEmail } : {}),
        });
      }
    } catch {
      /* 无权限或目录不可读时静默跳过 */
    }
  }

  // 2. 扫描原生 ~/.gemini/antigravity 与 ~/.gemini/antigravity-cli，仅在唯一匹配某个 T3 账号邮箱时自动合并
  const nativeAppDir = path.join(homeDir, ".gemini", "antigravity");
  const nativeCliDir = path.join(homeDir, ".gemini", "antigravity-cli");
  const liveQuotaEmail =
    readLiveQuotaAccountEmail(rootLiveQuotaPath) ?? detectAccountEmailFromLogs([nativeCliDir]);
  const nativeEmail = detectAccountEmailFromLogs([nativeCliDir, nativeAppDir]) ?? liveQuotaEmail;

  const nativeDirs: string[] = [];
  if (results.length === 0 || hasTelemetryArtifacts(nativeAppDir)) {
    nativeDirs.push(nativeAppDir);
  }
  if (hasTelemetryArtifacts(nativeCliDir)) {
    nativeDirs.push(nativeCliDir);
  }

  if (nativeDirs.length > 0) {
    const matchedT3List = nativeEmail
      ? results.filter((r) => r.kind === "t3" && r.accountEmail === nativeEmail)
      : [];
    if (matchedT3List.length === 1) {
      mergeIntoSource(matchedT3List[0], nativeDirs, "native");
    } else {
      results.push({
        id: "native",
        label: "原生 Antigravity",
        kind: "native",
        dataDir: nativeDirs[0],
        ...(nativeDirs.length > 1 ? { extraDataDirs: nativeDirs.slice(1) } : {}),
        ...(options.stateRootDir ? { stateDir: stateRoot } : {}),
        ...(nativeEmail ? { accountEmail: nativeEmail } : {}),
      });
    }
  }

  // 3. 精准绑定官方 agy live-quota.json：仅在唯一匹配到归属账号时绑定，多实例歧义或异号绝不串号
  if (liveQuotaEmail) {
    const owners = results.filter((r) => r.accountEmail === liveQuotaEmail);
    if (owners.length === 1) {
      owners[0].liveQuotaPath = rootLiveQuotaPath;
    }
  } else {
    const nativeOnly = results.find((r) => r.kind === "native");
    if (nativeOnly && !nativeOnly.liveQuotaPath) {
      nativeOnly.liveQuotaPath = rootLiveQuotaPath;
    }
  }

  return results;
}
