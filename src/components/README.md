若本文件夹结构或内容变化，请更新本文件。

- `SourceSwitcherBar.tsx`｜多账号总览切换条与分账号费用/Token 明细（移动端友好）
- `KpiCards.tsx`｜顶部四卡与周剩余 `%` 满额反算（支持按账号隔离周校准与移动端紧凑排版）
- `DailyUsageCard.tsx`｜每日双轴 / 今日单次消耗折线
- `CacheHitRateCard.tsx`｜缓存命中率（今日 / 近7天 / TTL 衰减切换）
- `CacheTtlPanel.tsx`｜实测缓存 TTL 衰减曲线与各项目速览
- `ModelCallChart.tsx`｜单次节点折线（消耗 / 缓存率含冷启动去噪 / TPS）
- `ConversationExplorer.tsx`｜主会话折叠表、表头直点排序、首屏分页展开与缓存仍热筛选
- `ConversationDetailDialog.tsx`｜单会话缓存曲线、所属账号标记与逐轮倒序明细弹窗
- `ResetCalendarPage.tsx`｜`/calendar` 配额重置月历与在线登记页（支持按账号切换）
- `ui/`｜`shadcn/ui` 基础无障碍组件
