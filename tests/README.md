若本文件夹结构或内容变化，请更新本文件。

- `engine.test.ts`｜Protobuf 解码、双源扫描、周期切分、TTL 反推、公共重置合并与校准单测
- `server.test.ts`｜HTTP `/api/*` 路由、来源安全边界、符号链接防护与 CLI 渲染单测
- `multiSource.test.ts`｜T3 Code 多账号自动发现、多源合并/隔离聚合、公共重置继承、`nodeLimit` 与 `ETag 304` 及 CLI `--source` 渲染单测
- `regressions.test.ts`｜零写入 WAL 快照、双源步号冲突、失败重试、跨池一致性、损坏保护与 `statusLine` 桥接回归测试
- `compactReminder.test.ts`｜可选 400K 上下文压缩软提醒 Hook 触发、去重、防 `metadata` panic 回归、`Stop` 单次兜底补卡与防死循环、UTF-8 分块边界与无侵入安装/卸载单测
- `update.test.ts`｜轻量手动更新（`update.mjs`）与常驻服务管理（`service.mjs` PATH/HOME 注入、旧 plist 迁移、回滚与防误删）隔离沙箱测试
- `workspaceNormalize.test.ts`｜git/T3/Swarm 工作树项目归并、未绑定与临时目录合为「临时对话」、空壳会话过滤、跨源去重与落盘缓存单测
