<script setup lang="ts">
/**
 * agent.vue — Kit 工作台（TDesign Chat 版本）
 *
 * 对接 Agent 服务，通过 SSE 端点与
 * TDesign Chat 组件（t-chatbot）集成，提供流式 Agent 对话。
 * 左侧可收折配置面板用于调整工具集、步数、项目上下文等。
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { MessagePlugin, Space, ImageViewer } from 'tdesign-vue-next'
import { resolveAgentBaseUrl } from '@/api/agent-base'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import AppIcon from '@/components/AppIcon.vue'
import { CloseOne, RefreshOne, Plus, PreviewOpen } from '@/utils/app-icons'
import {
  listAgentSessions,
  createAgentSession,
  getAgentSessionMessages,
  deleteAgentSession,
  type AgentSession,
  type AgentMessage,
  type AgentApiError,
} from '@/api/modules/agent-session'
import { uploadProjectIconApi } from '@/api/modules/project'
import { AUTH_REQUIRED_EVENT } from '@/api/request'
import kitLogo from '@/assets/kit cat.png'
import LoginView from '@/views/login/LoginView.vue'
import { LivePanel, useLivePanelState, useLivePanelActions } from './live-panel'
import type {
  SSEChunkData,
  AIMessageContent,
  ChatMessagesData,
  ChatServiceConfig,
  TdChatbotApi,
  TdChatMessageConfigItem,
  SuggestionItem,
  ChatRequestParams,
} from '@tdesign-vue-next/chat'

const appStore = useAppStore()
const authStore = useAuthStore()
const themeClass = computed(() => appStore.theme)
const isAuthenticated = computed(() => authStore.isAuthenticated())
const showLogin = ref(false)

/** 打开登录弹窗 */
function openLogin() {
  showLogin.value = true
}

/** 关闭登录弹窗并在登录成功后拉取会话 */
async function closeLogin() {
  showLogin.value = false
  if (!authStore.isAuthenticated()) return
  await initializeSessions()
}

// ── Agent 配置 ────────────────────────────────────────────────
const AGENT_URL = resolveAgentBaseUrl()
const AGENT_RUNTIME_STORAGE_KEY = 'ai-comics:agent-runtime'

async function readResponseErrorMessage(response: Response): Promise<string> {
  const fallback = `请求失败: ${response.status}`

  try {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const data = await response.clone().json() as {
        message?: string | string[]
        error?: string
        msg?: string
      }
      const message = Array.isArray(data.message) ? data.message.join('；') : data.message
      return message || data.error || data.msg || fallback
    }

    const text = (await response.clone().text()).trim()
    return text || fallback
  } catch {
    return fallback
  }
}

// ── UI 状态 ───────────────────────────────────────────────────
const chatRef = ref<TdChatbotApi | null>(null)
const sessionKey = ref(0) // 用于重置 chatbot 组件

interface AgentAttachmentItem {
  key: string
  name: string
  size: number
  status?: 'progress' | 'success' | 'fail'
  description?: string
  url?: string
  mimeType: string
}

const MAX_AGENT_ATTACHMENTS = 5
const pendingAttachments = ref<AgentAttachmentItem[]>([])

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function clearAllAttachments() {
  pendingAttachments.value = []
}

type FileSelectPayload = {
  files?: File[]
  name?: string
  e?: Event
}

function readFilesFromPayload(payload: unknown): File[] {
  // web 组件(omi)路径：fire('fileSelect', files) => CustomEvent, files 在 detail 中
  if (payload instanceof CustomEvent) {
    const detail = payload.detail
    return Array.isArray(detail) ? detail : []
  }
  // Vue 组件路径：emit('fileSelect', { files, name, e })
  const typed = (payload || {}) as FileSelectPayload
  if (Array.isArray(typed.files)) return typed.files
  // 直接传入 File[] 的兜底
  if (Array.isArray(payload)) return payload as File[]
  return []
}

function updateAttachmentItem(key: string, patch: Partial<AgentAttachmentItem>) {
  pendingAttachments.value = pendingAttachments.value.map((item) => (
    item.key === key ? { ...item, ...patch } : item
  ))
}

interface MediaItem {
  url: string
  alt?: string
  title?: string
}

function listMediaWithUrl(data: unknown): MediaItem[] {
  if (!Array.isArray(data)) return []
  return data
    .filter((entry): entry is Record<string, unknown> => {
      return !!entry && typeof entry === 'object' && typeof (entry as { url?: unknown }).url === 'string' && !!(entry as { url?: string }).url
    })
    .map((entry) => {
      const alt = typeof entry.alt === 'string' ? entry.alt : undefined
      const title = typeof entry.title === 'string' ? entry.title : undefined
      return {
        url: String(entry.url),
        alt,
        title,
      }
    })
}

function listMediaUrls(data: unknown): string[] {
  return listMediaWithUrl(data).map((entry) => String(entry.url || ''))
}

/**
 * 处理全局粘贴事件（Ctrl+V / Cmd+V）。
 * 将剪贴板中的文件/图片提取为 File 对象，复用已有的上传流程。
 */
function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length === 0) return
  // 有文件时阻止默认粘贴行为（防止文本框同时插入垃圾内容）
  e.preventDefault()
  handleSenderFileSelect(files)
}

