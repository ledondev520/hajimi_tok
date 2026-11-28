/**
 * Input: node:crypto、node:fs、node:os、node:path 与 ../src/types/telemetry 的 DataSourceKind 类型。
 * Output: 导出 discoverLocalDataSources() 自动发现本机原生 Antigravity 与 T3 Code 多账号数据目录。
 * Pos: 本地多数据源发现层（零硬编码个人路径，自动兼容原生 ~/.gemini/antigravity 与 T3 Code 多实例）。
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
  dataDir: string; // AntiGravity 数据目录绝对路径
  stateDir?: string; // 该数据源独立状态目录（用于隔离周校准与重置记录）
}

/** 自动发现可选覆盖参数（主要供单元测试隔离宿主机路径） */
export interface DiscoverSourcesOptions {
  customDataDir?: string; // 显式指定单目录或 path.delimiter 分隔多目录
  homeDir?: string; // 覆盖 os.homedir()
  t3UserdataDir?: string; // 覆盖 ~/.t3/userdata
  stateRootDir?: string; // 覆盖 ~/.hamiji-sta
}

/**
 * 职责：将任意源 ID 清洗为安全的文件系统目录名，防止路径穿越或非法字符。
 * 参数：rawId — 原始数据源 ID。
 * 返回值：仅含字母、数字、下划线与连字符的安全目录名。
 */
export function sanitizeSourceSlug(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "source";
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
 * 职责：按优先级发现本机全部 AntiGravity 遥测数据目录（显式 AGY_DATA_DIR 优先，否则自动扫描 T3 Code 与原生目录）。
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

  // 1. 扫描 T3 Code 多账号隔离目录（~/.t3/userdata/providers/antigravity/<hash>/antigravity-acp）
  const t3Root =
    options.t3UserdataDir ||
    process.env.T3_USERDATA_DIR?.trim() ||
    path.join(homeDir, ".t3", "userdata");
  const t3ProvidersDir = path.join(t3Root, "providers", "antigravity");
  const labelMap = readT3ProviderLabels(t3Root);
  const t3Sources: DiscoveredDataSource[] = [];

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
        t3Sources.push({
          id,
          label,
          kind: "t3",
          dataDir: acpDir,
          stateDir: path.join(stateRoot, "sources", sanitizeSourceSlug(id)),
        });
      }
    } catch {
      /* 无权限或目录不可读时静默跳过 */
    }
  }

  // 2. 检查原生 ~/.gemini/antigravity 目录（存在数据或无 T3 实例时保留）
  const nativeDir = path.join(homeDir, ".gemini", "antigravity");
  const results: DiscoveredDataSource[] = [...t3Sources];
  if (t3Sources.length === 0 || hasTelemetryArtifacts(nativeDir)) {
    results.push({
      id: "native",
      label: "原生 Antigravity",
      kind: "native",
      dataDir: nativeDir,
      ...(options.stateRootDir ? { stateDir: stateRoot } : {}),
    });
  }

  return results;
}
