若本文件夹结构或内容变化，请更新本文件。

- `protobuf.ts`｜`gen_metadata` Protobuf 零依赖解码
- `pricing.ts`｜模型单价预设与成本计算
- `scanner.ts`｜SQLite + `transcript.jsonl` 只读增量扫描
- `sources.ts`｜本机原生 Antigravity 与 T3 Code 多账号数据目录自动发现
- `quotaCycle.ts`｜按配额池切分 5h / 7d 周期与倒计时
- `resetStore.ts`｜合并仓库 `shared-resets.json` 与本机重置/校准/实时配额读写
- `aggregator.ts`｜KPI、模型、项目、TTL 与调用时间线聚合
- `multiSource.ts`｜多账号共享扫描缓存、合并总览与分账号状态隔离编排
- `app.ts`｜HTTP API（`/api/*`、`GET /api/sources`、`?source=` 转发）、导出与静态资源托管
- `index.ts`｜本地常驻服务入口与 10 分钟静默自动更新
- `cliRender.ts`｜终端报表参数解析（含 `--source`）与多账号表格渲染
- `cli.ts`｜`npm run stats` 命令行入口
