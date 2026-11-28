# 哈吉米统计

纯本地只读的 AntiGravity Token 消耗看板与 CLI，零代理、零数据上传；自动兼容原生 `~/.gemini/antigravity` 与 **T3 Code** 多账号隔离目录。

## 快速开始（Node.js >= 22.12.0）

```bash
git clone <repo-url>
cd hajimi_tok && npm install
npm run build && npm run service:install   # 构建并注册 macOS 常驻服务（http://127.0.0.1:4318）
```

常用命令：

```bash
npm run update           # 手动更新（常驻服务已内置每 10 分钟静默自动更新）
npm run service:status   # 查看服务状态（另有 service:restart / service:stop）
npm run stats            # 终端汇总（支持 --source <id> / --days 7 / --workspace <name> / --json）
npm run dev              # 开发热更新（:5173）
npm run hook:compact:install   # 手动安装/重装 400K 上下文 /compact 软提醒全局 Hook（service:install 已默认无侵入自动安装；hook:compact:uninstall 卸载）
```

## 功能

- **多账号与 T3 Code 自动兼容**：未设置 `AGY_DATA_DIR` 时，自动扫描本机 `~/.t3/userdata/providers/antigravity/*/antigravity-acp`（通过 `settings.json` 自动回填 T3 账号显示名）与原生 `~/.gemini/antigravity`；单个页面同时汇总所有本机账号费用，点击卡片即可一键切换单账号视角，各账号周校准与重置记录相互独立。也可通过 `AGY_DATA_DIR=dir1:dir2` 手动指定多目录。
- **移动端与 T3 Code 预览**：服务严格绑定 `127.0.0.1:4318`（仅读本机数据、不对外网暴露端口）；在 T3 Code 桌面端或手机端可通过内置 Preview 面板直接打开本地 `4318` 端口查看。
- **分池与周期**：`全部 / Claude 池 / Gemini 池`（快捷键 `1/2/3`），自动对齐 5h / 7d 窗口与重置倒计时。
- **周满额与重置日历**：输入官方剩余 `%` 反算周满额（装有 `agy` CLI 时自动通过官方 `statusLine` 回填）；`/calendar` 查看公共强制重置与个人重置日历。
- **趋势与缓存 TTL**：每日/今日消耗、缓存命中率（自动区分新会话首轮与真失效）、实测 TTL 衰减曲线与单次 TPS。
- **主会话明细**：Subagent 自动合并折叠、表头直点排序、`/` 搜索、「缓存仍热」一键筛选、逐轮倒序明细弹窗。
- **400K 上下文压缩软提醒**：`npm run service:install` 会自动无侵入注册至 `~/.gemini/config/hooks.json`（保留已有 Hook、跳过同名自定义配置，设 `AGY_SKIP_COMPACT_HOOK=1` 可跳过，或随时 `npm run hook:compact:uninstall` 卸载）；每个压缩周期上下文首次达到 400K（约 512K 的 78%）时向模型注入一次性系统软提醒并在回复末尾拟好 `/compact` 指令（零熔断，省略 `metadata` 以兼容 Antigravity 宿主）。
