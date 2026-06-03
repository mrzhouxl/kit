/** 聊天消息 */
export interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  metadata?: MessageMetadata
  createdAt?: string
}

/** 助手消息的结构化元数据 */
export interface MessageMetadata {
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    model: string
    callCount: number
  }
  toolLogs?: ToolLogEntry[]
  images?: string[]
  videos?: string[]
}

/** 工具执行日志条目 */
export interface ToolLogEntry {
  type: 'task_start' | 'task_end' | 'tool_start' | 'tool_end' | 'code_output' | 'video_status' | 'file_preview'
  tool?: string
  agent?: string
  input?: Record<string, unknown>
  result?: string
  success?: boolean
  ts: number
}

/** 会话 */
export interface Session {
  id: number
  userId: number
  threadId: string
  title: string
  mode: string
  createdAt: string
  updatedAt: string
}

/** SSE 事件数据 */
export interface SSEEventData {
  runId?: string
  type: string
  msg?: string
  message?: string
  agent?: string
  title?: string
  reason?: string
  tool?: string
  input?: Record<string, unknown>
  result?: string
  success?: boolean
  image?: string
  url?: string
  data?: string
  stream?: 'stdout' | 'stderr'
  taskId?: string
  status?: string
  progress?: number
  videos?: string[]
  fileName?: string
  fileType?: string
  ts?: number
}

/** 聊天请求体 */
export interface ChatRequest {
  messages: { role: string; content: string }[]
  threadId?: string
  runId?: string
  systemPrompt?: string
  maxSteps?: number
}

/** 模型信息 */
export interface ModelInfo {
  id: string
  name: string
  description?: string
}
