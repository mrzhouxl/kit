/**
 * live-panel/composables.ts — 面板业务逻辑 composable
 *
 * 将预览、产出文件管理、终端日志等逻辑抽离为可组合函数，
 * 便于 LivePanel 组件和父组件共享状态。
 */
import { ref } from 'vue'
import type {
  TerminalLine,
  PreviewFileInfo,
  ArtifactItem,
  SandboxStatus,
  LivePanelTab,
  ToolLogEntry,
} from './types'

/** 最大终端行数 */
const MAX_TERMINAL_LINES = 200

/**
 * 面板核心状态 composable。
 * 在 agent.vue 中调用一次，将返回值透传给 LivePanel 组件。
 */
export function useLivePanelState() {
  // ── 面板控制 ──
  /** 右侧面板是否展开 */
  const visible = ref(false)
  /** 面板当前 tab */
  const activeTab = ref<LivePanelTab>('browser')

  // ── 浏览器 ──
  /** 当前浏览器截图帧（base64 JPEG） */
  const browserFrame = ref('')
  /** 当前浏览器 URL */
  const browserUrl = ref('')
  /** 当前浏览器页面标题 */
  const browserTitle = ref('')

  // ── 终端 ──
  /** 终端输出行 */
  const terminalLines = ref<TerminalLine[]>([])

  // ── 沙箱状态 ──
  /** 沙箱状态指示 */
  const sandboxStatus = ref<SandboxStatus>('offline')
  /** 当前执行的操作描述 */
  const sandboxOperation = ref('')

  // ── 文件预览 ──
  /** 文件预览状态 */
  const previewFile = ref<PreviewFileInfo | null>(null)
  /** 预览 iframe 加载中 */
  const previewLoading = ref(false)
  /** 当前预览是否为用户主动打开 */
  const previewPinned = ref(false)
  /** 文本/Markdown 预览内容 */
  const previewTextContent = ref('')
  /** 是否处于编辑模式 */
  const previewEditing = ref(false)
  /** 编辑中的内容 */
  const previewEditContent = ref('')
  /** 保存中状态 */
  const previewSaving = ref(false)
  /** 最近一次用户编辑并保存的文件信息 */
  const lastEditedFile = ref<{ url: string; fileName: string } | null>(null)

  // ── 产出文件 ──
  /** 当前会话的所有产出文件 */
  const artifacts = ref<ArtifactItem[]>([])
  /** 产出文件弹窗是否可见 */
  const artifactsDialogVisible = ref(false)

  // ── 新一轮提问标记 ──
  /** 新一轮提问已发出，终端事件到达时允许覆盖预览 tab */
  const newRoundPending = ref(false)

  return {
    visible,
    activeTab,
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
    previewEditing,
    previewEditContent,
    previewSaving,
    lastEditedFile,
    artifacts,
    artifactsDialogVisible,
    newRoundPending,
  }
}

/** useLivePanelState 返回值类型 */
export type LivePanelState = ReturnType<typeof useLivePanelState>

/**
 * 面板操作方法 composable。
 * 依赖 useLivePanelState() 的返回值。
 */