async function handleSenderFileSelect(payload: unknown) {
  console.log('[agent] fileSelect payload:', payload, typeof payload)
  const selectedFiles = readFilesFromPayload(payload)
  console.log('[agent] parsed files:', selectedFiles)
  if (selectedFiles.length === 0) return

  const remain = Math.max(0, MAX_AGENT_ATTACHMENTS - pendingAttachments.value.length)
  if (remain === 0) {
    MessagePlugin.warning(`最多添加 ${MAX_AGENT_ATTACHMENTS} 个附件`)
    return
  }

  const uploadQueue = selectedFiles.slice(0, remain)
  if (selectedFiles.length > remain) {
    MessagePlugin.warning(`已超过上限，仅保留前 ${remain} 个文件`)
  }

  for (const file of uploadQueue) {
    const key = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const mimeType = file.type || 'application/octet-stream'
    const item: AgentAttachmentItem = {
      key,
      name: file.name,
      size: file.size,
      status: 'progress',
      description: '上传中',
      mimeType,
    }
    pendingAttachments.value = [item, ...pendingAttachments.value]

    // 所有文件统一上传到服务器（图片/文档/Word 等）
    try {
      const uploaded = await uploadProjectIconApi(file)
      updateAttachmentItem(key, {
        status: 'success',
        url: uploaded.file_url,
        description: formatAttachmentSize(file.size),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '上传失败'
      updateAttachmentItem(key, {
        status: 'fail',
        description: '上传失败，仅发送文件信息',
      })
      MessagePlugin.warning(`${file.name}：${msg}`)
    }
  }
}

function handleSenderRemove(e: CustomEvent<{ key?: string }> | { detail?: { key?: string }; key?: string }) {
  const key = e?.detail?.key || (e as { key?: string })?.key
  if (!key) return
  pendingAttachments.value = pendingAttachments.value.filter((item) => item.key !== key)
}

function handleSenderFileClick(e: CustomEvent<{ name?: string }>) {
  const name = e?.detail?.name || '附件'
  MessagePlugin.info(`已选择：${name}`)
}

function buildAttachmentPromptSuffix(attachments: AgentAttachmentItem[]): string {
  if (attachments.length === 0) return ''

  const lines = attachments.map((item, index) => {
    const base = `- 附件${index + 1}：${item.name}（${item.mimeType}，${formatAttachmentSize(item.size)}）`
    return item.url ? `${base}\n  URL: ${item.url}` : base
  })
  return `\n\n[用户上传的附件]\n${lines.join('\n')}`
}

// ── 沙箱实时操作面板（LivePanel 组件化） ──────────────────────
const panelState = useLivePanelState()
const panelActions = useLivePanelActions(panelState)

// 解构常用状态，方便 SSE 事件处理和模板使用
const {
  visible: livePanel,
  activeTab: livePanelTab,
  browserFrame,
  browserUrl,
  browserTitle,
  terminalLines,
  sandboxStatus,
  sandboxOperation,
  previewFile,
  previewLoading,
  previewPinned,
  previewTextContent,
  newRoundPending,
  lastEditedFile,
  artifacts: sessionArtifacts,
  artifactsDialogVisible,
} = panelState

const {
  addArtifact,
  openArtifact,
  restoreFromMessages: restoreMetadataFromMessages,
  appendTerminalLine,
  switchTabSafe,
} = panelActions

/** 右侧面板宽度百分比 */
const panelWidthPct = ref(35)
/** 是否正在拖拽 */
const isDragging = ref(false)
/** 根容器 ref，用于计算拖拽比例 */
const agentRootRef = ref<HTMLDivElement | null>(null)

// ── 产出条定位：动态获取 sender 到容器底部的距离 ──────────────────────────
const chatBodyRef = ref<HTMLDivElement | null>(null)
/** sender 到 chatBody 底部的距离（包含 padding），用于绝对定位产出条 */
const DEFAULT_SENDER_BOTTOM = 140
const senderBottomDistance = ref(DEFAULT_SENDER_BOTTOM)
let senderResizeObs: ResizeObserver | null = null

/** 通过 shadow DOM 查找 t-chat-sender 元素 */
function resolveSenderElement(chatbot: Element): HTMLElement | null {
  const chatbotRoot = chatbot.shadowRoot || chatbot
  const senderHost = chatbotRoot.querySelector('t-chat-sender')
  if (senderHost instanceof HTMLElement) return senderHost
  const fallback = chatbotRoot.querySelector('.t-chat-sender, .t-chat__input, .t-chat-sender__textarea')
  return fallback instanceof HTMLElement ? fallback : null
}

/** 用 getBoundingClientRect 计算 sender 顶部到 chatBody 底部的实际距离 */
function measureSenderBottom(sender: HTMLElement) {
  if (!chatBodyRef.value) return
  const chatBodyRect = chatBodyRef.value.getBoundingClientRect()
  const senderRect = sender.getBoundingClientRect()
  const distance = chatBodyRect.bottom - senderRect.top
  if (distance > 0) senderBottomDistance.value = distance
}

/** 查找 sender 元素并监听尺寸变化，带重试 */
function observeSenderHeight(retries = 5) {
  if (!chatBodyRef.value) return
  const chatbot = chatBodyRef.value.querySelector('t-chatbot')
  if (!chatbot) {
    if (retries > 0) setTimeout(() => observeSenderHeight(retries - 1), 300)
    return
  }
  const sender = resolveSenderElement(chatbot)
  if (!sender) {
    if (retries > 0) setTimeout(() => observeSenderHeight(retries - 1), 300)
    return
  }
  senderResizeObs?.disconnect()
  // 初始测量
  measureSenderBottom(sender)
  // 监听 sender 尺寸变化（如多行输入）
  senderResizeObs = new ResizeObserver(() => {
    measureSenderBottom(sender)
  })
  senderResizeObs.observe(sender)
}

// session 切换时 t-chatbot 会被销毁重建，需要重新观察 sender
watch(sessionKey, () => {
  senderResizeObs?.disconnect()
  senderBottomDistance.value = DEFAULT_SENDER_BOTTOM
  nextTick(() => setTimeout(observeSenderHeight, 300))
})

onUnmounted(() => {
  senderResizeObs?.disconnect()
})

/** 拖拽开始 */
function onResizeStart(e: MouseEvent) {
  e.preventDefault()
  isDragging.value = true
  const startX = e.clientX
  const rootEl = agentRootRef.value
  if (!rootEl) return
  const rootWidth = rootEl.offsetWidth
  const startPct = panelWidthPct.value

  const onMove = (ev: MouseEvent) => {
    const dx = startX - ev.clientX
    const deltaPct = (dx / rootWidth) * 100
    const newPct = Math.min(75, Math.max(25, startPct + deltaPct))
    panelWidthPct.value = Math.round(newPct)
  }
  const onUp = () => {
    isDragging.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
/** 代码执行过程中的输出累积（用于内联展示） */
const codeExecOutputLines = ref<string[]>([])
/** 浏览器内联通知是否已展示（每次 browse 操作只显示一次） */
const browserInlineNotified = ref(false)
/** 当前正在执行的 Agent 节点（用于去重 agent_start 通知） */
const currentAgent = ref('')

// ── 思考 Loading（聊天消息区底部显示） ─────────────────────────
/** Agent 是否正在执行中 */
const thinkingActive = ref(false)
/** 当前思考阶段文案 */
const thinkingText = ref('')

/** Agent 节点名称到中文标签映射 */
const AGENT_LABELS: Record<string, string> = {
  web_agent: '正在搜索网络…',
  code_agent: '正在编写代码…',
  image_agent: '正在生成图像/视频…',
  comics_agent: '正在操作平台…',
  supervisor: '正在思考…',
}

/**
 * 会话线程 ID：用于后端 LangGraph Checkpointer 持续上下文。
 * 清空对话时会重置为新线程，避免串会话。
 */
function createThreadId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `thread_${Date.now()}_${Math.random().toString(16).slice(2)}`
}
const threadId = ref(createThreadId())
const activeRunId = ref('')

function loadPersistedRuntime() {
  if (typeof window === 'undefined') return

  try {
    const raw = window.localStorage.getItem(AGENT_RUNTIME_STORAGE_KEY)
    if (!raw) return

    const parsed = JSON.parse(raw) as Partial<{
      threadId: string
      currentSessionId: number
    }>

    if (typeof parsed.threadId === 'string' && parsed.threadId.trim()) {
      threadId.value = parsed.threadId
    }
    if (typeof parsed.currentSessionId === 'number') {
      currentSessionId.value = parsed.currentSessionId
    }
  } catch {
    // ignore invalid local cache
  }
}

function persistRuntime() {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(AGENT_RUNTIME_STORAGE_KEY, JSON.stringify({
    threadId: threadId.value,
    currentSessionId: currentSessionId.value,
  }))
}

watch(threadId, () => {
  persistRuntime()
})

// ── 会话管理 ──────────────────────────────────────────────────
/** 会话列表 */
const sessions = ref<AgentSession[]>([])
/** 当前选中的会话 ID */
const currentSessionId = ref<number | null>(null)
/** 会话侧边栏是否折叠 */
const sidebarCollapsed = ref(false)
/** 会话列表加载中 */
const sessionsLoading = ref(false)

/** 提取错误状态码，统一处理接口 401 */
function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as AgentApiError).status
  return typeof status === 'number' ? status : undefined
}

/** 鉴权错误统一处理：提示并拉起登录弹窗 */
function handleAuthRequired(message = '请先登录后再继续') {
  MessagePlugin.warning(message)
  openLogin()
}

/** 需要登录的动作守卫 */
function ensureAuthenticated(message = '请先登录后再继续'): boolean {
  if (authStore.isAuthenticated()) return true
  handleAuthRequired(message)
  return false
}

/** 时间格式化 */
function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

type AgentImageContentItem = {
  url: string
  alt?: string
}

type AgentVideoContentItem = {
  url: string
  title?: string
  prompt?: string
  placeholder?: boolean
  status?: string
  progress?: number
  taskId?: string
  seconds?: string
  size?: string
  error?: string
}

type AgentMessageMetadata = {
  images?: string[]
  videos?: string[]
}

type ImageGenerationPlaceholderState = {
  visible: boolean
  prompt: string
}

type VideoGenerationPlaceholderState = {
  visible: boolean
  prompt: string
  taskId: string
  status: string
  progress: number | null
  seconds: string
  size: string
  error: string
}

const GENERATION_PLACEHOLDER_MESSAGE_ID = '__generation_placeholder__'

const MARKDOWN_IMAGE_REGEXP = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g

function isPlayableVideoUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase()
  return ['.mp4', '.webm', '.mov', '.m4v'].some((suffix) => normalized.includes(suffix))
}

function collectMetadataImages(metadata?: unknown): AgentImageContentItem[] {
  const imageUrls = (metadata as AgentMessageMetadata | undefined)?.images
  if (!Array.isArray(imageUrls)) return []

  return imageUrls
    .filter((url): url is string => typeof url === 'string' && !!url.trim())
    .map((url) => ({ url, alt: '生成图片' }))
}

function collectMetadataVideos(metadata?: unknown): AgentVideoContentItem[] {
  const videoUrls = (metadata as AgentMessageMetadata | undefined)?.videos
  if (!Array.isArray(videoUrls)) return []

  return videoUrls
    .filter((url): url is string => typeof url === 'string' && !!url.trim())
    .map((url) => ({ url, title: '生成视频' }))
}

function buildAssistantMessageContent(content: string, metadata?: unknown): AIMessageContent[] {
  const images: AgentImageContentItem[] = collectMetadataImages(metadata)
  const videos: AgentVideoContentItem[] = collectMetadataVideos(metadata)
  const knownImageUrls = new Set(images.map((item) => item.url))
  const knownVideoUrls = new Set(videos.map((item) => item.url))
  const markdown = content
    .replace(MARKDOWN_IMAGE_REGEXP, (_, alt: string, url: string) => {
      if (isPlayableVideoUrl(url)) {
        if (!knownVideoUrls.has(url)) {
          videos.push({ url, title: alt || '生成视频' })
          knownVideoUrls.add(url)
        }
        return ''
      }

      if (!knownImageUrls.has(url)) {
        images.push({ url, alt: alt || '生成图片' })
        knownImageUrls.add(url)
      }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const items: AIMessageContent[] = []
  if (markdown) {
    items.push({ type: 'markdown', status: 'complete', data: markdown } as AIMessageContent)
  }
  if (images.length > 0) {
    items.push({ type: 'imageview', status: 'complete', data: images } as unknown as AIMessageContent)
  }
  if (videos.length > 0) {
    items.push({ type: 'videoview', status: 'complete', data: videos } as unknown as AIMessageContent)
  }

  return items.length > 0
    ? items
    : [{ type: 'markdown', status: 'complete', data: content } as AIMessageContent]
}

const imageGenerationPlaceholder = ref<ImageGenerationPlaceholderState>({
  visible: false,
  prompt: '',
})

const videoGenerationPlaceholder = ref<VideoGenerationPlaceholderState>({
  visible: false,
  prompt: '',
  taskId: '',
  status: '',
  progress: null,
  seconds: '',
  size: '',
  error: '',
})

function buildImageGenerationPlaceholderContent(): AIMessageContent {
  return {
    type: 'imageview',
    status: 'loading',
    data: [
      {
        url: '',
        alt: '图片生成占位',
        prompt: imageGenerationPlaceholder.value.prompt,
        placeholder: true,
      },
    ],
  } as unknown as AIMessageContent
}

function buildVideoGenerationPlaceholderContent(): AIMessageContent {
  return {
    type: 'videoview',
    status: 'loading',
    data: [
      {
        url: '',
        title: '视频生成占位',
        prompt: videoGenerationPlaceholder.value.prompt,
        placeholder: true,
        status: videoGenerationPlaceholder.value.status,
        progress: videoGenerationPlaceholder.value.progress ?? undefined,
        taskId: videoGenerationPlaceholder.value.taskId,
        seconds: videoGenerationPlaceholder.value.seconds,
        size: videoGenerationPlaceholder.value.size,
        error: videoGenerationPlaceholder.value.error,
      },
    ],
  } as unknown as AIMessageContent
}

function isImageGenerationPlaceholderContent(content: unknown): boolean {
  const typed = content as {
    type?: string
    data?: Array<{ placeholder?: boolean }>
  }
  return typed.type === 'imageview'
    && Array.isArray(typed.data)
    && typed.data.some((item) => item?.placeholder === true)
}

function isVideoGenerationPlaceholderContent(content: unknown): boolean {
  const typed = content as {
    type?: string
    data?: Array<{ placeholder?: boolean }>
  }
  return typed.type === 'videoview'
    && Array.isArray(typed.data)
    && typed.data.some((item) => item?.placeholder === true)
}

function stripGenerationPlaceholderContent(messages: ChatMessagesData[]): ChatMessagesData[] {
  const nextMessages: ChatMessagesData[] = []

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      nextMessages.push(message)
      continue
    }

    const assistantContent = message.content as AIMessageContent[]
    const strippedContent = assistantContent.filter((content) => (
      !isImageGenerationPlaceholderContent(content)
      && !isVideoGenerationPlaceholderContent(content)
    ))
    const removedPlaceholder = strippedContent.length !== assistantContent.length

    if (removedPlaceholder && strippedContent.length === 0 && message.id === GENERATION_PLACEHOLDER_MESSAGE_ID) {
      continue
    }

    nextMessages.push({
      ...message,
      content: strippedContent,
    })
  }

  return nextMessages
}

function mergePlaceholderIntoMessages(messages: ChatMessagesData[]): ChatMessagesData[] {
  const baseMessages = stripGenerationPlaceholderContent(messages)
  const placeholderContents: AIMessageContent[] = []

  if (imageGenerationPlaceholder.value.visible) {
    placeholderContents.push(buildImageGenerationPlaceholderContent())
  }
  if (videoGenerationPlaceholder.value.visible) {
    placeholderContents.push(buildVideoGenerationPlaceholderContent())
  }

  if (placeholderContents.length === 0) {
    return baseMessages
  }
  const lastAssistantIndex = [...baseMessages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === 'assistant')?.index

  if (typeof lastAssistantIndex === 'number') {
    const nextMessages = [...baseMessages]
    const assistantMessage = nextMessages[lastAssistantIndex]
    const assistantContent = assistantMessage && Array.isArray(assistantMessage.content)
      ? assistantMessage.content as AIMessageContent[]
      : []

    nextMessages[lastAssistantIndex] = {
      ...(assistantMessage as ChatMessagesData),
      role: 'assistant',
      content: [...assistantContent, ...placeholderContents],
    } as ChatMessagesData

    return nextMessages
  }

  return [
    ...baseMessages,
    {
      id: GENERATION_PLACEHOLDER_MESSAGE_ID,
      role: 'assistant',
      content: placeholderContents,
    },
  ]
}

function extractImageGenerationPrompt(input?: Record<string, unknown>): string {
  if (typeof input?.prompt === 'string') {
    return input.prompt.trim()
  }

  const nestedInput = input?.input
  if (typeof nestedInput === 'string') {
    try {
      const parsed = JSON.parse(nestedInput) as { prompt?: unknown }
      return typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
    } catch {
      return ''
    }
  }

  if (nestedInput && typeof nestedInput === 'object' && typeof (nestedInput as { prompt?: unknown }).prompt === 'string') {
    return ((nestedInput as { prompt: string }).prompt || '').trim()
  }

  return ''
}

function applyChatbotMessages(messages: ChatMessagesData[]) {
  const nextMessages = mergePlaceholderIntoMessages(messages)
  chatbotMessages.value = nextMessages
  ;(chatRef.value as (TdChatbotApi & {
    setMessages?: (nextMessages: ChatMessagesData[], mode?: 'replace' | 'append') => void
  }) | null)?.setMessages?.(nextMessages, 'replace')
}

function syncChatbotMessagesWithPlaceholder() {
  applyChatbotMessages(trackedMessages.value)
}

function schedulePlaceholderSync() {
  window.setTimeout(() => {
    syncChatbotMessagesWithPlaceholder()
  }, 0)
}

function showImageGenerationPlaceholder(input?: Record<string, unknown>) {
  const prompt = extractImageGenerationPrompt(input)
  imageGenerationPlaceholder.value = {
    visible: true,
    prompt: prompt.slice(0, 60),
  }
  schedulePlaceholderSync()
}

function hideImageGenerationPlaceholder() {
  imageGenerationPlaceholder.value = {
    visible: false,
    prompt: '',
  }
  schedulePlaceholderSync()
}

function extractVideoField(input: Record<string, unknown> | undefined, key: 'prompt' | 'seconds' | 'size'): string {
  if (typeof input?.[key] === 'string') {
    return input[key].trim()
  }

  const nestedInput = input?.input
  if (typeof nestedInput === 'string') {
    try {
      const parsed = JSON.parse(nestedInput) as Record<string, unknown>
      return typeof parsed[key] === 'string' ? parsed[key].trim() : ''
    } catch {
      return ''
    }
  }

  if (nestedInput && typeof nestedInput === 'object' && typeof (nestedInput as Record<string, unknown>)[key] === 'string') {
    return String((nestedInput as Record<string, unknown>)[key]).trim()
  }

  return ''
}

function showVideoGenerationPlaceholder(input?: Record<string, unknown>) {
  videoGenerationPlaceholder.value = {
    visible: true,
    prompt: extractVideoField(input, 'prompt').slice(0, 60),
    taskId: '',
    status: '任务已提交，正在排队',
    progress: null,
    seconds: extractVideoField(input, 'seconds'),
    size: extractVideoField(input, 'size'),
    error: '',
  }
  schedulePlaceholderSync()
}

function updateVideoGenerationPlaceholder(payload?: Record<string, unknown>) {
  if (!payload) return

  const normalizedStatus = typeof payload.status === 'string' ? payload.status : ''
  const rawStatus = typeof payload.rawStatus === 'string' ? payload.rawStatus : ''
  const nextProgress = typeof payload.progress === 'number'
    ? Math.max(0, Math.min(100, payload.progress))
    : videoGenerationPlaceholder.value.progress
  const nextStatus = typeof payload.error === 'string' && payload.error
    ? payload.error
    : normalizedStatus === 'success'
      ? '视频生成完成'
      : normalizedStatus === 'failed'
        ? '视频生成失败'
        : rawStatus || (normalizedStatus === 'processing' ? '正在生成视频' : '任务已提交，正在排队')

  videoGenerationPlaceholder.value = {
    visible: true,
    prompt: videoGenerationPlaceholder.value.prompt,
    taskId: typeof payload.taskId === 'string' ? payload.taskId : videoGenerationPlaceholder.value.taskId,
    status: nextStatus,
    progress: nextProgress ?? null,
    seconds: typeof payload.seconds === 'string' ? payload.seconds : videoGenerationPlaceholder.value.seconds,
    size: typeof payload.size === 'string' ? payload.size : videoGenerationPlaceholder.value.size,
    error: typeof payload.error === 'string' ? payload.error : '',
  }
  schedulePlaceholderSync()
}

function hideVideoGenerationPlaceholder() {
  videoGenerationPlaceholder.value = {
    visible: false,
    prompt: '',
    taskId: '',
    status: '',
    progress: null,
    seconds: '',
    size: '',
    error: '',
  }
  schedulePlaceholderSync()
}

function hideAllGenerationPlaceholders() {
  imageGenerationPlaceholder.value = {
    visible: false,
    prompt: '',
  }
  videoGenerationPlaceholder.value = {
    visible: false,
    prompt: '',
    taskId: '',
    status: '',
    progress: null,
    seconds: '',
    size: '',
    error: '',
  }
  schedulePlaceholderSync()
}

/** 加载会话列表 */
async function loadSessions() {
  if (!authStore.isAuthenticated()) {
    sessions.value = []
    return
  }

  sessionsLoading.value = true
  try {
    sessions.value = await listAgentSessions()
  } catch (error) {
    if (getErrorStatus(error) === 401) {
      sessions.value = []
      handleAuthRequired('登录后可查看历史会话')
      return
    }
    MessagePlugin.error('加载会话列表失败')
  } finally {
    sessionsLoading.value = false
  }
}

/** 将后端消息记录转换为 t-chatbot 的 ChatMessagesData 格式 */
function convertToChat(messages: AgentMessage[]): ChatMessagesData[] {
  return messages.map((m, i) => {
    if (m.role === 'user') {
      return {
        id: String(m.id || i),
        role: 'user' as const,
        content: [{ type: 'text' as const, status: 'complete' as const, data: m.content }],
      }
    }
    return {
      id: String(m.id || i),
      role: 'assistant' as const,
      content: buildAssistantMessageContent(m.content, m.metadata),
    }
  })
}

/** 切换到指定会话（force=true 时即使同 ID 也重新拉取消息） */
async function switchSession(session: AgentSession, force = false) {
  if (!ensureAuthenticated('请先登录后再切换会话')) return
  if (!force && currentSessionId.value === session.id) return

  try {
    // 加载会话消息
    const msgs = await getAgentSessionMessages(session.id)
    const chatMsgs = msgs.length > 0 ? convertToChat(msgs) : welcomeMessages

    // 先更新消息数据，再切换 key 强制重建组件
    currentSessionId.value = session.id
    threadId.value = session.threadId
    applyChatbotMessages(chatMsgs)
    trackedMessages.value = chatMsgs
    sessionKey.value++
    // 重置沙箱面板状态
    resetSandboxPanel()
    // 从历史消息中还原终端日志和产出文件
    restoreMetadataFromMessages(msgs)
  } catch (error) {
    if (getErrorStatus(error) === 401) {
      handleAuthRequired('登录已失效，请重新登录')
      return
    }
    MessagePlugin.error('加载会话消息失败')
  }
}

/** 创建新会话 */
async function createNewSession() {
  if (!ensureAuthenticated('请先登录后再新建会话')) return

  try {
    const session = await createAgentSession('新会话')
    sessions.value.unshift(session)
    currentSessionId.value = session.id
    threadId.value = session.threadId
    applyChatbotMessages(welcomeMessages)
    trackedMessages.value = welcomeMessages
    sessionKey.value++
    // 重置沙箱面板状态
    resetSandboxPanel()
  } catch (error) {
    if (getErrorStatus(error) === 401) {
      handleAuthRequired('登录已失效，请重新登录')
      return
    }
    MessagePlugin.error('创建会话失败')
  }
}

/** 删除会话 */
async function removeSession(session: AgentSession) {
  if (!ensureAuthenticated('请先登录后再删除会话')) return

  try {
    await deleteAgentSession(session.id)
    sessions.value = sessions.value.filter((s) => s.id !== session.id)
    if (currentSessionId.value === session.id) {
      // 如果删除的是当前会话，切换到最近一条或创建新的
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0]!)
      } else {
        await createNewSession()
      }
    }
  } catch (error) {
    if (getErrorStatus(error) === 401) {
      handleAuthRequired('登录已失效，请重新登录')
      return
    }
    MessagePlugin.error('删除会话失败')
  }
}

/** 登录成功后初始化会话数据 */
async function initializeSessions() {
  if (!authStore.isAuthenticated()) {
    sessions.value = []
    currentSessionId.value = null
    return
  }

  await loadSessions()
  if (sessions.value.length === 0) {
    await createNewSession()
    return
  }

  if (currentSessionId.value) {
    const found = sessions.value.find((s) => s.id === currentSessionId.value)
    if (found) {
      // 初始化阶段即使命中同一个会话 ID，也要强制回拉历史消息。
      await switchSession(found, true)
      return
    }
    currentSessionId.value = null
  }

  await switchSession(sessions.value[0]!)
}

/** 退出登录：清理本地状态并回到欢迎消息 */
function handleLogout() {
  authStore.logout()
  sessions.value = []
  currentSessionId.value = null
  applyChatbotMessages(welcomeMessages)
  trackedMessages.value = welcomeMessages
  sessionKey.value++
  resetSandboxPanel()
  MessagePlugin.success('已退出登录')
}

/** 重置沙箱面板状态 */
function resetSandboxPanel() {
  panelActions.reset()
  codeExecOutputLines.value = []
  browserInlineNotified.value = false
  currentAgent.value = ''
  activeRunId.value = ''
  hideAllGenerationPlaceholders()
}

function openLivePanelFromArtifacts() {
  const hasRenderableContent = Boolean(
    browserFrame.value
    || previewFile.value
    || terminalLines.value.length > 0,
  )

  livePanel.value = true

  if (!hasRenderableContent && sessionArtifacts.value.length > 0) {
    artifactsDialogVisible.value = true
  }
}

watch(currentSessionId, () => {
  persistRuntime()
})

// ── 欢迎消息 ─────────────────────────────────────────────────
const welcomeMessages: ChatMessagesData[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: [
      {
        type: 'text',
        status: 'complete',
        data: '你好！我是 **Kit**，支持代码生成、图像生成和网页搜索抓取。试试下面的功能吧 ',
      },
    ],
  },
]

/** 加载的历史消息（用于切换会话时回显） */
const chatbotMessages = ref<ChatMessagesData[]>(welcomeMessages)
const trackedMessages = ref<ChatMessagesData[]>(welcomeMessages)

const slotMessages = computed(() => mergePlaceholderIntoMessages(trackedMessages.value))

function handleMessageChange(e: CustomEvent<ChatMessagesData[]>) {
  trackedMessages.value = stripGenerationPlaceholderContent(e.detail)
}

/** Agent 节点名到中文标签的映射 */
/** 转义 HTML 特殊字符，防止注入 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** ====== Agent Notify 胶囊样式 ====== */
const NOTIFY_WRAP_STYLE = 'display:flex;justify-content:flex-start;margin:10px 0 10px 0px;'
const NOTIFY_PILL_STYLE = 'display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:linear-gradient(180deg,#f5f6f8 0%,#eceff3 100%);border:1px solid #e3e6eb;box-shadow:0 1px 2px rgba(15,23,42,0.04);max-width:min(92%,560px);'
const NOTIFY_ICON_WRAP_STYLE = 'width:20px;height:20px;border-radius:50%;background:#ffffff;border:1px solid #d8dde6;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#6b7280;font-size:11px;line-height:1;'
const NOTIFY_TEXT_STYLE = 'font-size:13px;line-height:1.4;color:#344054;font-weight:500;white-space:normal;word-break:break-word;'
const NOTIFY_ERROR_PILL_STYLE = 'display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:linear-gradient(180deg,#fff3f2 0%,#ffe7e5 100%);border:1px solid #f1c0bb;box-shadow:0 1px 2px rgba(232,67,62,0.06);max-width:min(92%,560px);'
const NOTIFY_ERROR_ICON_WRAP_STYLE = 'width:20px;height:20px;border-radius:50%;background:#ffffff;border:1px solid #f1c0bb;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#d14343;font-size:11px;line-height:1;'
const NOTIFY_ERROR_TEXT_STYLE = 'font-size:13px;line-height:1.4;color:#b42318;font-weight:500;white-space:normal;word-break:break-word;'

/** 构建 agent_notify 胶囊 HTML */
function buildNotifyPill(text: string, isError = false): string {
  const pillStyle = isError ? NOTIFY_ERROR_PILL_STYLE : NOTIFY_PILL_STYLE
  const iconStyle = isError ? NOTIFY_ERROR_ICON_WRAP_STYLE : NOTIFY_ICON_WRAP_STYLE
  const textStyle = isError ? NOTIFY_ERROR_TEXT_STYLE : NOTIFY_TEXT_STYLE
  const icon = isError ? '!' : '↗'

  return `\n<div style="${NOTIFY_WRAP_STYLE}"><div style="${pillStyle}"><span style="${iconStyle}">${icon}</span><span style="${textStyle}">${escapeHtml(text)}</span></div></div>\n`
}

// ── 聊天服务配置（SSE 端点） ──────────────────────────────────
const chatServiceConfig = computed<ChatServiceConfig>(() => ({
  endpoint: `${AGENT_URL}/api/chat/sse`,
  stream: true,
  onRequest: (params: ChatRequestParams) => {
    if (!authStore.isAuthenticated()) {
      const unauthorizedError = new Error('请先登录后再发送消息') as AgentApiError
      unauthorizedError.status = 401
      throw unauthorizedError
    }

    // 标记新一轮提问已发出，但不立刻切换面板
    // 等终端/浏览器事件实际到达时再切换，避免用户看到闪烁
    newRoundPending.value = true
    hideAllGenerationPlaceholders()
    // 开始思考 loading
    thinkingActive.value = true
    thinkingText.value = '正在思考…'

    const currentAttachments = [...pendingAttachments.value]
    let prompt = (params.prompt || '') + buildAttachmentPromptSuffix(currentAttachments)
    const runId = createThreadId()
    activeRunId.value = runId

    // 如果用户之前编辑过文件，自动附加文件上下文
    if (lastEditedFile.value) {
      const { url, fileName } = lastEditedFile.value
      prompt += `\n\n[用户在右侧面板编辑过的文件]\n- 文件名：${fileName}\n  URL: ${url}\n（用户可能需要你基于此文件做进一步处理，请先用 process_file 或 fetch_webpage 读取最新内容）`
      lastEditedFile.value = null
    }

    // 构造请求体，包含当前会话的运行参数
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: prompt }],
      threadId: threadId.value,
      runId,
    }
    clearAllAttachments()

    // 携带 JWT Token，确保后端能识别用户并保存消息
    const token = localStorage.getItem('token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    return {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  },
  onMessage: (chunk: SSEChunkData): AIMessageContent | null => {
    // 解析 SSE 事件，转换为 TDesign Chat 消息内容或更新实时面板
    const data = chunk.data as Record<string, unknown>
    if (!data || !data.type) return null
    const eventRunId = typeof data.runId === 'string' ? data.runId : ''
    if (eventRunId && eventRunId !== activeRunId.value) return null

    switch (data.type) {
      case 'ping':
        return null

      // ── 文本流 ──
      case 'text':
        // 文本流式输出时不关闭 loading——agent 可能还有后续工具调用
        return { type: 'markdown', data: (data.msg as string) || '' }

      // ── 文本回撤（Supervisor 先输出文本后又路由，极少触发） ──
      case 'text_clear':
        return null

      // ── Agent 调度：前端不展示任务分组，只更新状态 ──
      case 'task_start':
      case 'task_end':
        return null

      // ── Agent 调度 ──
      case 'agent_start': {
        const agentId = data.agent as string
        currentAgent.value = agentId
        // 更新 thinking 文案
        thinkingText.value = AGENT_LABELS[agentId] || '正在思考…'
        return null
      }
      case 'agent_end':
        return null

      // ── Agent 动态通知（由 LLM 通过 message_notify_user 工具生成） ──
      case 'agent_notify': {
        const message = (data.message as string) || ''
        if (!message.trim()) return null
        return { type: 'markdown', data: buildNotifyPill(message) }
      }

      // ── 工具调用：前端不展示，仅保留 agent_notify ──
      case 'tool_start':
        if (data.tool === 'generate_image' || data.tool === 'edit_image') {
          showImageGenerationPlaceholder(data.input as Record<string, unknown> | undefined)
        }
        if (data.tool === 'generate_video') {
          showVideoGenerationPlaceholder(data.input as Record<string, unknown> | undefined)
        }
        return null
      case 'tool_end':
        if (data.tool === 'generate_image' || data.tool === 'edit_image') {
          hideImageGenerationPlaceholder()
        }
        if (data.tool === 'generate_video') {
          hideVideoGenerationPlaceholder()
        }
        return null // 工具结束静默

      case 'video_status':
        updateVideoGenerationPlaceholder(data as Record<string, unknown>)
        return null

      case 'video': {
        const videos = Array.isArray(data.videos)
          ? data.videos.filter((url): url is string => typeof url === 'string' && !!url.trim())
          : []
        if (videos.length === 0) return null
        hideVideoGenerationPlaceholder()
        return {
          type: 'videoview',
          status: 'complete',
          data: videos.map((url, index) => ({
            url,
            title: `生成视频 ${index + 1}`,
          })),
        } as unknown as AIMessageContent
      }

      // ── 沙箱：浏览器实时帧 → 更新右侧面板 ──
      case 'browser_frame':
        browserFrame.value = (data.image as string) || ''
        browserUrl.value = (data.url as string) || browserUrl.value
        livePanel.value = true
        switchTabSafe('browser')
        sandboxStatus.value = 'busy'
        return null

      // ── 沙箱：浏览器导航 ──
      case 'browser_navigate':
        browserUrl.value = (data.url as string) || ''
        browserTitle.value = (data.title as string) || ''
        return null

      // ── 沙箱：代码执行输出 → 更新终端面板 + 累积内联输出 ──
      case 'code_output': {
        const text = (data.data as string) || ''
        const stream = (data.stream as 'stdout' | 'stderr') || 'stdout'
        codeExecOutputLines.value.push(text)
        appendTerminalLine(text, stream)
        livePanel.value = true
        switchTabSafe('terminal')
        sandboxStatus.value = 'busy'
        return null
      }

      // ── 沙箱：代码执行最终结果（含内联输出展示） ──
      case 'code_result': {
        const exitCode = Number(data.exitCode ?? -1)
        const duration = Number(data.duration ?? 0)
        const icon = exitCode === 0 ? '✅' : '❌'
        const output = codeExecOutputLines.value.join('')
        const trimmedOutput = output.trim()
        const truncated = trimmedOutput.length > 2000
          ? `${trimmedOutput.slice(0, 2000)}\n...(输出已截断)`
          : trimmedOutput
        let md = ''
        if (truncated) {
          md += `\n\`\`\`\n${truncated}\n\`\`\`\n`
        }
        md += `\n> ${icon} 代码执行完成 (exitCode: ${exitCode}, 耗时: ${duration}ms)\n\n`
        codeExecOutputLines.value = []
        return { type: 'markdown', data: md }
      }

      // ── 沙箱状态 ──
      case 'sandbox_status': {
        sandboxStatus.value = (data.state as 'idle' | 'busy') || 'idle'
        sandboxOperation.value = (data.operation as string) || ''
        if (sandboxOperation.value.startsWith('file:')) {
          if (livePanelTab.value !== 'preview') {
            livePanel.value = true
          }
        }
        return null
      }

      case 'sandbox_start':
        sandboxStatus.value = 'busy'
        return null

      case 'sandbox_end':
        sandboxStatus.value = 'offline'
        return null

      // ── 文件预览：上传完成后触发右侧面板预览 ──
      case 'file_preview': {
        const url = (data.url as string) || ''
        const fileName = (data.fileName as string) || ''
        const fileType = (data.fileType as 'office' | 'pdf' | 'image' | 'markdown' | 'text' | 'html' | 'mindmap') || 'office'
        if (url) {
          // 清除浏览器画面，确保文件预览能正常显示
          browserFrame.value = ''
          previewFile.value = { url, fileName, fileType }
          previewLoading.value = true
          previewPinned.value = false
          livePanel.value = true
          livePanelTab.value = 'preview'
          // 同时记录到产出文件列表
          addArtifact(url, fileName, fileType)
          // 文本/HTML/思维导图：fetch 内容后直接渲染
          if (['markdown', 'text', 'html', 'mindmap'].includes(fileType)) {
            previewTextContent.value = ''
            fetch(url).then(r => r.text()).then(text => {
              previewTextContent.value = text
              previewLoading.value = false
            }).catch(() => {
              previewTextContent.value = '加载失败'
              previewLoading.value = false
            })
          }
        }
        return null
      }

      // ── 结束 ──
      case 'done':
        hideAllGenerationPlaceholders()
        sandboxStatus.value = sandboxStatus.value === 'busy' ? 'idle' : sandboxStatus.value
        currentAgent.value = ''
        activeRunId.value = ''
        // 关闭 thinking loading
        thinkingActive.value = false
        thinkingText.value = ''
        return null

      // ── 错误 ──
      case 'error':
        hideAllGenerationPlaceholders()
        // 发生错误也关闭 thinking loading
        activeRunId.value = ''
        thinkingActive.value = false
        thinkingText.value = ''
        return { type: 'markdown', data: buildNotifyPill((data.msg as string) || '发生未知错误', true) }

      default:
        return null
    }
  },
  onComplete: (isAborted: boolean) => {
    // 任何结束（正常/中断）都关闭 thinking loading
    thinkingActive.value = false
    thinkingText.value = ''
    if (isAborted) MessagePlugin.info('已停止生成')
  },
  onError: async (err: Error | Response) => {
    // 请求错误关闭 thinking loading
    thinkingActive.value = false
    thinkingText.value = ''
    if (err instanceof Response) {
      if (err.status === 401) {
        handleAuthRequired('登录已失效，请重新登录')
        return
      }
      const message = await readResponseErrorMessage(err)
      MessagePlugin.error(message)
    } else {
      if (getErrorStatus(err) === 401) {
        handleAuthRequired('请先登录后再发送消息')
        return
      }
      MessagePlugin.error(`发生错误: ${err.message}`)
    }
  },
}))

// ── 消息样式配置 ──────────────────────────────────────────────
const messageProps = (msg: ChatMessagesData): TdChatMessageConfigItem => {
  const { role } = msg
  if (role === 'user') {
    return {
      variant: 'base',
      placement: 'right',
      // avatar: 'https://tdesign.gtimg.com/site/avatar.jpg',
      // name: '我',
    }
  }
  if (role === 'assistant') {
    return {
      variant: 'text',
      placement: 'left',
      avatar: kitLogo,
      name: 'Kit',
      // 开启 Cherry Markdown HTML 白名单，让步骤胶囊的 div/span 能正常渲染
      chatContentProps: {
        markdown: {
          options: {
            engine: {
              global: {
                htmlWhiteList: 'div|span',
              },
            },
          },
        } as Record<string, unknown>,
      },
      actions: ['copy', 'replay', 'good', 'bad'],
      handleActions: {
        copy: () => MessagePlugin.success('已复制到剪贴板'),
        good: ({ active }: { active: boolean }) => MessagePlugin.success(active ? '已点赞' : '取消点赞'),
        bad: ({ active }: { active: boolean }) => MessagePlugin.success(active ? '已点踩' : '取消点踩'),
        replay: () => chatRef.value?.regenerate(),
        suggestion: ({ content }: { content: SuggestionItem }) => chatRef.value?.addPrompt(content.prompt || ''),
      },
    }
  }
  return {}
}

