/**
 * sandbox/index.ts — 沙箱模块公开导出
 */
export {
  getOrCreateSandbox,
  destroySandbox,
  sandboxBrowse,
  sandboxExec,
  sandboxReadFile,
  sandboxWriteFile,
  sandboxListFiles,
  getActiveSessions,
  getMetrics,
  shutdownAll,
  sandboxEvents,
  initWarmPool,
} from "./sandbox-manager.js";

export type {
  SandboxSession,
  WarmContainer,
  SandboxMetrics,
  BrowseRequest,
  BrowseResponse,
  ExecRequest,
  ExecResponse,
  SandboxEvent,
  SandboxConfig,
} from "./sandbox.types.js";

export { sandboxConfig } from "./sandbox.config.js";
