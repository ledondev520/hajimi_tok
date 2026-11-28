/**
 * Input: React 基础属性类型与 @/lib/utils 类名合并函数。
 * Output: 导出 Card、CardHeader、CardTitle、CardContent 组件。
 * Pos: src/components/ui/card.tsx，结构化信息卡片容器基础 UI 组件。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import * as React from "react"
import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "theme-card flex flex-col gap-5 rounded-[var(--theme-radius-card)] border py-5 text-[var(--theme-text)]",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-5 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-5",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold tracking-tight text-[var(--theme-text)]", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardContent }
