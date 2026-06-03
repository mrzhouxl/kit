import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Session, ChatMessage, SSEEventData } from '@/api/types'
import { getSessions, getSessionMessages, createSession, deleteSession, chatSSE } from '@/api'

/** Agent 对话状态管理 */
export const useAgentStore = defineStore('agent', () => {
  /* 会话 */
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<number | null>(null)
  const currentSession = ref<Session | null>(null)

  /* 消息 */
  const messages = ref<ChatMessage[]>([])

  /* 流式状态 */
  const isStreaming = ref(false)
  const streamingContent = ref('')
  const thinkingText = ref('')
  const abortController = ref<AbortController | null>(null)

  /* 实时面板 */
  const browserFrame = ref('')
  const browserUrl = ref('')
  const terminalLines = ref<{ text: string; stream: string }[]>([])
  const activePanelTab = ref<'browser' | 'terminal'>('browser')
  const showPanel = ref(false)

  /** 加载会话列表 */
  async function loadSessions() {
    const res = await getSessions()
    sessions.value = res.data.sessions || []
  }

  /** 选择会话并加载消息 */
  async function selectSession(id: number) {
    currentSessionId.value = id
    currentSession.value = sessions.value.find((s) => s.id === id) || null
    const res = await getSessionMessages(id)
    messages.value = res.data.messages || []
    /* 重置面板 */
    browserFrame.value = ''
    browserUrl.value = ''
    terminalLines.value = []
  }

  /** 新建会话 */
  async function newSession() {
    const res = await createSession()
    const session = res.data.session
    sessions.value.unshift(session)
    await selectSession(session.id)
    return session
  }

  /** 删除会话 */
  async function removeSession(id: number) {
    await deleteSession(id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (currentSessionId.value === id) {
      currentSessionId.value = null
      currentSession.value = null
      messages.value = []
    }
  }

  /** 发送消息（SSE 流式） */
  async function sendMessage(content: string) {
    if (!currentSession.value) return
    if (isStreaming.value) return

    /* 添加用户消息 */
    const userMsg: ChatMessage = { role: 'user', content }
    messages.value.push(userMsg)

    /* 准备流式状态 */
    isStreaming.value = true
    streamingContent.value = ''
    thinkingText.value = '正在思考...'
    showPanel.value = false

    const controller = new AbortController()
    abortController.value = controller

    /* 生成 runId */
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    /* 构建请求 */
    const reqMessages = messages.value.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    try {
      await chatSSE(
        {
          messages: reqMessages,
          threadId: currentSession.value.threadId,
          runId,
        },
        (data: Record<string, unknown>) => handleSSEEvent(data as unknown as SSEEventData),
        controller.signal,
      )
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Chat SSE error:', err)
      }
    } finally {
      /* 流式结束：将累积内容写入消息列表 */
      if (streamingContent.value) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: streamingContent.value,
        }
        messages.value.push(assistantMsg)
      }
      isStreaming.value = false
      streamingContent.value = ''
      thinkingText.value = ''
      abortController.value = null
    }
  }

  /** 处理 SSE 事件 */
  function handleSSEEvent(data: SSEEventData) {
    const appendTerminalLine = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => {
      if (!text.trim()) return
      terminalLines.value.push({ text, stream })
    }

    const previewResult = (result?: string) => {
      if (!result) return ''
      return result.length > 180 ? `${result.slice(0, 180)}...` : result
    }

    switch (data.type) {
      case 'text':
        /* 文本 token 追加 */
        thinkingText.value = ''
        streamingContent.value += data.msg || ''
        break

      case 'agent_start':
        thinkingText.value = `${data.agent} 正在工作...`
        break

      case 'agent_end':
        thinkingText.value = ''
        break

      case 'agent_notify':
        /* Agent 通知追加到内容 */
        streamingContent.value += `\n\n> ${data.message}\n\n`
        appendTerminalLine(`[通知] ${data.message || ''}`)
        showPanel.value = true
        activePanelTab.value = 'terminal'
        break

      case 'task_start':
        thinkingText.value = data.title || '执行任务中...'
        appendTerminalLine(`[任务开始] ${data.title || '执行任务中...'}`)
        showPanel.value = true
        activePanelTab.value = 'terminal'
        break

      case 'task_end':
        thinkingText.value = ''
        appendTerminalLine(`[任务结束] ${data.title || '任务已完成'}`)
        break

      case 'tool_start':
        thinkingText.value = `调用工具: ${data.tool}...`
        appendTerminalLine(`[工具调用] ${data.tool || 'unknown'}`)
        showPanel.value = true
        activePanelTab.value = 'terminal'
        break

      case 'tool_end':
        thinkingText.value = ''
        appendTerminalLine(
          `[工具完成] ${data.tool || 'unknown'}${data.success === false ? ' (失败)' : ''}${data.result ? ` - ${previewResult(data.result)}` : ''}`,
          data.success === false ? 'stderr' : 'stdout',
        )
        break

      case 'browser_frame':
        /* 浏览器实时截图 */
        browserFrame.value = data.image || ''
        showPanel.value = true
        activePanelTab.value = 'browser'
        break

      case 'browser_navigate':
        browserUrl.value = data.url || ''
        showPanel.value = true
        activePanelTab.value = 'browser'
        break

      case 'code_output':
        /* 终端输出行 */
        terminalLines.value.push({
          text: data.data || '',
          stream: data.stream || 'stdout',
        })
        showPanel.value = true
        activePanelTab.value = 'terminal'
        break

      case 'error':
        streamingContent.value += `\n\n⚠️ 错误: ${data.msg}\n\n`
        break

      case 'done':
        /* 流式完成 */
        break
    }
  }

  /** 中断当前对话 */
  function stopStreaming() {
    abortController.value?.abort()
  }

  /** 重置全部状态（登出时调用） */
  function $reset() {
    sessions.value = []
    currentSessionId.value = null
    currentSession.value = null
    messages.value = []
    isStreaming.value = false
    streamingContent.value = ''
    thinkingText.value = ''
    abortController.value?.abort()
    abortController.value = null
    browserFrame.value = ''
    browserUrl.value = ''
    terminalLines.value = []
    showPanel.value = false
  }

  return {
    sessions,
    currentSessionId,
    currentSession,
    messages,
    isStreaming,
    streamingContent,
    thinkingText,
    browserFrame,
    browserUrl,
    terminalLines,
    activePanelTab,
    showPanel,
    loadSessions,
    selectSession,
    newSession,
    removeSession,
    sendMessage,
    stopStreaming,
    $reset,
  }
})
