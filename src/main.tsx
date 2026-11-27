/**
 * Input: React StrictMode、react-dom/client、virtual:tailwind.css 虚拟样式入口、TooltipProvider 与 App 根组件。
 * Output: 将 AntiGravity Token Radar 前端视图树挂载至 DOM #root 节点。
 * Pos: 前端浏览器端唯一运行时启动入口（src/main.tsx）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "virtual:tailwind.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "@/App";

/**
 * 职责：定位页面根节点并挂载包裹了无障碍 TooltipProvider 的 React 应用。
 * 参数：无。
 * 返回值：无。
 */
function bootstrapApplication(): void {
  // 0. 查找挂载容器并启动 React 19 严格模式渲染树
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("未找到 #root 挂载节点");
  }
  createRoot(container).render(
    <StrictMode>
      <TooltipProvider delayDuration={120}>
        <App />
      </TooltipProvider>
    </StrictMode>
  );
}

bootstrapApplication();
