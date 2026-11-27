/**
 * Input: Vite 构建配置 API、@vitejs/plugin-react、@tailwindcss/vite 与 node:path。
 * Output: 默认导出 Vite 配置（含虚拟 Tailwind 样式入口、@/ 路径别名及 /api 代理）。
 * Pos: 前端编译与开发服务器核心配置文件，保障全仓零物理 .css/.scss 文件约束。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const VIRTUAL_TAILWIND_ID = "virtual:tailwind.css"; // 前端入口引用的虚拟样式标识
const RESOLVED_VIRTUAL_TAILWIND_ID = "\0virtual:tailwind.css"; // Rollup/Vite 内部解析标识（保留 .css 后缀供 Tailwind 插件编译）

/**
 * 职责：提供内存态虚拟 Tailwind CSS 入口，避免在仓库内创建任何物理 .css/.scss 文件。
 * 思路：1) 拦截 virtual:tailwind.css 解析请求；2) 返回 @import "tailwindcss" 供 @tailwindcss/vite 编译 Utility 类。
 * 参数：无。
 * 返回值：Vite Plugin 实例。
 */
function virtualTailwindPlugin(): Plugin {
  // 0. 构造并返回虚拟模块插件对象
  return {
    name: "virtual-tailwind-entry",
    resolveId(id: string) {
      // 1.1. 命中虚拟样式模块时返回带 \0 前缀的内部 ID
      if (id === VIRTUAL_TAILWIND_ID) {
        return RESOLVED_VIRTUAL_TAILWIND_ID;
      }
      return null;
    },
    load(id: string) {
      // 1.2. 返回 Tailwind v4 标准导入指令与暗色变体声明
      if (id === RESOLVED_VIRTUAL_TAILWIND_ID) {
        return '@import "tailwindcss";\n@custom-variant dark (&:where(.dark, .dark *));\n';
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [virtualTailwindPlugin(), tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4318",
        changeOrigin: true,
      },
    },
  },
});
