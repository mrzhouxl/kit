/**
 * sandbox/sandbox.types.ts — 沙箱相关类型定义
 *
 * Agent API 侧用于管理沙箱容器的类型。
 */
import type WebSocket from "ws";

// ── 沙箱配置 ────────────────────────────────────────────────

/** 沙箱运行时配置 */
export interface SandboxConfig {
  /** Docker 镜像名 */
  image: string;
  /** 最大并发容器数（含预热池） */
  maxContainers: number;
  /** 容器内存限制（如 "512m"） */
  memoryLimit: string;
  /** 容器 CPU 限制（核数） */
  cpuLimit: number;
  /** 隔离网络名 */
  network: string;
  /** Agent 访问宿主机映射端口时使用的基地址 */
  hostBaseUrl: string;
  /** 宿主机端口起始范围 */
  portRangeStart: number;
  /** 会话空闲超时回收（ms） */
  idleTimeoutMs: number;
  /** 空闲回收扫描间隔（ms） */
  cleanupIntervalMs: number;
  /** 预热池大小 */
  warmPoolSize: number;
  /** 预热池补充延迟（ms） */
  warmPoolRefillDelayMs: number;
  /** 排队等待超时（ms） */
  queueTimeoutMs: number;
  /** 健康巡检间隔（ms） */
  healthCheckIntervalMs: number;
  /** 单次健康检查超时（ms） */
  healthCheckTimeoutMs: number;
  /** 宿主机工作区根目录 */
  workspaceBaseDir: string;
  /** 容器内工作目录 */
  containerWorkDir: string;
}

// ── 沙箱会话 ────────────────────────────────────────────────

/** 沙箱容器会话信息 */
export interface SandboxSession {
  /** 用户 + thread 组成的唯一会话键 */
  sessionKey: string;
  /** Docker 容器 ID */
  containerId: string;
  /** 归属用户键（已脱敏） */
  userId: string;
  /** LangGraph 会话线程 ID */
  threadId: string;
  /** 容器 HTTP 服务地址（如 http://localhost:32001） */
  baseUrl: string;
  /** 事件 WebSocket 连接 */
  ws: WebSocket | null;
  /** 容器创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 容器状态 */
  state: "starting" | "ready" | "busy" | "stopping";
  /** 宿主机映射端口 */
  hostPort: number;
  /** 宿主机上该会话的持久化工作区路径（如 /data/sandbox-workspaces/123/thread-abc） */
  workspaceDir: string;
}

/** 预热池中的待分配容器 */
export interface WarmContainer {
  /** Docker 容器 ID */
  containerId: string;
  /** 容器 HTTP 服务地址 */
  baseUrl: string;
  /** 宿主机映射端口 */
  hostPort: number;
  /** 创建时间 */
  createdAt: number;
}

// ── 执行指标 ────────────────────────────────────────────────

/** 沙箱执行指标统计 */
export interface SandboxMetrics {
  /** 总创建容器次数 */
  containersCreated: number;
  /** 从预热池取出的次数 */
  warmPoolHits: number;
  /** 预热池为空导致冷启动的次数 */
  warmPoolMisses: number;
  /** 排队请求总数 */
  queuedRequests: number;
  /** 排队超时被拒绝的请求数 */
  queueTimeouts: number;
  /** 代码执行总次数 */
  execTotal: number;
  /** 代码执行成功次数 */
  execSuccess: number;
  /** 代码执行失败次数 */
  execFailed: number;
  /** 浏览器操作总次数 */
  browseTotal: number;
  /** 健康巡检失败并回收的次数 */
  unhealthyRecycled: number;
  /** 空闲回收次数 */
  idleRecycled: number;
  /** 当前活跃容器数 */
  activeContainers: number;
  /** 当前预热池容器数 */
  warmPoolSize: number;
  /** 当前排队等待数 */
  queueLength: number;
  /** 启动时间 */
  startedAt: number;
}

// ── 复用沙箱服务的类型（镜像 sandbox-server 的定义）───────

export type BrowseAction =
  | "goto" | "click" | "type" | "scroll"
  | "screenshot" | "wait" | "content" | "inspect";

export interface BrowseRequest {
  action: BrowseAction;
  url?: string;
  selector?: string;
  text?: string;
  direction?: "up" | "down";
  distance?: number;
  timeout?: number;
}

export interface BrowseResponse {
  success: boolean;
  data?: {
    title?: string;
    url?: string;
    screenshot?: string;
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
  /** 超时时附带的当前页面 URL */
  currentUrl?: string;
  /** 超时时附带的当前页面标题 */
  currentTitle?: string;
  /** 超时时附带的可用元素列表 */
  availableElements?: Array<{ tag: string; id?: string; text?: string; selector: string }>;
}

export type ExecLanguage = "python" | "node" | "bash";

export interface ExecRequest {
  language: ExecLanguage;
  code: string;
  timeout?: number;
  stdin?: string;
}

export interface ExecResponse {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

// ── 沙箱推送的实时事件 ──────────────────────────────────────

export type SandboxEvent =
  | { type: "screencast"; frame: string; url: string; timestamp: number }
  | { type: "stdout"; data: string; stream: "stdout" | "stderr" }
  | { type: "terminal"; data: string }
  | { type: "navigate"; url: string; title: string }
  | { type: "status"; state: "idle" | "busy"; operation?: string }
  | { type: "notify"; message: string }
  | {
      type: "video_status";
      taskId: string;
      status: "pending" | "processing" | "success" | "failed";
      rawStatus?: string;
      progress?: number;
      size?: string;
      model?: string;
      seconds?: string;
      createdAt?: number;
      url?: string;
      error?: string;
    }
  | { type: "file_preview"; url: string; fileName: string; fileType: "office" | "pdf" | "image" | "markdown" | "text" | "html" | "mindmap" }
  | { type: "error"; message: string };
