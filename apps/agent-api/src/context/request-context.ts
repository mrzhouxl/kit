/**
 * context/request-context.ts — 请求级上下文（AsyncLocalStorage）
 *
 * 使用 Node.js AsyncLocalStorage 在请求的整个生命周期内传递上下文数据，
 * 无需层层传参。主要用于将前端请求的 JWT Token 和 thread 信息透传给 Agent 工具。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** 请求上下文数据结构 */
export interface RequestContext {
  /** 前端请求携带的 JWT Token（不含 Bearer 前缀） */
  jwtToken?: string;
  /** LangGraph / Agent 当前请求所属线程 ID */
  threadId?: string;
  /** 当前请求内是否已查询过 Skills 列表 */
  skillsChecked?: boolean;
  /** 当前请求内的任务连续性判定缓存，避免重复调用分类模型。 */
  contextContinuityCache?: Record<string, boolean>;
}

/** 全局 AsyncLocalStorage 实例 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * 获取当前请求上下文中的 JWT Token。
 * 在 Agent 工具的 execute 中调用此方法即可获取前端传入的 Token。
 */
export function getRequestJwtToken(): string | undefined {
  return requestContextStorage.getStore()?.jwtToken;
}

/**
 * 获取当前请求上下文中的 JWT Token；若缺失则抛出错误。
 * 适用于必须以当前登录用户身份访问下游接口的工具。
 */
export function requireRequestJwtToken(): string {
  const token = getRequestJwtToken();
  if (!token) {
    throw new Error("当前请求未携带用户 JWT，无法以登录身份调用下游接口");
  }
  return token;
}

/**
 * 获取当前请求所属的线程 ID。
 */
export function getRequestThreadId(): string | undefined {
  return requestContextStorage.getStore()?.threadId;
}

/**
 * 获取当前请求的脱敏用户键，用于沙箱归属和隔离。
 *
 * 这里不直接暴露原始 JWT，避免把超长或敏感 token 当作容器名/Map key 使用。
 */
export function getRequestUserKey(): string {
  const token = getRequestJwtToken();
  if (!token) {
    return "anonymous";
  }

  const digest = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `user_${digest}`;
}

/**
 * 获取当前请求对应的会话键（用户 + thread）。
 */
export function getRequestSessionKey(): string | undefined {
  const threadId = getRequestThreadId();
  if (!threadId) {
    return undefined;
  }
  return `${getRequestUserKey()}:${threadId}`;
}

/**
 * 标记当前请求已经查询过 Skills 列表。
 */
export function markSkillsChecked(): void {
  const store = requestContextStorage.getStore();
  if (store) {
    store.skillsChecked = true;
  }
}

/**
 * 当前请求内是否已经查询过 Skills。
 */
export function hasCheckedSkills(): boolean {
  return requestContextStorage.getStore()?.skillsChecked === true;
}

/** 获取当前请求内缓存的任务连续性判定结果。 */
export function getCachedContextContinuity(cacheKey: string): boolean | undefined {
  return requestContextStorage.getStore()?.contextContinuityCache?.[cacheKey];
}

/** 写入当前请求内缓存的任务连续性判定结果。 */
export function setCachedContextContinuity(cacheKey: string, value: boolean): void {
  const store = requestContextStorage.getStore();
  if (!store) {
    return;
  }

  if (!store.contextContinuityCache) {
    store.contextContinuityCache = {};
  }

  store.contextContinuityCache[cacheKey] = value;
}
