/**
 * Input: clsx 条件类名拼接工具与 tailwind-merge Tailwind 冲突类名合并工具。
 * Output: 导出 cn() 辅助函数供全量 shadcn/ui 基础组件与业务组件调用。
 * Pos: 前端样式类名合并基础设施模块。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 职责：合并条件 Tailwind CSS 类名并自动消解冲突原子类。
 * 参数：inputs — 任意数量的 ClassValue（字符串、对象、数组或布尔表达式）。
 * 返回值：去重合并后的标准 className 字符串。
 */
export function cn(...inputs: ClassValue[]): string {
  // 0. 先由 clsx 展平条件类名，再交由 twMerge 消除同属性原子类冲突
  return twMerge(clsx(inputs));
}
