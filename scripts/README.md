若本文件夹结构或内容变化，请更新本文件。

- `dev.mjs`｜开发期并行拉起后端 API（`:4318`）与 Vite 热更新（`:5173`）
- `service.mjs`｜macOS `launchd` 常驻服务管理（`install / restart / stop / status`，含 PATH/HOME 注入、旧 plist 迁移与无侵入注册 `statusLine` / 400K 压缩 Hook）
- `update.mjs`｜轻量手动更新（`npm run update`：干净工作区校验、`git pull --ff-only`、按需 `npm ci` + `build` + 重启常驻）
- `statusline-bridge.mjs`｜可选 `agy` CLI 官方 `statusLine` 配额桥接（支持 `--install` 与 `--login` 多账号隔离周剩同步）
- `compact-reminder-hook.mjs`｜Antigravity 全局 400K 上下文 `/compact` 软提醒 Hook（`PreInvocation` + `Stop` 单次兜底）
- `check-rules.mjs`｜工程规范门禁（零 CSS、文件 `<=800` 行、头注释与目录文档检查）
