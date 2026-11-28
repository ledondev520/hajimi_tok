若本文件夹结构或内容变化，请更新本文件。

- `protobuf.ts`｜`gen_metadata` Protobuf 零依赖解码
- `pricing.ts`｜模型单价预设与成本计算
- `workspaceNormalize.ts`｜git/T3/Swarm 工作树项目归并、未绑定与临时目录合为「临时对话」及无调用空壳会话过滤
- `scanner.ts`｜SQLite + `transcript.jsonl` 只读增量扫描（含 `conversation_summaries.db` 与 `-wal` 指纹复用、委托工作区归并与空壳过滤）
- `sources.ts`｜本机原生 Antigravity（含 `antigravity-cli`）与 T3 Code 多账号自动发现、同 Google 账号无侵入归并与 `live-quota.json` 精准绑定
- `quotaCycle.ts`｜按配额池切分 5h / 7d 周期与倒计时
- `resetStore.ts`｜合并仓库 `shared-resets.json` 与本机重置/校准/实时配额读写（支持只读公共视图）
- `aggregator.ts`｜KPI、模型、项目、TTL（`WeakMap` 缓存）与按需裁剪调用时间线聚合
- `multiSource.ts`｜多账号共享扫描缓存、跨源 `conversationId` 去重、同账号多目录合并、单账号周剩余配额直出与分账号状态隔离编排
- `app.ts`｜HTTP API（`/api/*`、`GET /api/sources`、`?source=`、`nodeLimit`、`ETag 304` 与大载荷 gzip）、导出与静态资源托管
- `index.ts`｜本地常驻服务入口、多账号编排、10 分钟静默自动更新与多账号 `agy` 官方周剩配额定时刷新
- `cliRender.ts`｜终端报表参数解析（含 `--source`）与多账号表格渲染
- `cli.ts`｜`npm run stats` 命令行入口
