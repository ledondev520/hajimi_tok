/**
 * Input: Vite 客户端环境类型声明。
 * Output: 声明 virtual:tailwind.css 虚拟模块以通过 TypeScript 严格校验。
 * Pos: src 目录全局模块类型补充文件。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
/// <reference types="vite/client" />

declare module "virtual:tailwind.css" {}
