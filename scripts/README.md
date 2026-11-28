若本文件夹结构或内容变化，请更新本文件。

- `dev.mjs`｜开发期并行拉起后端 API 与 Vite 热更新
- `service.mjs`｜macOS `launchd` 常驻服务管理（`install / restart / stop / status`，plist 内置完整 `PATH/HOME`、旧版迁移回退，并自动无侵入接入 `statusLine` 与 400K 压缩提醒 Hook）
- `update-runtime.mjs`｜自更新底层运行时原语（环境补全、凭证脱敏、跟踪工作区/漂移检测、`ls-remote` 探测、`dist` 备份恢复、plist 归属与 PID+探活核验、日志裁剪与通知）
- `update.mjs`｜安全自更新（跨进程唯一归属锁、固定提交 `merge --ff-only`、断点续建、漂移自愈、按需 `install / build / restart` 与健康校验）
- `statusline-bridge.mjs`｜可选 `agy` CLI 官方 `statusLine` 跨进程锁配额桥接脚本（附带登录邮箱归属防串号，支持 `--output` 与 `--login` 多账号隔离登录同步）
- `compact-reminder-hook.mjs`｜Antigravity 全局 400K 上下文压缩软提醒 `PreInvocation` + `Stop` 兜底 Hook 及安装/卸载脚本（输出纯 `systemMessage` 正文卡片规避宿主 `metadata` panic，`Stop` 单次防循环兜底，`service:install` 与自更新自动无侵入同步）
- `check-rules.mjs`｜工程规范门禁（零 CSS、文件 `<=800` 行、头注释与目录文档检查）
