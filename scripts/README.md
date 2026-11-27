若本文件夹结构或内容变化，请更新本文件。

- `dev.mjs`｜开发期并行拉起后端 API 与 Vite 热更新
- `service.mjs`｜macOS `launchd` 常驻服务管理（`install / restart / stop / status`）
- `update.mjs`｜安全自更新（跨进程锁、固定提交 `merge --ff-only`、断点续建与按需 `install / build / restart`）
- `statusline-bridge.mjs`｜可选 `agy` CLI 官方 `statusLine` 跨进程锁配额桥接脚本
- `check-rules.mjs`｜工程规范门禁（零 CSS、文件 `<=800` 行、头注释与目录文档检查）
