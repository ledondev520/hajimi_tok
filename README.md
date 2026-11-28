# 哈吉米统计

纯本地只读的 AntiGravity Token 消耗看板与 CLI，零代理、零上传；自动兼容原生 `~/.gemini/antigravity` 与 **T3 Code** 多账号。

## 快速开始（Node.js >= 22.12.0）

```bash
git clone <repo-url>
cd hajimi_tok && npm install
npm run build && npm run service:install   # 注册 macOS 常驻服务（http://127.0.0.1:4318）
```

常用命令：

```bash
npm run dev              # 本地开发热更新（前端 :5173 + 后端 :4318）
npm run update           # 手动拉取更新、构建并重启常驻服务
npm run service:status   # 常驻状态（另有 service:restart / service:stop）
npm run stats            # 终端汇总（支持 --source / --days / --workspace / --json）
npm run statusline:login -- "账号名"   # 为额外 T3 账号开启官方 agy 周剩自动同步
```

## 核心能力

- **多账号自动归并**：自动发现本机 T3 Code 多实例与原生目录，同 Google 账号无侵入合并，顶部卡片直览费用与 Gemini/Claude 周剩 `%`。
- **分池与周期**：`全部 / Claude 池 / Gemini 池`（快捷键 `1/2/3`），自动对齐 5h / 7d 窗口、公共/个人重置日历（`/calendar`）与周满额反算。
- **趋势与缓存诊断**：每日/今日消耗、缓存命中率（区分冷启动与真失效）、TTL 衰减与端到端 TPS；主会话自动折叠同 T3 线程运行与 Subagent。
- **400K 压缩软提醒**：`service:install` 自动无侵入注册 `~/.gemini/config/hooks.json`（可用 `npm run hook:compact:uninstall` 卸载）。
