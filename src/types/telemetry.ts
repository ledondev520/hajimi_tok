/**
 * Input: 无外部运行时依赖，纯 TypeScript 领域契约定义。
 * Output: 导出 AntiGravity Token 遥测采集、单步记录、多维聚合、价格配置与服务接口类型。
 * Pos: 前后端与 CLI 共享的唯一核心数据契约层（Single Source of Truth）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

/** 单模型每百万 Token 价格配置（单位：USD / 1M Tokens） */
export interface ModelPriceRate {
  modelPattern: string; // 模型匹配关键字或精确名称（小写匹配）
  label: string; // 展示名称
  inputPerMillion: number; // 未命中缓存输入单价（$/1M）
  cacheReadPerMillion: number; // 缓存读取单价（$/1M）
  outputPerMillion: number; // 输出（含思考+回复）单价（$/1M）
}

/** 单次大模型推理步骤（Step / LLM Call）明细 */
export interface StepUsageRecord {
  callIndex: number; // 会话内第几次大模型调用（从 0 开始）
  stepIndex: number; // 对应 transcript / trajectory 中的 step_index
  timestamp: string; // ISO-8601 时间戳（UTC）
  modelId: string; // 内部模型标识（如 gemini-4-argon-d、claude-opus-5-5-medium）
  modelName: string; // 可读模型名称（如 Gemini 4 Argon (High)）
  inputTokens: number; // 本步新增未缓存输入 Token
  cacheReadTokens: number; // 本步命中缓存读取 Token
  outputTokens: number; // 本步总输出 Token（thinking + response）
  thinkingTokens: number; // 思考链消耗 Token（来自 gen_metadata，无则为 0）
  responseTokens: number; // 正文与工具调用输出 Token
  totalTokens: number; // 单步总处理量（inputTokens + cacheReadTokens + outputTokens）
  contextUsed: number; // 当前上下文窗口已用 Token（无则退化为 input + cacheRead + output）
  contextLimit: number; // 模型上下文窗口上限（如 256000，未知为 0）
  latencyMs: number; // 端到端生成耗时（毫秒）
  ttftMs: number; // 首 Token 延迟（毫秒）
  toolNames: string[]; // 本步触发的工具名称列表
  estimatedCostUsd: number; // 按等效 API 费率计算的本步成本（USD）
  cacheSavedUsd: number; // 因 Prompt 缓存命中而节省的等效 API 成本（USD）
  dataSource: "hybrid" | "db" | "jsonl"; // 数据来源标记
}

/** 单个会话（含主会话或 Subagent 子会话）汇总记录 */
export interface ConversationUsageSummary {
  conversationId: string; // 会话 UUID
  title: string; // 会话标题
  firstPromptPreview: string; // 首条用户请求摘要
  workspaceUri: string; // 原始工作区 URI
  workspaceName: string; // 提炼后的项目目录名（如 token、my-project）
  workspacePath: string; // 本地绝对路径
  parentConversationId: string; // 父会话 ID（子代理非空）
  nestingDepth: number; // 嵌套深度（0 表示顶层会话，>0 表示 Subagent）
  agentName: string; // 子代理角色名（若有）
  archived: boolean; // 是否已归档
  status: string; // 会话状态
  createdAt: string; // 首次活动时间（ISO-8601）
  lastModifiedAt: string; // 最近更新时间（ISO-8601）
  models: string[]; // 该会话使用过的可读模型列表
  primaryModel: string; // 消耗 Token 最多的主模型名称
  callCount: number; // LLM 调用总次数
  stepCount: number; // 轨迹总步数（含用户与工具步）
  inputTokens: number; // 累计未缓存输入 Token
  cacheReadTokens: number; // 累计缓存读取 Token
  outputTokens: number; // 累计总输出 Token
  thinkingTokens: number; // 累计思考 Token
  responseTokens: number; // 累计回复 Token
  totalTokens: number; // 累计总 Token（input + cacheRead + output）
  cacheHitRate: number; // 缓存命中率（0 ~ 1）
  peakContextUsed: number; // 峰值上下文占用
  latestContextUsed?: number; // 最近一步当前上下文占用（用于区分已压缩会话与当前偏胖会话）
  contextLimit: number; // 上下文窗口上限
  totalLatencyMs: number; // 累计模型推理耗时（毫秒）
  estimatedCostUsd: number; // 等效 API 总成本（USD）
  cacheSavedUsd: number; // 缓存累计节省成本（USD）
  subagentCount: number; // 直接挂载的子代理会话数量
  sourceId?: string; // 多数据源模式下归属源 ID（如 native / t3:antigravity）
  sourceLabel?: string; // 多数据源模式下归属源展示名称
  t3ThreadId?: string; // 归属的 T3 Code 线程脱敏分组键（供同线程多次 fresh_session 运行折叠合并）
  runTitle?: string; // 被 T3 正式标题替换前保留的单次运行原始标题（展开同线程历史运行时展示）
  cacheTtl?: CacheTtlSummary; // 基于会话内相邻间隔实测反推的缓存 TTL 摘要
}

