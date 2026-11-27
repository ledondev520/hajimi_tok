/**
 * Input: radix-ui ScrollArea 滚动视口原语与 @/lib/utils。
 * Output: 导出 ScrollArea 与 ScrollBar 自定义滚动容器组件。
 * Pos: src/components/ui/scroll-area.tsx，长列表与弹窗时间线滚动基础 UI 组件（由 shadcn CLI 生成）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

/**
 * 职责：渲染 shadcn/ui 无障碍基础组件 ScrollArea。
 * 参数：props — 组件属性与原生/Radix 透传属性（完整保留 aria-* 与键盘交互）。
 * 返回值：React 元素节点。
 */
function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-slate-950/50 focus-visible:outline-1 dark:focus-visible:ring-slate-300/50"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

/**
 * 职责：渲染 shadcn/ui 无障碍基础组件 ScrollBar。
 * 参数：props — 组件属性与原生/Radix 透传属性（完整保留 aria-* 与键盘交互）。
 * 返回值：React 元素节点。
 */
function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-slate-200 dark:bg-slate-800"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
