/**
 * types.ts — 沙箱服务的请求/响应/事件类型定义
 *
 * Agent API 与沙箱容器之间的通信协议。
 */

// ── 浏览器操作 ──────────────────────────────────────────────

/** 浏览器操作类型 */
export type BrowseAction =
  | "goto"
  | "click"
  | "type"
  | "scroll"
  | "screenshot"
  | "wait"
  | "content"
  | "inspect";

/** POST /browse 请求体 */
export interface BrowseRequest {
  action: BrowseAction;
  /** goto: 目标 URL */
  url?: string;
  /** click / type / wait: CSS 选择器 */
  selector?: string;
  /** type: 输入文本 */
  text?: string;
  /** scroll: 方向 */
  direction?: "up" | "down";
  /** scroll: 滚动像素，默认 500 */
  distance?: number;
  /** wait / goto: 超时毫秒数 */
  timeout?: number;
}

/** POST /browse 响应体 */
export interface BrowseResponse {
  success: boolean;
  data?: {
    /** 当前页面标题 */
    title?: string;
    /** 当前 URL */
    url?: string;
    /** 截图 base64 JPEG */
    screenshot?: string;
    /** 页面文本内容 */
    content?: string;
    /** inspect 返回的可交互元素列表 */
    elements?: Array<{
      tag: string;
      id?: string;
      class?: string;
      text?: string;
      type?: string;
      placeholder?: string;
      href?: string;
      selector: string;
    }>;
  };
  error?: string;
}

// ── 代码执行 ────────────────────────────────────────────────

/** 支持的编程语言 */
export type ExecLanguage = "python" | "node" | "bash";

/** POST /exec 请求体 */
export interface ExecRequest {
  language: ExecLanguage;
  code: string;
  /** 执行超时毫秒数，默认 30000 */
  timeout?: number;
  /** 可选标准输入 */
  stdin?: string;
}

/** POST /exec 响应体 */
export interface ExecResponse {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 执行耗时毫秒 */
  duration: number;
}

// ── 终端 ────────────────────────────────────────────────────

/** POST /terminal 请求体 */
export interface TerminalRequest {
  action: "create" | "input" | "resize" | "kill";
  /** input: 发送的文本 */
  input?: string;
  /** resize: 终端列数 */
  cols?: number;
  /** resize: 终端行数 */
  rows?: number;
}

// ── WebSocket 事件（容器 → Agent API）──────────────────────

/** 沙箱推送的实时事件联合类型 */
export type SandboxEvent =
  | { type: "screencast"; frame: string; url: string; timestamp: number }
  | { type: "stdout"; data: string; stream: "stdout" | "stderr" }
  | { type: "terminal"; data: string }
  | { type: "navigate"; url: string; title: string }
  | { type: "status"; state: "idle" | "busy"; operation?: string }
  | { type: "error"; message: string };