/** 单个空闲间隔分桶的缓存 TTL 实测衰减点 */
export interface CacheTtlBucket {
  key: string; // 分桶键（"<2m" | "2-5m" | "5-10m" | "10-30m" | "30-60m" | ">60m"）
  label: string; // 展示标签（如 "2~5m"）
  sampleCount: number; // 同模型有效间隔样本数
  keptCount: number; // 命中率 >=50% 保活笔数
  expiredCount: number; // 命中率 <30% 失效笔数
  avgHitRate: number; // 该间隔档位平均缓存命中率（0 ~ 1）
}

/** 实测 Prompt 缓存有效期（TTL）统计摘要 */
export interface CacheTtlSummary {
  sampleCount: number; // >=30s 同模型有效间隔样本数
  expiredCount: number; // 判定为 TTL 失效的断崖次数
  maxKeptGapMs: number | null; // 最长实测缓存保活间隔（毫秒）
  minExpiredGapMs: number | null; // 最短实测缓存失效间隔（毫秒）
  medianExpiredGapMs?: number | null; // 实测失效中位间隔（毫秒，抗 1% 偶发副本漂移抖动）
  lastEventKind: "kept" | "expired" | null; // 最近一次有效间隔事件类型（>=2m 保活或失效）
  lastEventGapMs: number | null; // 最近一次事件间隔时长（毫秒）
  lastEventAt: string; // 最近一次事件时间 ISO-8601
  buckets?: CacheTtlBucket[]; // 6 档空闲间隔衰减曲线（全局与项目级附带）
}

/** 会话详情（汇总 + 全量单步时间线） */
export interface ConversationDetail extends ConversationUsageSummary {
  steps: StepUsageRecord[]; // 按时间/步序排列的推理明细
  toolUsageCounts: Record<string, number>; // 工具调用频次统计
}

/** 单日/时间桶内按模型维度的消耗与等效费用拆解项 */
export interface DailyModelUsage {
  modelName: string; // 可读模型名称（如 Gemini 4 Argon (High)、Claude Opus 5.5 (High)）
  modelId: string; // 原始模型标识
  callCount: number; // 桶内该模型调用次数
  inputTokens: number; // 桶内该模型未缓存输入 Token
  cacheReadTokens: number; // 桶内该模型缓存读取 Token
  outputTokens: number; // 桶内该模型输出 Token
  totalTokens: number; // 桶内该模型总 Token
  estimatedCostUsd: number; // 桶内该模型等效成本（USD）
}