// ── 输入框配置 ────────────────────────────────────────────────
const senderProps = computed(() => ({
  placeholder: authStore.isAuthenticated()
    ? '输入消息… Enter 发送，Shift+Enter 换行'
    : '请先登录后再发送消息',
  attachmentsProps: {
    items: pendingAttachments.value,
    overflow: 'scrollX',
  },
  // 显示附件上传和发送按钮（默认只显示发送按钮）
  actions: (presets: any[]) => presets,
  onFileSelect: handleSenderFileSelect,
  onRemove: handleSenderRemove,
  onFileClick: handleSenderFileClick,
}))

// ── 清空对话（创建新会话） ────────────────────────────────────
function clearChat() {
  if (!ensureAuthenticated('请先登录后再清空对话')) return
  createNewSession()
}

/** 处理全局鉴权失效事件（axios 拦截器触发） */
function handleGlobalAuthRequired() {
  handleAuthRequired('登录状态已失效，请重新登录')
}

onMounted(async () => {
  loadPersistedRuntime()
  // 仅在已登录时初始化会话，避免未登录用户看到静默失败
  await initializeSessions()
  // 等待 chatbot 渲染后获取 sender 高度
  nextTick(() => setTimeout(observeSenderHeight, 300))
  // 注册全局粘贴监听，支持 Ctrl+V 上传文件/图片
  document.addEventListener('paste', handlePaste)
  // 监听全局鉴权失效事件，统一弹出登录框
  window.addEventListener(AUTH_REQUIRED_EVENT, handleGlobalAuthRequired)
})

onUnmounted(() => {
  document.removeEventListener('paste', handlePaste)
  window.removeEventListener(AUTH_REQUIRED_EVENT, handleGlobalAuthRequired)
})
</script>

<template>
  <div ref="agentRootRef" class="agent-root" :class="[themeClass, { 'is-resizing': isDragging }]">

    <!-- ═══ 左侧会话侧边栏 ═══ -->
    <aside class="session-sidebar" :class="{ 'session-sidebar--collapsed': sidebarCollapsed }">
      <!-- 折叠/展开按钮 -->
      <button
        type="button"
        class="sidebar-toggle"
        :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
        @click="sidebarCollapsed = !sidebarCollapsed"
      >
        <svg v-if="!sidebarCollapsed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </button>

      <template v-if="!sidebarCollapsed">
        <!-- 新建对话 -->
        <button type="button" class="sidebar-new-btn" @click="createNewSession">
          <AppIcon :icon="Plus" :size="14" :stroke-width="2" />
          <span>新建对话</span>
        </button>

        <!-- 会话列表 -->
        <div class="session-list">
          <div
            v-for="session in sessions"
            :key="session.id"
            class="session-item"
            :class="{ 'session-item--active': session.id === currentSessionId }"
            @click="switchSession(session)"
          >
            <div class="session-item__title">{{ session.title || '新会话' }}</div>
            <div class="session-item__meta">{{ formatDate(session.updatedAt) }}</div>
            <button
              type="button"
              class="session-item__delete"
              title="删除会话"
              @click.stop="removeSession(session)"
            >
              <AppIcon :icon="CloseOne" :size="12" :stroke-width="2" />
            </button>
          </div>
          <div v-if="sessions.length === 0 && !sessionsLoading" class="session-empty">暂无历史会话</div>
        </div>

        <!-- 登录信息区（固定在左下角） -->
        <div class="session-sidebar-bottom">
          <template v-if="isAuthenticated">
            <div class="session-user">
              <span class="session-user__avatar">{{ (authStore.username || 'U').charAt(0).toUpperCase() }}</span>
              <span class="session-user__name">{{ authStore.username || '用户' }}</span>
            </div>
            <button type="button" class="session-logout-btn" @click="handleLogout">退出登录</button>
          </template>
          <template v-else>
            <p class="session-login-tip">未登录，登录后可保存会话记录</p>
            <button type="button" class="session-login-btn" @click="openLogin">去登录</button>
          </template>
        </div>
      </template>
    </aside>

    <!-- ═══ 主聊天区（TDesign Chat） ═══ -->
    <div class="chat-area">
      <!-- 顶栏 -->
      <header class="chat-header">
        <div class="header-left">
          <span class="header-title">
            <!-- <img src="@/assets/kit.png" alt="Kit" class="kit-logo" /> -->
            Kit
          </span>
        </div>
        <div class="header-right">
          <button class="clear-btn" @click="clearChat" title="清空对话">
            <AppIcon :icon="RefreshOne" :size="14" :stroke-width="2" />
            清空对话
          </button>
        </div>
      </header>

      <!-- 未登录提醒 -->
      <div v-if="!isAuthenticated" class="auth-reminder">
        <span>当前未登录，暂不可发起新对话或保存会话。</span>
        <button type="button" class="auth-reminder__btn" @click="openLogin">立即登录</button>
      </div>

      <!-- TDesign Chatbot 主体 -->
      <div
        ref="chatBodyRef"
        class="chat-body p-2"
        :class="themeClass === 'dark' ? 'bg-slate-900 text-slate-100' : 'bg-[#F8F8F7] text-slate-900'"
      >
      <!-- 产出文件条 + Agent 工作状态（绝对定位在 sender 上方） -->
        <div v-if="sessionArtifacts.length > 0 || thinkingActive" class="artifacts-strip mb-1" :style="{ bottom: (senderBottomDistance + 8) + 'px' }">
          <!-- 查看 Kit 的电脑 按钮 -->
          <button v-if="sessionArtifacts.length > 0" class="artifacts-computer-btn" @click="openLivePanelFromArtifacts">
            查看 Kit 的电脑
          </button>
          <!-- Agent 工作状态指示 -->
          <transition name="thinking-fade">
            <span v-if="thinkingActive" class="artifacts-status">
              <span class="header-status__dot"></span>
              <span class="header-status__text">{{ thinkingText }}</span>
            </span>
          </transition>
        </div>
        <t-chatbot :key="sessionKey" ref="chatRef" :default-messages="chatbotMessages" :message-props="messageProps"
          :sender-props="senderProps" :chat-service-config="chatServiceConfig" @message-change="handleMessageChange">
          <template v-for="msg in slotMessages" :key="msg.id">
            <template v-for="(item, index) in msg.content" :key="index">
              <div v-if="(item as any).type === 'imageview'" :slot="`${msg.id}-${(item as any).type}-${index}`">
                <template v-if="(item as any).data?.[0]?.placeholder">
                  <div class="image-generation-placeholder">
                    <div class="image-generation-placeholder__label">
                      {{ (item as any).data?.[0]?.prompt ? `正在绘制：${(item as any).data[0].prompt}` : '正在绘制图片' }}
                    </div>
                    <div class="image-generation-placeholder__card">
                      <div class="image-generation-placeholder__title">正在生成图片</div>
                      <div class="image-generation-placeholder__canvas">
                        <div class="image-generation-placeholder__glow" />
                        <div class="image-generation-placeholder__grid">
                          <span v-for="n in 36" :key="n" class="image-generation-placeholder__dot" />
                        </div>
                      </div>
                    </div>
                  </div>
                </template>

                <Space v-else-if="(item as any).data?.length" break-line :size="16" style="margin: 8px 0">
                  <div
                    v-for="(img, imgIndex) in listMediaWithUrl((item as any).data)"
                    :key="imgIndex"
                    class="chat-image-card"
                  >
                    <ImageViewer
                      :images="listMediaUrls((item as any).data)"
                      :default-index="Number(imgIndex)"
                    >
                      <template #trigger="{ open }">
                        <div class="chat-image-preview" @click="open">
                          <img :src="img.url" :alt="img.alt || `生成图片 ${Number(imgIndex) + 1}`" class="chat-image-preview__img" />
                          <div class="chat-image-preview__hover">
                            <AppIcon :icon="PreviewOpen" :size="18" :stroke-width="1.8" color="white" />
                            <span>预览</span>
                          </div>
                        </div>
                      </template>
                    </ImageViewer>
                  </div>
                </Space>
              </div>

              <div v-else-if="(item as any).type === 'videoview'" :slot="`${msg.id}-${(item as any).type}-${index}`">
                <template v-if="(item as any).data?.[0]?.placeholder">
                  <div class="video-generation-placeholder">
                    <div class="video-generation-placeholder__label">
                      {{ (item as any).data?.[0]?.prompt ? `正在生成：${(item as any).data[0].prompt}` : '正在生成视频' }}
                    </div>
                    <div class="video-generation-placeholder__card">
                      <div class="video-generation-placeholder__header">
                        <div class="video-generation-placeholder__title">正在生成视频</div>
                        <div class="video-generation-placeholder__status">
                          {{ (item as any).data?.[0]?.status || '处理中' }}
                        </div>
                      </div>
                      <div class="video-generation-placeholder__meta">
                        <span v-if="(item as any).data?.[0]?.seconds">时长 {{ (item as any).data[0].seconds }} 秒</span>
                        <span v-if="(item as any).data?.[0]?.size">尺寸 {{ (item as any).data[0].size }}</span>
                        <span v-if="(item as any).data?.[0]?.taskId">任务 {{ String((item as any).data[0].taskId).slice(0, 16) }}</span>
                      </div>
                      <div class="video-generation-placeholder__preview">
                        <div class="video-generation-placeholder__screen" />
                        <div class="video-generation-placeholder__progress-track">
                          <div
                            class="video-generation-placeholder__progress-bar"
                            :style="{ width: `${Math.max(8, Number((item as any).data?.[0]?.progress ?? 12))}%` }"
                          />
                        </div>
                        <div class="video-generation-placeholder__progress-text">
                          {{ typeof (item as any).data?.[0]?.progress === 'number' ? `${(item as any).data[0].progress}%` : '等待进度回传' }}
                        </div>
                      </div>
                    </div>
                  </div>
                </template>

                <Space v-else-if="(item as any).data?.length" break-line :size="16" style="margin: 8px 0">
                  <div
                    v-for="(video, videoIndex) in listMediaWithUrl((item as any).data)"
                    :key="videoIndex"
                    class="chat-video-card"
                  >
                    <video
                      class="chat-video-card__player"
                      :src="video.url"
                      controls
                      playsinline
                      preload="metadata"
                    />
                    <div class="chat-video-card__actions">
                      <button
                        type="button"
                        class="chat-video-card__preview-btn"
                        @click="openArtifact({
                          url: video.url,
                          fileName: `${video.title || `视频 ${Number(videoIndex) + 1}`}.mp4`,
                          fileType: 'video',
                          timestamp: Date.now(),
                        })"
                      >
                        预览视频
                      </button>
                      <a class="chat-video-card__link" :href="video.url" target="_blank" rel="noreferrer">
                        {{ video.title || `查看视频 ${Number(videoIndex) + 1}` }}
                      </a>
                    </div>
                  </div>
                </Space>
              </div>
            </template>
          </template>
        </t-chatbot>

      </div>
    </div>

    <!-- ═══ 拖拽手柄 ═══ -->
    <div v-if="livePanel" class="resize-handle" :class="{ dragging: isDragging }" @mousedown="onResizeStart" />

    <!-- ═══ 右侧实时操作面板 ═══ -->
    <transition name="panel-slide-right">
      <div v-if="livePanel" class="live-panel-wrapper" :style="{ width: panelWidthPct + '%' }">
        <LivePanel
          :state="panelState"
          :actions="panelActions"
          :agent-url="AGENT_URL"
          :thread-id="threadId"
          @close="livePanel = false"
        />
      </div>
    </transition>

    <!-- 登录弹窗 -->
    <LoginView v-if="showLogin" @close="closeLogin" />
  </div>
