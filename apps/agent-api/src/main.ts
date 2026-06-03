/**
 * main.ts — Nest CLI 兼容入口
 *
 * Nest 的 `nest start --watch` 默认使用 `main.ts` 作为入口文件。
 * 当前项目实际启动逻辑在 `index.ts`，这里仅做转发以兼容 Nest CLI。
 */
import "./index.js";