/** 时间序列趋势桶（按日或按小时聚合） */
export interface UsageTimeBucket {
  bucketKey: string; // 时间桶键（如 2026-11-06 或 2026-11-06 17:00）
  label: string; // 展示标签（如 11-06 或 17:00）
  callCount: number; // 调用次数
  inputTokens: number; // 未缓存输入 Token
  cacheReadTokens: number; // 缓存读取 Token
  outputTokens: number; // 输出 Token
  thinkingTokens: number; // 思考 Token
  totalTokens: number; // 总 Token
  estimatedCostUsd: number; // 等效成本（USD）
  models?: DailyModelUsage[]; // 桶内按模型拆解的 Token 与费用明细（按费用降序排列）
}

/** 单次大模型增量调用节点（用于折线图逐节点趋势可视化） */
export interface CallNodePoint {
  seq: number; // 当前过滤范围内按时间递增的全局调用序号（从 1 开始）
  conversationId: string; // 实际执行本步的会话或子代理 UUID
  conversationTitle: string; // 实际会话或子代理标题
  rootConversationId?: string; // 所属顶层主会话 UUID
  rootConversationTitle?: string; // 所属顶层主会话标题
  callIndex: number; // 会话内推理轮次（从 0 开始）
  timestamp: string; // ISO-8601 调用时间戳
  modelName: string; // 可读模型名称
  inputTokens: number; // 本次新增未缓存输入 Token
  cacheReadTokens: number; // 本次缓存读取 Token
  outputTokens: number; // 本次输出 Token
  totalTokens: number; // 本次调用节点总处理 Token
  cumulativeTokens: number; // 截至该节点的全局累计总 Token
  modelCumulativeTokens: number; // 截至该节点的同模型累计总 Token
  latencyMs: number; // 本次调用端到端耗时（毫秒，未落库尾步为 0）
  ttftMs: number; // 本次调用首包延迟 TTFT（毫秒）
  outputTps: number; // 本次调用节点当下的端到端输出 TPS（tok/s）
  estimatedCostUsd: number; // 本次调用等效成本（USD）
}

/** 按模型维度聚合项 */
export interface ModelUsageBreakdown {
  modelName: string; // 可读模型名
  modelId: string; // 代表性内部模型 ID
  conversationCount: number; // 涉及会话数
  callCount: number; // 调用次数
  inputTokens: number; // 未缓存输入 Token
  cacheReadTokens: number; // 缓存读取 Token
  outputTokens: number; // 总输出 Token
  thinkingTokens: number; // 思考 Token
  responseTokens: number; // 回复 Token
  totalTokens: number; // 总 Token
  cacheHitRate: number; // 缓存命中率（0 ~ 1）
  avgLatencyMs: number; // 平均单次推理耗时（毫秒）
  avgOutputTps: number; // 端到端平均输出速率（tok/s）
  avgStreamingTps: number; // 扣除首包等待后的流式吐字速率（tok/s）
  estimatedCostUsd: number; // 等效成本（USD）
  cacheSavedUsd: number; // 缓存节省成本（USD）
  shareOfTotalTokens: number; // 占全局总 Token 比例（0 ~ 1）
}

/** 按工作区/项目维度聚合项 */
export interface WorkspaceUsageBreakdown {
  workspaceName: string; // 项目短名称
  workspacePath: string; // 本地路径
  conversationCount: number; // 会话数
  subagentCount: number; // 子代理会话数
  callCount: number; // LLM 调用次数
  inputTokens: number; // 未缓存输入 Token
  cacheReadTokens: number; // 缓存读取 Token
  outputTokens: number; // 输出 Token
  totalTokens: number; // 总 Token
  cacheHitRate: number; // 缓存命中率（0 ~ 1）
  estimatedCostUsd: number; // 等效成本（USD）
  lastActiveAt: string; // 最近活跃时间
  shareOfTotalTokens: number; // 占全局总 Token 比例（0 ~ 1）
  cacheTtl?: CacheTtlSummary; // 该项目维度实测缓存 TTL 摘要与 6 档衰减曲线
}

/** 工具调用与 Token 关联分布项 */
export interface ToolUsageBreakdown {
  toolName: string; // 工具名（如 run_command、read_file）
  invocationCount: number; // 调用总次数
  associatedOutputTokens: number; // 触发该工具所在轮次的输出 Token
}

