/**
 * Input: cva 变体工具、radix-ui Slot 与 @/lib/utils 类名合并函数。
 * Output: 导出 Button 组件与 buttonVariants 样式变体。
 * Pos: src/components/ui/button.tsx，全局交互按钮基础 UI 组件（由 shadcn CLI 生成）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-[var(--theme-accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--theme-accent-soft)] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-red-500 aria-invalid:ring-red-500/20 dark:aria-invalid:ring-red-500/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 dark:aria-invalid:border-red-900 dark:aria-invalid:ring-red-900/20",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--theme-accent)] text-[var(--theme-accent-contrast)] shadow-xs hover:bg-[var(--theme-accent-hover)]",
        destructive:
          "bg-red-500 text-white hover:bg-red-500/90 focus-visible:ring-red-500/20 dark:bg-red-900 dark:hover:bg-red-900/90 dark:focus-visible:ring-red-900/40",
        outline:
          "border text-slate-800 shadow-xs hover:text-slate-950 dark:text-slate-100 dark:hover:text-slate-50",
        secondary:
          "bg-[var(--theme-surface-muted)] text-slate-900 hover:opacity-90 dark:text-slate-50",
        ghost:
          "hover:bg-[var(--theme-surface-muted)] hover:text-slate-900 dark:hover:text-slate-50",
        link: "text-[var(--theme-accent-ink)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * 职责：渲染 shadcn/ui 无障碍基础组件 Button。
 * 参数：props — 组件属性与原生/Radix 透传属性（完整保留 aria-* 与键盘交互）。
 * 返回值：React 元素节点。
 */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
