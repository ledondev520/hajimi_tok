若本文件夹结构或内容变化，请更新本文件。

- `utils.ts`｜`cn()` Tailwind 类名合并
- `models.ts`｜前后端共用的模型池判定（Claude / Gemini / 其他）、模型过滤匹配、紧凑短名与固定视觉配色解析
- `format.ts`｜数值/时间格式化、今日摘要提取、周满额反算与重置日历生成
- `useWeeklyCalibration.ts`｜周配额剩余 `%` 同步、官方 `statusLine` 回填与防抖写回 Hook
- `cacheTtl.ts`｜前后端共享的实测缓存 TTL 衰减、压缩剔除与热冷态推算
- `conversationGroups.ts`｜主会话表格分组聚合（递归折叠子代理与同一 T3 线程的多次运行）
- `chartPath.ts`｜基于 Fritsch-Carlson 单调三次贝塞尔插值的平滑 SVG 曲线与面积路径生成器
- `modelStyle.ts`｜全局共享的模型紧凑短名解析、联动 `--theme-chart-1..8` 主题色盘的系列配色与同图防撞色去重器
- `useWeeklyCalibration.ts`｜周配额官方剩余 `%` 与服务端 `~/.hamiji-sta/calibrations.json` 权威同步及满额反算钩子
- `theme.ts`｜6 套全维度视觉主题预设（极简黑白 / 东京夜幕 / 暖陶纸感 / 星云紫境 / 北欧霜蓝 / 黑客矩阵）、明暗模式持久化与旧预设迁移钩子
- `themeCss.ts`｜零物理 CSS 约束下的虚拟 Tailwind v4 样式与画布纹理/卡片材质/动态圆角/8 色数据图表色盘令牌生成器