/** 全局 KPI 汇总指标 */
export interface GlobalKpiTotals {
  conversationCount: number; // 命中筛选条件的会话总数
  subagentCount: number; // 其中子代理会话数
  callCount: number; // LLM 推理总次数
  inputTokens: number; // 累计未缓存输入 Token
  cacheReadTokens: number; // 累计缓存读取 Token
  outputTokens: number; // 累计总输出 Token
  thinkingTokens: number; // 累计思考 Token
  responseTokens: number; // 累计回复 Token
  totalTokens: number; // 累计总处理 Token
  cacheHitRate: number; // 全局 Prompt 缓存命中率（0 ~ 1）
  avgLatencyMs: number; // 平均单步推理耗时（毫秒）
  avgTtftMs: number; // 平均首包延迟 TTFT（毫秒）
  avgOutputTps: number; // 端到端平均输出速率（tok/s）
  avgStreamingTps: number; // 扣除首包等待后的流式吐字速率（tok/s）
  estimatedCostUsd: number; // 累计等效 API 成本（USD）
  cacheSavedUsd: number; // 累计因缓存节省的等效成本（USD）
  todayTotalTokens: number; // 今日消耗总 Token
  todayEstimatedCostUsd: number; // 今日等效成本（USD）
}

/** 数据源健康与扫描诊断信息 */
export interface DataSourceHealth {
  dataDir: string; // 实际扫描的 AntiGravity 数据根目录
  exists: boolean; // 目录是否存在
  summaryDbAvailable: boolean; // conversation_summaries.db 是否可读
  conversationDbCount: number; // 发现的 conversations/*.db 数量
  transcriptCount: number; // 发现的 transcript.jsonl 数量
  sqliteReadMode: "wal-readonly" | "immutable-fallback" | "none"; // SQLite 读取模式
  scanDurationMs: number; // 本次扫描聚合耗时（毫秒）
  scannedAt: string; // 本次扫描完成时间（ISO-8601）
  warnings: string[]; // 非致命告警列表
}

/** 配额周期筛选模式（对齐官方 5 小时短周期与 7 天周上限双层机制，并支持任意历史周周期窗口） */
export type QuotaCycleMode =
  | "5h"
  | "prev-5h"
  | "7d"
  | "prev-7d"
  | "today"
  | "all"
  | `window:${number}:${number}`;

/** 可选的 7 天周周期账期条目 */
export interface QuotaCycleOption {
  key: QuotaCycleMode; // 周期筛选键（当前周为 "7d"，历史周为 "window:<startMs>:<endMs>"）
  startMs: number; // 周期起点毫秒时间戳
  endMs: number; // 周期终点毫秒时间戳
  totalTokens: number; // 该周期内消耗总 Token
  isCurrent: boolean; // 是否为当前活跃 7d 周周期
}

/** 基于本地调用时间线推算的双层配额周期状态与重置倒计时摘要 */
export interface QuotaCycleInfo {
  mode: QuotaCycleMode; // 当前生效的周期模式
  label: string; // 当前周期可读名称
  windowStart: string; // 当前周期起点 ISO-8601（all 模式为空串）
  windowEnd: string; // 当前周期终点/预计重置时刻 ISO-8601（all 模式为空串）
  resetsInMs: number; // 距离当前活跃周期重置剩余毫秒数（已重置或历史周期为 0）
  isIdleReset: boolean; // 当前周期是否已过重置时刻、处于满血待下次调用触发态
  active5hTokens: number; // 当前活跃 5h 周期累计消耗 Token
  active5hResetsAt: string; // 当前活跃 5h 周期预计重置时刻 ISO（待触发态为空串）
  active7dTokens: number; // 当前活跃 7d 周周期累计消耗 Token
  active7dResetsAt: string; // 当前活跃 7d 周周期预计重置时刻 ISO（待触发态为空串）
  available7dCycles?: QuotaCycleOption[]; // 全部可选的 7 天周周期列表（按时间倒序）
}

