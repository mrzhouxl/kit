import http from './http'
import type { Session, ChatMessage, ModelInfo } from './types'

/** ===== 会话 API ===== */

/** 创建新会话 */
export function createSession(title?: string) {
  return http.post<{ session: Session }>('/sessions', { title })
}

/** 获取会话列表 */
export function getSessions() {
  return http.get<{ sessions: Session[] }>('/sessions')
}

/** 获取单个会话详情 */
export function getSession(id: number) {
  return http.get<{ session: Session }>(`/sessions/${id}`)
}

/** 获取会话消息列表 */
export function getSessionMessages(id: number) {
  return http.get<{ messages: ChatMessage[] }>(`/sessions/${id}/messages`)
}

/** 更新会话标题 */
export function updateSession(id: number, title: string) {
  return http.patch(`/sessions/${id}`, { title })
}

/** 删除会话 */
export function deleteSession(id: number) {
  return http.delete(`/sessions/${id}`)
}

/** ===== 聊天 API ===== */

/** 获取可用模型列表 */
export function getModels() {
  return http.get<{ models: ModelInfo[] }>('/chat/models')
}

/** ===== SSE 流式对话 ===== */

/**
 * 发起 SSE 流式对话
 * @param body 请求体
 * @param onEvent SSE 事件回调
 * @param signal AbortSignal，用于中断请求
 */
export async function chatSSE(
  body: Record<string, unknown>,
  onEvent: (data: Record<string, unknown>) => void,
  signal?: AbortSignal,
) {
  const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'
  const token = localStorage.getItem('token')
  const res = await fetch(`${apiBase}/api/chat/sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    throw new Error(`Chat request failed: ${res.status}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  /* 逐行解析 SSE */
  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    /* 最后一行可能不完整，保留到下一轮 */
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      try {
        const data = JSON.parse(raw)
        onEvent(data)
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  }
}
