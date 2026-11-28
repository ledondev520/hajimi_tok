若本文件夹结构或内容变化，请更新本文件。

- `SourceSwitcherBar.tsx`｜紧凑单行分段式多账号切换指令条、悬浮明细与 7d 周剩余配额徽标
- `KpiCards.tsx`｜一体化建筑级四列核心指标条（含真实内联 Sparkline、3px 占比条与周剩余 `%` 满额反算）
- `SvgChartPrimitives.tsx`｜SVG 折线图共享底座（容器宽度监听、图例显隐持久化、网格坐标轴、渐变定义、准星与防溢出浮窗）
- `DailyUsageCard.tsx`｜按日分模型堆叠圆角柱状图（支持 Token / 费用切换）与今日单次消耗折线
- `CacheHitRateCard.tsx`｜缓存命中率（今日 / 按日 / TTL 衰减切换，含无冲突模型配色与扁平图例）
- `CacheTtlPanel.tsx`｜实测缓存 TTL 衰减曲线与各项目速览
- `ModelCallChart.tsx`｜单次节点折线（消耗 / 缓存率含冷启动去噪 / TPS，含稀疏分段防跨图拉直与模型色彩去重器）
- `ModelBreakdownCard.tsx`｜模型消耗分布与占比排行榜卡片（与 TPS 曲线组成 8:4 非对称 Bento 行）
- `ConversationExplorer.tsx`｜主会话折叠表、表头直点排序、首屏分页展开与缓存仍热筛选
- `ConversationDetailDialog.tsx`｜单会话缓存曲线、所属账号标记与逐轮倒序明细弹窗
- `ResetCalendarPage.tsx`｜`/calendar` 配额重置月历与在线登记页（支持按账号切换）
- `ThemeSwitcher.tsx`｜顶栏主题配色面板弹窗（6 套主题色卡实时预览 + 浅色/深色/跟随系统）与一键明暗切换控件
- `ui/`｜`shadcn/ui` 基础无障碍组件
