/**
 * api/modules/agent-session.ts — Agent 会话 API
 *
 * 对接 NestJS Agent 服务的会话管理接口（/api/sessions）。
 * 不走 Go 后端的 request 拦截器，直接请求 Agent 服务。
 */
import { resolveAgentBaseUrl } from '@/api/agent-base'

/** Agent 服务地址 */
const AGENT_URL = resolveAgentBaseUrl()

/** 统一的 Agent API 错误类型（携带 HTTP 状态码） */
export interface AgentApiError extends Error {
  status: number
}

/** 会话记录 */
export interface AgentSession {
  id: number
  userId: number
  threadId: string
  title: string
  mode: string
  createdAt: string
  updatedAt: string
}

/** 会话消息 */
export interface AgentMessage {
  id: number
  sessionId: number
  role: string
  content: string
  metadata?: unknown
  createdAt: string
}

/** 获取 Authorization 请求头 */
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** 将非 2xx 响应转换为可读错误（包含 status，便于上层鉴权处理） */
async function createAgentApiError(res: Response, fallback: string): Promise<AgentApiError> {
  let message = `${fallback}: ${res.status}`
  try {
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const data = await res.clone().json() as { message?: string; msg?: string; error?: string }
      message = data.message || data.msg || data.error || message
    } else {
      const text = (await res.clone().text()).trim()
      if (text) message = text
    }
  } catch {
    // 兜底使用 fallback + status
  }

  const error = new Error(message) as AgentApiError
  error.status = res.status
  return error
}

/** 断言响应成功，失败时抛出带状态码错误 */
async function assertAgentApiOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return
  throw await createAgentApiError(res, fallback)
}

/** 创建新会话 */
export async function createAgentSession(title?: string, mode?: string): Promise<AgentSession> {
  const res = await fetch(`${AGENT_URL}/api/sessions`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ title: title || '新会话', mode: mode || 'chat' }),
  })
  await assertAgentApiOk(res, '创建会话失败')
  const data = await res.json()
  return data.session
}

/** 获取会话列表 */
export async function listAgentSessions(): Promise<AgentSession[]> {
  const res = await fetch(`${AGENT_URL}/api/sessions`, {
    headers: getAuthHeaders(),
  })
  await assertAgentApiOk(res, '获取会话列表失败')
  const data = await res.json()
  return data.sessions || []
}

/** 获取会话详情 */
export async function getAgentSession(id: number): Promise<AgentSession> {
  const res = await fetch(`${AGENT_URL}/api/sessions/${id}`, {
    headers: getAuthHeaders(),
  })
  await assertAgentApiOk(res, '获取会话详情失败')
  const data = await res.json()
  return data.session
}

/** 获取会话消息列表 */
export async function getAgentSessionMessages(id: number): Promise<AgentMessage[]> {
  const res = await fetch(`${AGENT_URL}/api/sessions/${id}/messages`, {
    headers: getAuthHeaders(),
  })
  await assertAgentApiOk(res, '获取消息列表失败')
  const data = await res.json()
  return data.messages || []
}

/** 更新会话标题 */
export async function updateAgentSessionTitle(id: number, title: string): Promise<void> {
  const res = await fetch(`${AGENT_URL}/api/sessions/${id}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify({ title }),
  })
  await assertAgentApiOk(res, '更新会话标题失败')
}

/** 删除会话 */
export async function deleteAgentSession(id: number): Promise<void> {
  const res = await fetch(`${AGENT_URL}/api/sessions/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  await assertAgentApiOk(res, '删除会话失败')
}
