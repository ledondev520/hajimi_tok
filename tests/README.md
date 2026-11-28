若本文件夹结构或内容变化，请更新本文件。

- `engine.test.ts`｜Protobuf 解码、双源扫描、周期切分、TTL 反推、公共重置合并与校准单测
- `server.test.ts`｜HTTP `/api/*` 路由、来源安全边界、CSV 公式防护、符号链接防护与 CLI 渲染单测
- `multiSource.test.ts`｜T3 Code 多账号自动发现、多源合并/隔离聚合、HTTP `?source=` 路由与 CLI `--source` 渲染单测
- `regressions.test.ts`｜零写入 WAL 快照、双源步号冲突、失败重试、跨池一致性、损坏保护、自更新与桥接回归测试
- `compactReminder.test.ts`｜可选 400K 上下文压缩软提醒 Hook 触发、去重、UTF-8 分块边界与无侵入安装/卸载单测
