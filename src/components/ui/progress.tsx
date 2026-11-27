/**
 * Input: radix-ui Progress 无障碍进度条原语与 @/lib/utils。
 * Output: 导出 Progress 进度条组件。
 * Pos: src/components/ui/progress.tsx，缓存命中率与上下文水位可视化基础 UI 组件（由 shadcn CLI 生成）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

/**
 * 职责：渲染 shadcn/ui 无障碍基础组件 Progress。
 * 参数：props — 组件属性与原生/Radix 透传属性（完整保留 aria-* 与键盘交互）。
 * 返回值：React 元素节点。
 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-slate-900/20 dark:bg-slate-50/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-slate-900 transition-all dark:bg-slate-50"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