export function useLivePanelActions(state: LivePanelState) {
  const {
    visible,
    activeTab,
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
    previewEditing,
    previewEditContent,
    lastEditedFile,
    artifacts,
    newRoundPending,
  } = state

  // ── 产出文件管理 ──

  /** 从文件扩展名推断 fileType */
  function inferFileType(fileName: string): ArtifactItem['fileType'] {
    const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : ''
    if (['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls'].includes(ext)) return 'office'
    if (ext === '.pdf') return 'pdf'
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image'
    if (['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) return 'video'
    if (ext === '.md') return 'markdown'
    if (['.txt', '.csv', '.json', '.xml', '.log', '.yaml', '.yml'].includes(ext)) return 'text'
    if (ext === '.html') return 'html'
    if (['.mmd', '.mermaid', '.mindmap'].includes(ext)) return 'mindmap'
    return 'unknown'
  }

  /** 添加产出文件（同名文件取最新版本） */
  function addArtifact(url: string, fileName: string, fileType?: ArtifactItem['fileType']) {
    artifacts.value = artifacts.value.filter(a => a.fileName !== fileName)
    artifacts.value.push({
      url,
      fileName,
      fileType: fileType ?? inferFileType(fileName),
      timestamp: Date.now(),
    })
  }

  /** 从消息文本中提取产出文件链接（兜底） */
  function extractArtifactsFromMessages(messages: Array<{ role: string; content: string }>) {
    artifacts.value = []
    const linkPattern = /\[(?:点击下载|下载)\s+([^\]]+)\]\(([^)]+)\)/g
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      let match: RegExpExecArray | null
      while ((match = linkPattern.exec(msg.content)) !== null) {
        const fileName = match[1]!.trim()
        const url = match[2]!.trim()
        if (url.startsWith('http')) {
          addArtifact(url, fileName)
        }
      }
    }
  }

  /** 从历史消息的 metadata 中还原终端日志和产出文件 */
  function restoreFromMessages(messages: Array<{ role: string; content: string; metadata?: unknown }>) {
    terminalLines.value = []
    artifacts.value = []

    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.metadata) continue
      const meta = msg.metadata as { toolLogs?: ToolLogEntry[] }
      if (!Array.isArray(meta.toolLogs)) continue

      for (const log of meta.toolLogs) {
        switch (log.type) {
          case 'code_output':
            if (log.data) {
              terminalLines.value.push({
                text: log.data,
                stream: log.stream || 'stdout',
              })
            }
            break
          case 'file_preview':
            if (log.url && log.fileName) {
              addArtifact(log.url, log.fileName, (log.fileType as ArtifactItem['fileType']) ?? undefined)
            }
            break
        }
      }
    }

    extractArtifactsFromMessages(messages)
  }

  // ── 终端操作 ──

  /** 追加终端输出行 */
  function appendTerminalLine(text: string, stream: 'stdout' | 'stderr' = 'stdout') {
    terminalLines.value.push({ text, stream })
    if (terminalLines.value.length > MAX_TERMINAL_LINES) {
      terminalLines.value = terminalLines.value.slice(-MAX_TERMINAL_LINES)
    }
  }

  // ── 预览操作 ──

  /** 打开产出文件预览 */
  function openArtifact(artifact: ArtifactItem) {
    previewFile.value = {
      url: artifact.url,
      fileName: artifact.fileName,
      fileType: artifact.fileType === 'unknown' ? 'text' : artifact.fileType,
    }
    previewLoading.value = true
    previewPinned.value = true
    visible.value = true
    activeTab.value = 'preview'
    // 文本类文件 fetch 内容后渲染
    if (['markdown', 'text', 'html', 'mindmap'].includes(artifact.fileType)) {
      previewTextContent.value = ''
      fetch(artifact.url).then(r => r.text()).then(text => {
        previewTextContent.value = text
        previewLoading.value = false
      }).catch(() => {
        previewTextContent.value = '加载失败'
        previewLoading.value = false
      })
    }
  }

  /** 判断当前预览文件是否可编辑 */
  function isEditablePreview(): boolean {
    if (!previewFile.value) return false
    return ['markdown', 'text', 'html', 'mindmap'].includes(previewFile.value.fileType)
  }

  /** 切换编辑/预览模式 */
  function togglePreviewEdit() {
    if (previewEditing.value) {
      previewEditing.value = false
    } else {
      previewEditContent.value = previewTextContent.value
      previewEditing.value = true
    }
  }

  // ── Tab 自动切换逻辑 ──

  /**
   * 尝试切换到指定 tab（带保护逻辑）。
   * 终端输出到来时优先展示 terminal；但如果当前已经在查看文件预览，则保留 preview，避免被后续日志抢占。
   */
  function switchTabSafe(target: 'browser' | 'terminal') {
    if (activeTab.value === 'preview' && previewFile.value && previewPinned.value) {
      newRoundPending.value = false
      return
    }

    if (newRoundPending.value && activeTab.value === 'preview' && !previewFile.value) {
      browserFrame.value = ''
    }

    newRoundPending.value = false
    activeTab.value = target
  }

  // ── 面板重置 ──

  /** 重置所有面板状态（切换会话时调用） */
  function reset() {
    browserFrame.value = ''
    browserUrl.value = ''
    browserTitle.value = ''
    terminalLines.value = []
    sandboxStatus.value = 'offline'
    sandboxOperation.value = ''
    visible.value = false
    previewFile.value = null
    previewLoading.value = false
    previewPinned.value = false
    previewTextContent.value = ''
    previewEditing.value = false
    previewEditContent.value = ''
    lastEditedFile.value = null
    artifacts.value = []
    newRoundPending.value = false
  }

  return {
    inferFileType,
    addArtifact,
    extractArtifactsFromMessages,
    restoreFromMessages,
    appendTerminalLine,
    openArtifact,
    isEditablePreview,
    togglePreviewEdit,
    switchTabSafe,
    reset,
  }
}

/** useLivePanelActions 返回值类型 */
export type LivePanelActions = ReturnType<typeof useLivePanelActions>
