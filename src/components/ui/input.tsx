/**
 * Input: React 原生 input 属性类型与 @/lib/utils 类名合并函数。
 * Output: 导出 Input 文本输入框组件。
 * Pos: src/components/ui/input.tsx，搜索框与数值编辑基础 UI 组件（由 shadcn CLI 生成）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * 职责：渲染 shadcn/ui 无障碍基础组件 Input。
 * 参数：props — 组件属性与原生/Radix 透传属性（完整保留 aria-* 与键盘交互）。
 * 返回值：React 元素节点。
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border bg-[var(--theme-surface-solid)] px-3 py-1 text-base shadow-xs transition-[color,box-shadow,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-slate-950 placeholder:text-slate-400 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:file:text-slate-50 dark:placeholder:text-slate-500",
        "aria-invalid:border-red-500 aria-invalid:ring-red-500/20 dark:aria-invalid:border-red-900 dark:aria-invalid:ring-red-900/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