/** 本地数据源类型（原生 Antigravity / T3 Code 隔离账号实例 / 自定义目录） */
export type DataSourceKind = "native" | "t3" | "custom";

/** 单账号下单个配额池的 7d 周剩余摘要（供顶部多账号卡片直接展示） */
export interface SourcePoolQuotaBadge {
  remainingPct: number; // 周剩余百分比（0 ~ 100，精确到 0.1）
  source: "live" | "calibrated"; // live: agy 官方实时同步；calibrated: 基于手工校准推算
  resetTime?: string; // 可选预计重置时刻 ISO-8601
  updatedAt?: string; // 采样或校准时刻 ISO-8601
}

/** 单个本地数据源（账号实例）汇总信息 */
export interface DataSourceInfo {
  id: string; // 唯一数据源 ID（如 native、t3:antigravity）
  label: string; // 可读展示名称（如 原生 Antigravity 或 T3 settings.json displayName）
  kind: DataSourceKind; // 数据源类型
  dataDir: string; // 实际扫描目录绝对路径
  exists: boolean; // 目录是否存在
  conversationCount: number; // 当前筛选条件下命中会话数
  callCount: number; // 当前筛选条件下 LLM 调用数
  totalTokens: number; // 当前筛选条件下总 Token
  todayTotalTokens: number; // 今日消耗总 Token
  todayEstimatedCostUsd: number; // 今日等效 API 成本（USD）
  estimatedCostUsd: number; // 当前筛选条件下等效 API 成本（USD）
  cacheHitRate: number; // 当前筛选条件下缓存命中率（0 ~ 1）
  lastActiveAt: string; // 最近活跃时间 ISO-8601
  mergedKinds?: DataSourceKind[]; // 若按 Google 账号自动合并了多端目录（如 T3 + 原生），列出所含端类型
  weeklyQuota?: {
    gemini?: SourcePoolQuotaBadge; // Gemini 池当前 7d 周剩余摘要
    claude?: SourcePoolQuotaBadge; // Claude 池当前 7d 周剩余摘要
  };
}

/** 查询过滤参数 */
export interface TelemetryFilterOptions {
  source?: string; // 可选数据源 ID（"all" 表示合并全部本机数据源）
  cycle?: QuotaCycleMode; // 配额周期模式（5h / prev-5h / 7d / prev-7d / today / all）
  days?: number; // 最近 N 天（CLI 兼容参数，不传或 0 表示全部时间）
  workspace?: string; // 按项目名或路径过滤
  model?: string; // 按模型名或配额池过滤
  search?: string; // 按标题/提示词/会话 ID 模糊搜索
  includeArchived?: boolean; // 是否包含归档会话（默认 true）
  forceRefresh?: boolean; // 是否跳过文件缓存强制重扫
  nodeLimit?: number; // 可选调用时间线尾节点上限（0 表示跳过生成，默认 5000）
  nowMs?: number; // 可选基准当前毫秒时间戳（供单测确定性校验周期切分）
}

/** 由 agy 官方 statusLine 桥接写入的单配额池实时周剩余快照 */
export interface LivePoolQuotaSnapshot {
  remainingPct: number; // 官方周剩余百分比（0 ~ 100，精确到 0.1）
  resetTime: string; // 官方预计重置时刻 ISO-8601
  updatedAt: string; // 最近一次由 agy statusLine 推送写入时刻 ISO-8601
  windowStart?: string; // 该采样归属的当前 7d 池周期起点 ISO-8601
  poolCostUsdAtSample?: number; // 截至采样时刻该池全工作区累计等效成本（USD）
  poolTokensAtSample?: number; // 截至采样时刻该池全工作区累计总 Token
}

