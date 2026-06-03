/**
 * tools/index.ts — 导出所有工具集合
 *
 * allTools   : 所有工具，适合通用 Agent。
 * webTools   : 仅网络相关工具。
 * comicsTools: 仅 ai-comics 平台工具。
 */
export { fetchWebpage } from "./web.js";
export { browseWeb } from "./browser.js";
export { generateImage } from "./image.js";
export { saveCode, explainCode } from "./code.js";
export { executeCode } from "./sandbox-exec.js";
export { uploadBase64ImageToLocal } from "./local-storage.js";
export {
  listProjects,
  getProjectDetail,
  listFragments,
  createFragment,
  triggerFragmentImage,
  listMaterials,
} from "./comics.js";

import { fetchWebpage } from "./web.js";
import { browseWeb } from "./browser.js";
import { generateImage } from "./image.js";
import { saveCode, explainCode } from "./code.js";
import { executeCode } from "./sandbox-exec.js";
import {
  listProjects,
  getProjectDetail,
  listFragments,
  createFragment,
  triggerFragmentImage,
  listMaterials,
} from "./comics.js";

/** 全量工具集，供通用 Agent 使用 */
export const allTools = {
  // 网络工具（轻量抓取）
  fetchWebpage,
  // 浏览器工具（沙箱 Playwright）
  browseWeb,
  // 图像工具
  generateImage,
  // 代码工具
  saveCode,
  explainCode,
  // 代码执行工具（沙箱）
  executeCode,
  // ai-comics 平台工具
  listProjects,
  getProjectDetail,
  listFragments,
  createFragment,
  triggerFragmentImage,
  listMaterials,
};

/** 仅网络工具（低权限场景） */
export const webTools = { fetchWebpage };

/** 仅代码工具 */
export const codeTools = { saveCode, explainCode };

/** 仅 ai-comics 平台工具 */
export const comicsTools = {
  listProjects,
  getProjectDetail,
  listFragments,
  createFragment,
  triggerFragmentImage,
  listMaterials,
};