</template>

<style scoped>
/* ─────────────── 布局根 ─────────────── */
.agent-root {
  display: flex;
  height: 100%;
  overflow: hidden;
  border-radius: var(--tech-radius-xl);
  background: var(--surface-bg);
}

.agent-root.is-resizing {
  user-select: none;
  cursor: col-resize;
}

/* ─────────────── 左侧会话侧边栏 ───── */
.session-sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-card);
  border-right: 1px solid var(--surface-border);
  overflow: hidden;
  position: relative;
  transition: width 0.25s ease;
  padding-top: 40px;
}

.session-sidebar--collapsed {
  width: 32px;
  padding-top: 0;
}

/* 折叠切换按钮 */
.sidebar-toggle {
  position: absolute;
  top: 10px;
  right: 8px;
  z-index: 5;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-muted, #9aa5be);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s;
  flex-shrink: 0;
}

.sidebar-toggle:hover {
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 8%, transparent);
  color: var(--td-brand-color, #0052d9);
}

/* 新建对话按钮 */
.sidebar-new-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 8px 8px 8px;
  padding: 7px 12px;
  border: 1px dashed var(--surface-border);
  border-radius: 10px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  width: calc(100% - 16px);
  box-sizing: border-box;
  flex-shrink: 0;
}

.sidebar-new-btn:hover {
  border-color: var(--td-brand-color, #0052d9);
  color: var(--td-brand-color, #0052d9);
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 5%, transparent);
}

.chat-image-preview {
  position: relative;
  width: 240px;
  height: 240px;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--surface-border, rgb(226 232 240 / 90%));
  background: color-mix(in srgb, var(--surface-card, #fff) 90%, #eef2ff 10%);
  cursor: zoom-in;
}

.chat-image-preview__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.chat-image-preview__hover {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgb(15 23 42 / 45%);
  color: white;
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.chat-image-preview:hover .chat-image-preview__hover {
  opacity: 1;
}

.chat-image-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.image-generation-placeholder {
  margin: 8px 0 4px;
  width: min(440px, 100%);
}

.image-generation-placeholder__label {
  margin-bottom: 10px;
  color: var(--text-secondary, #94a3b8);
  font-size: 13px;
}

.image-generation-placeholder__card {
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--td-brand-color, #0052d9) 18%, transparent);
  background: linear-gradient(180deg, rgb(255 255 255 / 92%), rgb(245 247 250 / 94%));
  padding: 16px;
  box-shadow: 0 12px 28px rgb(15 23 42 / 10%);
}

.dark .image-generation-placeholder__card {
  background: linear-gradient(180deg, rgb(30 41 59 / 92%), rgb(15 23 42 / 94%));
  border-color: rgb(96 165 250 / 28%);
  box-shadow: 0 16px 32px rgb(2 6 23 / 35%);
}

.image-generation-placeholder__title {
  color: var(--text-primary, #0f172a);
  font-size: 14px;
  font-weight: 600;
}

.dark .image-generation-placeholder__title {
  color: rgb(226 232 240 / 95%);
}

.image-generation-placeholder__canvas {
  position: relative;
  margin-top: 12px;
  min-height: 240px;
  overflow: hidden;
  border-radius: 22px;
  background: linear-gradient(180deg, rgb(255 255 255 / 96%), rgb(241 245 249 / 92%));
}

.dark .image-generation-placeholder__canvas {
  background: linear-gradient(180deg, rgb(51 65 85 / 78%), rgb(30 41 59 / 92%));
}

.image-generation-placeholder__glow {
  position: absolute;
  inset: -20% auto auto -10%;
  width: 65%;
  height: 55%;
  background: radial-gradient(circle, rgb(59 130 246 / 14%), transparent 68%);
  animation: image-placeholder-glow 2.4s ease-in-out infinite;
}

.image-generation-placeholder__grid {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 18px;
  place-items: center;
  padding: 34px;
}

.image-generation-placeholder__dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: rgb(148 163 184 / 58%);
  animation: image-placeholder-pulse 1.6s ease-in-out infinite;
}

.image-generation-placeholder__dot:nth-child(3n) {
  animation-delay: 0.2s;
}

.image-generation-placeholder__dot:nth-child(4n) {
  animation-delay: 0.4s;
}

@keyframes image-placeholder-pulse {
  0%,
  100% {
    transform: scale(0.75);
    opacity: 0.35;
  }

  50% {
    transform: scale(1.1);
    opacity: 0.9;
  }
}

@keyframes image-placeholder-glow {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
    opacity: 0.4;
  }

  50% {
    transform: translate3d(16px, 10px, 0);
    opacity: 0.85;
  }
}

.chat-video-card {
  width: min(360px, 78vw);
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--surface-border) 72%, transparent);
  background: color-mix(in srgb, var(--surface-card, #fff) 92%, transparent);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
}

.dark .chat-video-card {
  background: color-mix(in srgb, #121826 92%, transparent);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}

.chat-video-card__player {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
}

.video-generation-placeholder {
  margin: 8px 0 4px;
  width: min(440px, 100%);
}

.video-generation-placeholder__label {
  margin-bottom: 10px;
  color: var(--text-secondary, #94a3b8);
  font-size: 13px;
}

.video-generation-placeholder__card {
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--td-warning-color, #ed7b2f) 24%, transparent);
  background: linear-gradient(180deg, rgb(255 248 240 / 96%), rgb(255 242 229 / 94%));
  padding: 16px;
  box-shadow: 0 12px 28px rgb(120 53 15 / 10%);
}

.dark .video-generation-placeholder__card {
  background: linear-gradient(180deg, rgb(67 20 7 / 72%), rgb(41 37 36 / 94%));
  border-color: rgb(251 191 36 / 32%);
  box-shadow: 0 16px 32px rgb(28 25 23 / 35%);
}

.video-generation-placeholder__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.video-generation-placeholder__title {
  color: var(--text-primary, #7c2d12);
  font-size: 14px;
  font-weight: 600;
}

.dark .video-generation-placeholder__title {
  color: rgb(255 237 213 / 96%);
}

.video-generation-placeholder__status {
  padding: 4px 10px;
  border-radius: 999px;
  background: rgb(255 255 255 / 72%);
  color: #9a3412;
  font-size: 12px;
}

.dark .video-generation-placeholder__status {
  background: rgb(120 53 15 / 46%);
  color: rgb(254 215 170 / 95%);
}

.video-generation-placeholder__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  color: #9a3412;
  font-size: 12px;
}

.dark .video-generation-placeholder__meta {
  color: rgb(253 186 116 / 92%);
}

.video-generation-placeholder__preview {
  margin-top: 14px;
}

.video-generation-placeholder__screen {
  position: relative;
  min-height: 190px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgb(249 115 22 / 22%), transparent 55%),
    linear-gradient(180deg, rgb(255 255 255 / 92%), rgb(255 237 213 / 90%));
  overflow: hidden;
}

.dark .video-generation-placeholder__screen {
  background:
    linear-gradient(135deg, rgb(251 146 60 / 16%), transparent 55%),
    linear-gradient(180deg, rgb(68 64 60 / 84%), rgb(28 25 23 / 94%));
}

.video-generation-placeholder__screen::before,
.video-generation-placeholder__screen::after {
  content: '';
  position: absolute;
  inset: 18px;
  border-radius: 14px;
}

.video-generation-placeholder__screen::before {
  border: 1px solid rgb(251 146 60 / 34%);
}

.video-generation-placeholder__screen::after {
  inset: auto 24px 28px 24px;
  height: 54px;
  background: linear-gradient(90deg, rgb(251 146 60 / 12%), rgb(249 115 22 / 28%), rgb(251 146 60 / 12%));
  filter: blur(12px);
  animation: video-placeholder-scan 2.2s ease-in-out infinite;
}

.video-generation-placeholder__progress-track {
  margin-top: 14px;
  height: 8px;
  border-radius: 999px;
  background: rgb(154 52 18 / 10%);
  overflow: hidden;
}

.dark .video-generation-placeholder__progress-track {
  background: rgb(251 146 60 / 16%);
}

.video-generation-placeholder__progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #fb923c, #f97316);
  transition: width 0.3s ease;
}

.video-generation-placeholder__progress-text {
  margin-top: 8px;
  color: #9a3412;
  font-size: 12px;
}

.dark .video-generation-placeholder__progress-text {
  color: rgb(253 186 116 / 92%);
}

@keyframes video-placeholder-scan {
  0%,
  100% {
    transform: translate3d(-10px, 0, 0);
    opacity: 0.4;
  }

  50% {
    transform: translate3d(14px, 0, 0);
    opacity: 0.9;
  }
}

.chat-video-card__link {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  color: var(--td-brand-color, #0052d9);
  text-decoration: none;
}

.chat-video-card__link:hover {
  text-decoration: underline;
}

.chat-video-card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
}

.chat-video-card__preview-btn {
  border: 1px solid color-mix(in srgb, var(--td-brand-color, #0052d9) 24%, transparent);
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 8%, transparent);
  color: var(--td-brand-color, #0052d9);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.chat-video-card__preview-btn:hover {
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 14%, transparent);
}

/* 会话列表 */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.session-list::-webkit-scrollbar {
  width: 4px;
}

.session-list::-webkit-scrollbar-thumb {
  background: var(--surface-border);
  border-radius: 4px;
}

.session-item {
  position: relative;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 2px;
}

.session-item:hover {
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 5%, transparent);
}

.session-item--active {
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 10%, transparent);
}

.session-item__title {
  font-size: 12.5px;
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 20px;
  line-height: 1.4;
}

.session-item--active .session-item__title {
  color: var(--td-brand-color, #0052d9);
}

.session-item__meta {
  font-size: 11px;
  color: var(--text-muted, #9aa5be);
  margin-top: 2px;
}

.session-item__delete {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-muted, #9aa5be);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}

.session-item:hover .session-item__delete {
  opacity: 1;
}

.session-item__delete:hover {
  background: rgba(255, 80, 80, 0.1);
  color: #e53e3e;
}

.session-empty {
  text-align: center;
  color: var(--text-muted, #9aa5be);
  font-size: 12px;
  padding: 24px 0;
}

.session-sidebar-bottom {
  border-top: 1px solid var(--surface-border);
  padding: 10px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.session-user {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-user__avatar {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--td-brand-color, #0052d9);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.session-user__name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-logout-btn,
.session-login-btn {
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--surface-border);
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.session-logout-btn:hover,
.session-login-btn:hover {
  border-color: var(--td-brand-color, #0052d9);
  color: var(--td-brand-color, #0052d9);
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 6%, transparent);
}

.session-login-tip {
  margin: 0;
  color: var(--text-muted, #9aa5be);
  font-size: 12px;
  line-height: 1.4;
}

/* ─────────────── 主聊天区 ───────────── */
.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--surface-border);
  background: var(--surface-card);
  flex-shrink: 0;
}

.auth-reminder {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--td-brand-color, #0052d9) 20%, transparent);
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 8%, transparent);
  color: var(--text-secondary);
  font-size: 13px;
}

.auth-reminder__btn {
  border: none;
  border-radius: 7px;
  padding: 5px 10px;
  background: var(--td-brand-color, #0052d9);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}

.auth-reminder__btn:hover {
  opacity: 0.9;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-title {
  display: flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

/* Agent 工作状态指示（产出条旁） */
.artifacts-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--td-brand-color, #0052d9) 8%, transparent);
}

.header-status__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--td-brand-color, #0052d9);
  animation: thinking-breathe 1.5s ease-in-out infinite;
}

.header-status__text {
  font-size: 12px;
  font-weight: 500;
  color: var(--td-brand-color, #0052d9);
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
}

.clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--tech-radius-sm);
  border: 1px solid var(--surface-border);
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.clear-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

/* ─────────────── TDesign Chat 容器 ──── */
.chat-body {
  flex: 1;
  overflow: hidden;
  min-height: 0;
  position: relative;
}

/* ─── 产出文件条（绝对定位在 sender 上方）─── */
.artifacts-strip {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 10;
  padding: 0px 10px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  pointer-events: none;
  /* background: linear-gradient(to top, var(--surface-bg, #f8f8f7) 60%, transparent); */
  padding-top: 14px;
}

.artifacts-strip > * {
  pointer-events: auto;
}

/* "查看 Kit 的电脑" 按钮 */
.artifacts-computer-btn {
  align-self: flex-start;
  padding: 6px 14px;
  border-radius: 18px;
  border: 1px solid var(--surface-border);
  background: var(--surface-card);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.artifacts-computer-btn:hover {
  background: var(--surface-hover);
  border-color: var(--td-brand-color);
}

/* 通用辅助 */
.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--surface-border);
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.icon-btn:hover {
  border-color: var(--td-brand-color);
  color: var(--td-brand-color);
}

.mr-1\.5 {
  margin-right: 6px;
}

.mb-2 {
  margin-bottom: 8px;
}

/* ─────────────── 右侧实时面板容器 ───────── */
.live-panel-wrapper {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  height: 100%;
}

/* 拖拽手柄 */
.resize-handle {
  width: 6px;
  cursor: col-resize;
  background: transparent;
  position: relative;
  flex-shrink: 0;
  z-index: 10;
  transition: background 0.15s;
}

.resize-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 32px;
  border-radius: 2px;
  background: #d1d5db;
  opacity: 0;
  transition: opacity 0.15s;
}

.resize-handle:hover::after,
.resize-handle.dragging::after {
  opacity: 1;
}

.resize-handle:hover,
.resize-handle.dragging {
  background: rgba(59, 130, 246, 0.08);
}

/* 右侧面板滑入动画 */
.panel-slide-right-enter-active,
.panel-slide-right-leave-active {
  transition: all 0.2s ease;
}

.panel-slide-right-enter-from,
.panel-slide-right-leave-to {
  width: 0;
  min-width: 0;
  opacity: 0;
  overflow: hidden;
}

.w-full {
  width: 100%;
}

.flex-1 {
  flex: 1;
}

.opacity-50 {
  opacity: 0.5;
}

.opacity-70 {
  opacity: 0.7;
}

.text-xs {
  font-size: 12px;
}

/*
  t-chatbot 是 Web Component（Shadow DOM），
  不能用 .class 或 :deep(.class) 直接命中内部节点。
  这里通过组件暴露的 CSS 变量覆盖用户气泡背景色。
*/

.chat-body :deep(t-chatbot) {
  --td-chat-item-primary-bg: #ffffff;
  --td-chat-item-primary-bg-hover: #f3f4f6;
  font-size: 12px;
  --td-chat-item-user-text-color:#0d1117;
  --td-chat-font-size:14px;
}

/* ─── 思考 Loading 状态指示 ─── */
.thinking-status__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--td-brand-color, #0052d9);
  flex-shrink: 0;
  animation: thinking-breathe 1.5s ease-in-out infinite;
}

.thinking-status__text {
  font-size: 14px;
  line-height: 1.4;
  color: var(--text-secondary, #5f6b7a);
  font-weight: 400;
}

@keyframes thinking-breathe {
  0%, 100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}

/* 思考 Loading 淡入淡出 */
.thinking-fade-enter-active,
.thinking-fade-leave-active {
  transition: opacity 0.2s ease;
}
.thinking-fade-enter-from,
.thinking-fade-leave-to {
  opacity: 0;
}


</style>
