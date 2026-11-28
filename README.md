# 哈吉米统计

纯本地只读的 AntiGravity Token 消耗看板与 CLI，零代理、零数据上传。

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
npm run stats            # 终端汇总（支持 --days 7 / --workspace <name> / --json）
npm run dev              # 开发热更新（:5173）
npm run hook:compact:install   # 可选：注册 400K 上下文 /compact 软提醒全局 Hook（hook:compact:uninstall 卸载）
```

## 功能

- **分池与周期**：`全部 / Claude 池 / Gemini 池`（快捷键 `1/2/3`），自动对齐 5h / 7d 窗口与重置倒计时。
- **周满额与重置日历**：输入官方剩余 `%` 反算周满额（装有 `agy` CLI 时自动通过官方 `statusLine` 回填）；`/calendar` 查看公共强制重置与个人重置日历。
- **趋势与缓存 TTL**：每日/今日消耗、缓存命中率（自动区分新会话首轮与真失效）、实测 TTL 衰减曲线与单次 TPS。
- **主会话明细**：Subagent 自动合并折叠、表头直点排序、`/` 搜索、「缓存仍热」一键筛选、逐轮倒序明细弹窗。
- **可选 400K 压缩软提醒**：手动开启 `hook:compact:install` 后，每个压缩周期上下文首次达到 400K 时在对话中内联弹醒目大字提示并在末尾拟好 `/compact` 指令（零熔断，默认零侵入不自动写入）。
