/**
 * Input: radix-ui Switch 无障碍开关原语与 @/lib/utils。
 * Output: 导出 Switch 双态切换开关组件。
 * Pos: src/components/ui/switch.tsx，实时自动刷新与归档显示切换基础 UI 组件（由 shadcn CLI 生成）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

/**
 * 职责：渲染 shadcn/ui 无障碍基础组件 Switch。
 * 参数：props — 组件属性与原生/Radix 透传属性（完整保留 aria-* 与键盘交互）。
 * 返回值：React 元素节点。
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-indigo-500/40 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-indigo-600 data-[state=unchecked]:bg-slate-300 dark:data-[state=checked]:bg-indigo-500 dark:data-[state=unchecked]:bg-slate-700",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-xs ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-[2px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