/** /api/summary 返回的完整看板载荷 */
export interface DashboardSummaryPayload {
  health: DataSourceHealth; // 数据源健康状态
  totals: GlobalKpiTotals; // 顶部核心指标
  quotaWindow?: QuotaCycleInfo; // 当前选中配额池的 5h/7d 周期窗口与预计重置信息
  callTimeline: CallNodePoint[]; // 按时间升序排列的模型调用增量节点序列
  dailyTrend: UsageTimeBucket[]; // 按天趋势桶
  hourlyTrend: UsageTimeBucket[]; // 最近按小时趋势桶
  byModel: ModelUsageBreakdown[]; // 模型拆解列表
  byWorkspace: WorkspaceUsageBreakdown[]; // 项目工作区拆解列表
  topTools: ToolUsageBreakdown[]; // 高频工具排行
  conversations: ConversationUsageSummary[]; // 会话列表（默认按最近活跃或总消耗排序）
  availableWorkspaces: string[]; // 全量可选工作区筛选项
  availableModels: string[]; // 全量可选模型筛选项
  defaultPricing: ModelPriceRate[]; // 服务端默认单价表
  cacheTtl?: CacheTtlSummary; // 当前筛选范围全局实测缓存 TTL 摘要与 6 档衰减曲线
  liveQuota?: Record<string, LivePoolQuotaSnapshot>; // 若本机装有 agy CLI 并接入 statusLine，返回各池实时官方周剩余
  activeSource?: string; // 当前选中的数据源 ID（多源模式下为 "all" 或单账号 ID）
  sources?: DataSourceInfo[]; // 本机发现的全部数据源及各自消耗拆解（仅多源或显式启用时返回）
}

/** 供 HTTP 服务与 CLI 注入的遥测提供者接口 */
export interface QuotaResetEvent {
  id: string; // 重置记录唯一 ID
  timestamp: string; // 重置发生时刻 ISO-8601
  pool: "all" | "gemini" | "claude"; // 影响的配额池
  note: string; // 可选备注说明
  source?: "shared" | "local"; // 记录来源：仓库公共强制重置 / 本机个人登记
}

/** 单配额池周满额反算校准快照（按 pool + windowStart 持久化至本机 ~/.hamiji-sta/calibrations.json） */
export interface WeeklyQuotaCalibration {
  remainingPct: number; // 校准时官方 Usage 面板显示的周剩余百分比（0 ~ 99.9）
  calibratedCostUsd: number; // 校准时刻本周期已消耗等效 API 成本（USD）
  calibratedTokens: number; // 校准时刻本周期已消耗总 Token
  calibratedAt: string; // 校准时间 ISO-8601
}

export interface TelemetryProvider {
  getSummary(options?: TelemetryFilterOptions): DashboardSummaryPayload;
  getConversationDetail(conversationId: string, source?: string): ConversationDetail | null;
  getHealth(source?: string): DataSourceHealth;
  getSources?(): DataSourceInfo[];
  getResets?(source?: string): QuotaResetEvent[];
  addReset?(
    input: { timestamp: string; pool: "all" | "gemini" | "claude"; note?: string },
    source?: string
  ): QuotaResetEvent[];
  deleteReset?(id: string, source?: string): QuotaResetEvent[];
  getCalibrations?(source?: string): Record<string, WeeklyQuotaCalibration>;
  getCalibrationsState?(source?: string):
    | { ok: true; calibrations: Record<string, WeeklyQuotaCalibration>; initialized: boolean }
    | { ok: false; error: string };
  isCalibrationsInitialized?(source?: string): boolean;
  setCalibration?(
    key: string,
    value: WeeklyQuotaCalibration,
    options?: { source?: "manual" | "auto" },
    sourceId?: string
  ): Record<string, WeeklyQuotaCalibration>;
  migrateCalibrationsBatch?(
    entries: Record<string, WeeklyQuotaCalibration>,
    sourceId?: string
  ): { conflict: boolean; calibrations: Record<string, WeeklyQuotaCalibration> };
  deleteCalibration?(key: string, deletedAt?: string, sourceId?: string): Record<string, WeeklyQuotaCalibration>;
}
