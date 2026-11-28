若本文件夹结构或内容变化，请更新本文件。

- `protobuf.ts`｜`gen_metadata` Protobuf 零依赖解码
- `pricing.ts`｜Google / Anthropic 官方标准 API 模型单价预设与成本计算
- `workspaceNormalize.ts`｜git/T3/Swarm 工作树项目归并、未绑定与临时目录合为「临时对话」及无调用空壳会话过滤
- `t3Threads.ts`｜`~/.t3/userdata/statev2.sqlite` 零拷贝优先只读索引（共享实例 + 短窗复用），关联同 T3 线程多次 `fresh_session` 运行并还原正式标题
- `scanCache.ts`｜扫描结果持久化磁盘索引（`~/.hamiji-sta/scan-cache/*.json.gz`，自动跟踪源码与费率指纹免手工维护，原子落盘与异步防抖）
- `scanner.ts`｜SQLite 零拷贝优先直读 + 落盘扫描索引 + `transcript.jsonl` 非推理大行快扫 + $O(N)$ 步骤配对（含 `conversation_summaries.db` 指纹复用、工作区归并、T3 线程关联与空壳过滤）
- `sources.ts`｜本机原生 Antigravity（含 `antigravity-cli`）与 T3 Code 多账号自动发现（16KB 头部快读 + 多数票提前终止）、同 Google 账号无侵入归并与 `live-quota.json` 精准绑定
- `quotaCycle.ts`｜按配额池切分 5h / 7d 周期与倒计时（含 `WeakMap` 预解析时间戳与分池升序时间线索引）
- `resetStore.ts`｜合并仓库 `shared-resets.json` 与本机重置/校准/实时配额读写（支持只读公共视图）
- `aggregator.ts`｜KPI、模型、项目、TTL（`WeakMap` 缓存）与严格 `nodeLimit` 调用时间线聚合
- `multiSource.ts`｜多账号共享扫描与 T3 索引、跨源 `conversationId` 去重、同账号多目录合并、多源组合响应缓存、单账号周剩余配额直出与分账号状态隔离编排
- `app.ts`｜HTTP API（`/api/*`、`GET /api/sources`、`?source=`、`nodeLimit`、`summary`/`conversations/:id` `WeakMap` 序列化+ETag 304+gzip 缓存）与不可变静态资源内存缓存托管
- `index.ts`｜本地常驻服务入口（`:4318`）、多账号编排、400K 压缩提醒自动补装与多账号 `agy` 官方周剩配额定时刷新
