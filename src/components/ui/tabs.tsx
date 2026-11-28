/**
 * Input: radix-ui Tabs 无障碍选项卡原语、cva 与 @/lib/utils。
 * Output: 导出 Tabs、TabsList、TabsTrigger 组件。
 * Pos: src/components/ui/tabs.tsx，多维统计视图切换选项卡基础 UI 组件。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-slate-500 group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none dark:text-slate-400",
  {
    variants: {
      variant: {
        default: "",
        line: "gap-1 border-transparent bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-xs font-medium whitespace-nowrap text-slate-600 transition-all hover:text-slate-950 focus-visible:ring-[3px] focus-visible:ring-[var(--theme-accent-soft)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 dark:text-slate-400 dark:hover:text-slate-100",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger }
