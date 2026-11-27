/**
 * Input: cva 变体工具、radix-ui Slot 与 @/lib/utils 类名合并函数。
 * Output: 导出 Badge 组件与 badgeVariants 样式变体。
 * Pos: src/components/ui/badge.tsx，状态标签与分类徽章基础 UI 组件（由 shadcn CLI 生成）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-slate-950 focus-visible:ring-[3px] focus-visible:ring-slate-950/50 [&>svg]:pointer-events-none [&>svg]:size-3 dark:focus-visible:border-slate-300 dark:focus-visible:ring-slate-300/50",
  {
    variants: {
      variant: {
        default: "bg-slate-900 text-slate-50 [a&]:hover:bg-slate-900/90 dark:bg-slate-50 dark:text-slate-900 dark:[a&]:hover:bg-slate-50/90",
        secondary:
          "bg-slate-100 text-slate-900 [a&]:hover:bg-slate-100/90 dark:bg-slate-800 dark:text-slate-50 dark:[a&]:hover:bg-slate-800/90",
        destructive:
          "bg-red-500 text-white focus-visible:ring-red-500/20 dark:bg-red-500/60 dark:focus-visible:ring-red-500/40 [a&]:hover:bg-red-500/90 dark:bg-red-900 dark:focus-visible:ring-red-900/20 dark:dark:bg-red-900/60 dark:dark:focus-visible:ring-red-900/40 dark:[a&]:hover:bg-red-900/90",
        outline:
          "border-slate-200 text-slate-950 [a&]:hover:bg-slate-100 [a&]:hover:text-slate-900 dark:border-slate-800 dark:text-slate-50 dark:[a&]:hover:bg-slate-800 dark:[a&]:hover:text-slate-50",
        ghost: "[a&]:hover:bg-slate-100 [a&]:hover:text-slate-900 dark:[a&]:hover:bg-slate-800 dark:[a&]:hover:text-slate-50",
        link: "text-slate-900 underline-offset-4 [a&]:hover:underline dark:text-slate-50",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * 职责：渲染 shadcn/ui 无障碍基础组件 Badge。
 * 参数：props — 组件属性与原生/Radix 透传属性（完整保留 aria-* 与键盘交互）。
 * 返回值：React 元素节点。
 */
function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
