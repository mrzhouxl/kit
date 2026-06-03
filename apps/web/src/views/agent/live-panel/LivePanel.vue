<script setup lang="ts">
/**
 * LivePanel.vue — 右侧实时操作面板组件
 *
 * 独立封装浏览器视图、终端视图、文件预览视图和产出文件管理，
 * 便于后续扩展新的 tab 内容类型。
 */
import { computed, ref, watch, nextTick } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { CloseOne } from '@/utils/app-icons'
import type { LivePanelState, LivePanelActions } from './composables'

// ── Props ─────────────────────────────────────────────────────
const props = defineProps<{
  /** 面板状态（由 useLivePanelState 创建） */
  state: LivePanelState
  /** 面板操作方法（由 useLivePanelActions 创建） */
  actions: LivePanelActions
  /** Agent 服务 URL（保存文件时使用） */
  agentUrl: string
  /** 当前会话线程 ID */
  threadId: string
}>()

// ── Emit ──────────────────────────────────────────────────────
const emit = defineEmits<{
  /** 关闭面板 */
  (e: 'close'): void
}>()

// ── 解构 state（保持响应性） ──────────────────────────────────
const {
  activeTab,
  browserFrame,
  browserUrl,
  sandboxStatus,
  sandboxOperation,
  previewFile,
  previewLoading,
  previewTextContent,
  previewEditing,
  previewEditContent,
  previewSaving,
  artifacts,
  artifactsDialogVisible,
} = props.state

const {
  openArtifact,
  isEditablePreview,
  togglePreviewEdit,
} = props.actions

// ── 终端滚动 ──────────────────────────────────────────────────
const terminalRef = ref<HTMLDivElement | null>(null)

const terminalRows = computed(() => props.state.terminalLines.value.flatMap((line, index) => {
  const segments = line.text.replace(/\r\n/g, '\n').split('\n')
  return segments
    .filter((segment, segmentIndex) => segment !== '' || segmentIndex < segments.length - 1)
    .map((segment, segmentIndex) => ({
      id: `${index}-${segmentIndex}`,
      text: segment || ' ',
      stream: line.stream,
    }))
}))

const stdoutCount = computed(() => terminalRows.value.filter(row => row.stream === 'stdout').length)
const stderrCount = computed(() => terminalRows.value.filter(row => row.stream === 'stderr').length)
const terminalStatusLabel = computed(() => {
  if (sandboxStatus.value === 'busy') return 'RUNNING'
  if (sandboxStatus.value === 'idle') return 'IDLE'
  return 'OFFLINE'
})
const panelStatusText = computed(() => {
  if (activeTab.value === 'preview' && previewFile.value) return '文件预览'

  if (sandboxStatus.value === 'idle') return 'Kit 就绪'
  if (sandboxStatus.value !== 'busy') return '等待连接'

  if (activeTab.value === 'browser') return 'Kit 正在使用浏览器'
  if (activeTab.value === 'terminal') return 'Kit 正在处理'

  return 'Kit 正在处理'
})

// 终端输出新增时自动滚到底部
watch(terminalRows, () => {
  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight
    }
  })
}, { deep: true })

// ── Markdown 渲染 ─────────────────────────────────────────────
/**
 * 轻量 Markdown → HTML 渲染。
 * 支持标题、粗体、斜体、代码块、行内代码、链接、列表、分隔线。
 */
function renderMarkdown(md: string): string {
  if (!md) return ''
  let html = md
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr/>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>')
  return `<p>${html}</p>`
}

/**
 * 生成 Mermaid 思维导图 srcdoc。
 * 使用 JSON.stringify 对源码做安全编码，避免模板注入。
 */
function buildMermaidSrcdoc(content: string): string {
  const safeContent = JSON.stringify(content)
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{padding:16px;background:#fafafa;font-family:system-ui,sans-serif}#d{display:flex;justify-content:center}svg{max-width:100%;height:auto}#err{color:#e53e3e;font-size:13px;padding:12px;white-space:pre-wrap}</style>
</head><body><div id="d"><span style="color:#999;font-size:13px">渲染中...</span></div>
<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({startOnLoad:false,theme:'default',securityLevel:'loose'});
const c=${safeContent};try{const{svg}=await mermaid.render('g'+Date.now(),c);document.getElementById('d').innerHTML=svg;}catch(e){document.getElementById('d').innerHTML='<pre id="err">'+String(e)+'</pre>';}<\/script></body></html>`
}

// ── 文件保存 ──────────────────────────────────────────────────
/** 保存编辑后的文件 */
async function savePreviewFile() {
  if (!previewFile.value || previewSaving.value) return
  previewSaving.value = true

  try {
    const token = localStorage.getItem('token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${props.agentUrl}/api/chat/save-file`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: previewEditContent.value,
        fileName: previewFile.value.fileName,
        threadId: props.threadId,
      }),
    })

    const data = await res.json()
    if (data.success && data.url) {
      previewTextContent.value = previewEditContent.value
      previewFile.value = { ...previewFile.value, url: data.url }
      previewEditing.value = false
      // 记录编辑信息，下次发送消息时自动附加给 agent
      props.state.lastEditedFile.value = { url: data.url, fileName: previewFile.value.fileName }
    } else {
      alert(`保存失败: ${data.message || '未知错误'}`)
    }
  } catch (err) {
    alert(`保存失败: ${err instanceof Error ? err.message : '网络错误'}`)
  } finally {
    previewSaving.value = false
  }
}

/** 产出文件类型对应的图标 */
function getArtifactIcon(fileType: string): string {
  const map: Record<string, string> = {
    office: '📊', pdf: '📕', image: '🖼️', markdown: '📝',
    text: '📄', html: '🌐', mindmap: '🗺️',
  }
  return map[fileType] || '📎'
}

/** 关闭面板 */
function handleClose() {
  props.state.visible.value = false
  emit('close')
}
</script>

<template>
  <aside class="live-panel">
    <!-- 顶部标题栏 -->
    <div class="lp-titlebar">
      <span class="lp-titlebar-text">Kit 的电脑</span>
      <div class="lp-titlebar-actions">
        <button
          v-if="artifacts.length > 0"
          class="lp-artifacts-btn"
          title="查看产出文件"
          @click="artifactsDialogVisible = true"
        >
          📁 产出 <span class="lp-artifacts-btn-badge">{{ artifacts.length }}</span>
        </button>
        <button class="lp-win-btn" title="关闭面板" @click="handleClose">
          <AppIcon :icon="CloseOne" :size="12" :stroke-width="2" />
        </button>
      </div>
    </div>

    <!-- 状态条 -->
    <div class="lp-status-bar">
      <div class="lp-status-left">
        <span class="lp-status-dot" :class="sandboxStatus" />
        <span class="lp-status-text">{{ panelStatusText }}</span>
      </div>
    </div>

    <!-- ═══ 浏览器视图 ═══ -->
    <template v-if="activeTab === 'browser' && browserFrame">
      <!-- URL 地址栏 -->
      <div v-if="browserUrl" class="lp-url-bar">
        <span class="lp-url-label">正在浏览</span>
        <span class="lp-url-text">{{ browserUrl }}</span>
      </div>
      <!-- 浏览器画面 -->
      <div class="lp-viewport">
        <img v-if="browserFrame" :src="'data:image/jpeg;base64,' + browserFrame" class="lp-browser-img"
          alt="浏览器实时画面" />
        <div v-else class="lp-placeholder">
          <div class="lp-placeholder-icon">🖥️</div>
          <span>等待浏览器操作…</span>
        </div>
      </div>
    </template>

    <!-- ═══ 终端视图 ═══ -->
    <template v-if="activeTab === 'terminal'">
      <div class="lp-viewport lp-terminal">
        <div class="terminal-shell">
          <div class="terminal-toolbar">
            <div class="terminal-toolbar-lights">
              <span class="terminal-light terminal-light-close" />
              <span class="terminal-light terminal-light-minimize" />
              <span class="terminal-light terminal-light-expand" />
            </div>
            <span class="terminal-toolbar-title">Terminal</span>
            <div class="terminal-toolbar-metrics">
              <span class="terminal-metric">stdout {{ stdoutCount }}</span>
              <span class="terminal-metric terminal-metric-error">stderr {{ stderrCount }}</span>
            </div>
          </div>

          <div ref="terminalRef" class="terminal-viewport">
            <div class="terminal-banner">
              <span class="terminal-banner-shell">kit@sandbox</span>
              <span class="terminal-banner-divider">·</span>
              <span class="terminal-banner-state">{{ terminalStatusLabel }}</span>
            </div>

            <div v-if="terminalRows.length === 0" class="terminal-empty-state">
              <span class="terminal-empty-prompt">$</span>
              <span class="terminal-empty-text">等待真实 stdout / stderr 输出…</span>
            </div>

            <div
              v-for="row in terminalRows"
              :key="row.id"
              class="terminal-row"
              :class="row.stream"
            >
              <span class="terminal-row-prefix">{{ row.stream === 'stderr' ? '!' : '›' }}</span>
              <span class="terminal-row-text">{{ row.text }}</span>
            </div>
          </div>

          <div class="terminal-footer">
            <span class="terminal-footer-status" :class="sandboxStatus">{{ terminalStatusLabel }}</span>
            <span class="terminal-footer-operation">{{ sandboxOperation || '等待新的执行任务' }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ═══ 文件预览视图 ═══ -->
    <template v-if="activeTab === 'preview' && previewFile">
      <div class="lp-preview-bar">
        <span class="lp-preview-name">{{ previewFile.fileName }}</span>
        <div class="lp-preview-actions">
          <template v-if="isEditablePreview()">
            <button v-if="previewEditing" class="lp-preview-btn lp-preview-save" :disabled="previewSaving" @click="savePreviewFile">
              {{ previewSaving ? '保存中…' : '💾 保存' }}
            </button>
            <button class="lp-preview-btn" @click="togglePreviewEdit">
              {{ previewEditing ? '取消' : '✏️ 编辑' }}
            </button>
          </template>
          <a :href="previewFile.url" target="_blank" class="lp-preview-download" title="下载文件">⬇ 下载</a>
        </div>
      </div>
      <div class="lp-viewport lp-preview">
        <!-- 编辑模式 -->
        <textarea
          v-if="previewEditing"
          v-model="previewEditContent"
          class="lp-preview-editor"
          spellcheck="false"
        />
        <!-- Office 文件 -->
        <iframe
          v-else-if="previewFile.fileType === 'office'"
          :src="'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(previewFile.url)"
          class="lp-preview-iframe"
          frameborder="0"
          allowfullscreen
          @load="previewLoading = false"
        />
        <!-- PDF -->
        <iframe
          v-else-if="previewFile.fileType === 'pdf'"
          :src="previewFile.url"
          class="lp-preview-iframe"
          frameborder="0"
          @load="previewLoading = false"
        />
        <!-- 图片 -->
        <img
          v-else-if="previewFile.fileType === 'image'"
          :src="previewFile.url"
          class="lp-preview-image"
          :alt="previewFile.fileName"
          @load="previewLoading = false"
        />
        <!-- 视频 -->
        <video
          v-else-if="previewFile.fileType === 'video'"
          :src="previewFile.url"
          class="lp-preview-video"
          controls
          playsinline
          preload="metadata"
          @loadeddata="previewLoading = false"
          @error="previewLoading = false"
        />
        <!-- Markdown -->
        <div
          v-else-if="previewFile.fileType === 'markdown'"
          class="lp-preview-markdown"
          v-html="renderMarkdown(previewTextContent)"
        />
        <!-- 纯文本 -->
        <pre
          v-else-if="previewFile.fileType === 'text'"
          class="lp-preview-text"
        >{{ previewTextContent }}</pre>
        <!-- HTML -->
        <iframe
          v-else-if="previewFile.fileType === 'html'"
          :srcdoc="previewTextContent"
          sandbox="allow-scripts allow-same-origin"
          class="lp-preview-iframe"
          frameborder="0"
          @load="previewLoading = false"
        />
        <!-- 思维导图 / Mermaid -->
        <iframe
          v-else-if="previewFile.fileType === 'mindmap'"
          :srcdoc="buildMermaidSrcdoc(previewTextContent)"
          sandbox="allow-scripts"
          class="lp-preview-iframe"
          frameborder="0"
          @load="previewLoading = false"
        />
        <!-- 加载指示 -->
        <div v-if="previewLoading" class="lp-preview-loading">
          <div class="lp-preview-spinner" />
          <span>加载预览中…</span>
        </div>
      </div>
    </template>

    <!-- 底部实时指示条 -->
    <div class="lp-bottom-bar">
      <div class="lp-timeline">
        <div class="lp-timeline-track">
          <div class="lp-timeline-fill" :class="{ pulsing: sandboxStatus === 'busy' }" />
        </div>
        <span class="lp-live-badge" :class="{ active: sandboxStatus === 'busy' }">
          <span class="lp-live-dot" />
          实时
        </span>
      </div>
      <div v-if="sandboxOperation" class="lp-operation">
        <span class="lp-op-check">✓</span>
        <span class="lp-op-text">{{ sandboxOperation }}</span>
      </div>
    </div>
  </aside>

  <!-- ═══ 产出文件弹窗 ═══ -->
  <teleport to="body">
    <transition name="fade">
      <div v-if="artifactsDialogVisible" class="artifacts-dialog-mask" @click.self="artifactsDialogVisible = false">
        <div class="artifacts-dialog">
          <div class="artifacts-dialog-header">
            <span class="artifacts-dialog-title">📁 产出文件 ({{ artifacts.length }})</span>
            <button class="artifacts-dialog-close" @click="artifactsDialogVisible = false">✕</button>
          </div>
          <div class="artifacts-dialog-body">
            <div v-if="artifacts.length === 0" class="artifacts-dialog-empty">暂无产出文件</div>
            <div
              v-for="(artifact, idx) in artifacts"
              :key="idx"
              class="artifacts-dialog-item"
              @click="openArtifact(artifact); artifactsDialogVisible = false"
              :title="artifact.fileName"
            >
              <span class="artifacts-dialog-item-icon">{{ getArtifactIcon(artifact.fileType) }}</span>
              <span class="artifacts-dialog-item-name">{{ artifact.fileName }}</span>
              <a class="artifacts-dialog-item-dl" :href="artifact.url" target="_blank" @click.stop title="下载">⬇</a>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<style scoped>
/* ── 面板布局 ── */
.live-panel {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: none;
  background: #f8f9fb;
  overflow: hidden;
  border-radius: 0 12px 12px 0;
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.04);
  width: 100%;
  height: 100%;
}

/* 标题栏 */
.lp-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #fff;
  border-bottom: 1px solid #e8ecf1;
  flex-shrink: 0;
}

.lp-titlebar-text {
  font-size: 13px;
  font-weight: 600;
  color: #1a1a2e;
}

.lp-titlebar-actions {
  display: flex;
  gap: 6px;
}

.lp-win-btn {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.lp-win-btn:hover {
  background: #f3f4f6;
  color: #374151;
}

/* 产出文件按钮 */
.lp-artifacts-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 14px;
  border: 1px solid #e8ecf1;
  background: #f9fafb;
  color: #374151;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.lp-artifacts-btn:hover {
  background: #eef2ff;
  border-color: #3b82f6;
  color: #3b82f6;
}

.lp-artifacts-btn-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #3b82f6;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

/* ── 产出文件弹窗 ── */
.artifacts-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}

.artifacts-dialog {
  width: 420px;
  max-width: 90vw;
  max-height: 70vh;
  border-radius: 12px;
  background: var(--surface-card, #fff);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.artifacts-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--surface-border, #e8ecf1);
}

.artifacts-dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary, #1a1a2e);
}

.artifacts-dialog-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted, #9ca3af);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.artifacts-dialog-close:hover {
  background: var(--surface-hover, #f3f4f6);
  color: var(--text-primary, #374151);
}

.artifacts-dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.artifacts-dialog-empty {
  text-align: center;
  color: var(--text-muted, #9ca3af);
  padding: 32px 0;
  font-size: 13px;
}

.artifacts-dialog-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  cursor: pointer;
  transition: background 0.1s;
}

.artifacts-dialog-item:hover {
  background: var(--surface-hover, #f5f7fa);
}

.artifacts-dialog-item-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.artifacts-dialog-item-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--text-primary, #1a1a2e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artifacts-dialog-item-dl {
  flex-shrink: 0;
  text-decoration: none;
  color: var(--text-muted, #9ca3af);
  font-size: 14px;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s;
}

.artifacts-dialog-item-dl:hover {
  background: var(--surface-hover, #eef2ff);
  color: #3b82f6;
}

/* 弹窗动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 状态条 */
.lp-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: #fff;
  border-bottom: 1px solid #e8ecf1;
  flex-shrink: 0;
}

.lp-status-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lp-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b7280;
  flex-shrink: 0;
  transition: background 0.3s;
}

.lp-status-dot.idle { background: #22c55e; }
.lp-status-dot.busy {
  background: #3b82f6;
  animation: pulse-dot 1.2s infinite;
}
.lp-status-dot.offline { background: #d1d5db; }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}

.lp-status-text {
  font-size: 12px;
  color: #6b7280;
}

/* URL 地址栏 */
.lp-url-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: #f0f4f8;
  border-bottom: 1px solid #e8ecf1;
  flex-shrink: 0;
  overflow: hidden;
}

.lp-url-label {
  font-size: 11px;
  color: #9ca3af;
  flex-shrink: 0;
}

.lp-url-text {
  font-size: 11px;
  color: #3b82f6;
  font-family: 'SF Mono', 'Consolas', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 主视窗 */
.lp-viewport {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1e1e2e;
  min-height: 0;
  position: relative;
}

.lp-browser-img {
  max-width: 100%;
  max-height: 100%;
  display: block;
  object-fit: contain;
  image-rendering: -webkit-optimize-contrast;
}

.lp-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 200px;
  color: #6b7280;
  font-size: 13px;
  gap: 12px;
}

.lp-placeholder-icon {
  font-size: 36px;
  opacity: 0.4;
}

/* 终端样式 */
.lp-terminal {
  background:
    radial-gradient(circle at top, rgba(81, 102, 255, 0.12), transparent 34%),
    linear-gradient(180deg, #0a0f18 0%, #0d1117 56%, #070b11 100%);
  align-items: stretch;
  justify-content: flex-start;
  padding: 0;
}

.terminal-shell {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(6, 11, 18, 0.96), rgba(4, 8, 14, 0.99)),
    linear-gradient(90deg, rgba(15, 23, 42, 0.52) 0, rgba(15, 23, 42, 0.52) 44px, transparent 44px);
}

.terminal-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 42px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
  background: linear-gradient(180deg, rgba(19, 28, 40, 0.98), rgba(10, 16, 24, 0.98));
}

.terminal-toolbar-lights {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.terminal-light {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
}

.terminal-light-close { background: #ff5f57; }
.terminal-light-minimize { background: #ffbd2f; }
.terminal-light-expand { background: #28c840; }

.terminal-toolbar-title {
  flex: 1;
  min-width: 0;
  text-align: center;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #cbd5e1;
}

.terminal-toolbar-metrics {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.terminal-metric {
  border-radius: 999px;
  padding: 3px 8px;
  background: rgba(51, 65, 85, 0.68);
  color: #cbd5e1;
  font-size: 11px;
  line-height: 1;
}

.terminal-metric-error {
  color: #fca5a5;
  background: rgba(127, 29, 29, 0.34);
}

.terminal-viewport {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px 14px;
  background: transparent;
  font-family: 'SF Mono', 'Consolas', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.7;
  min-height: 0;
  width: 100%;
  text-align: left;
}

.terminal-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: #8aa4c8;
  font-size: 11px;
  letter-spacing: 0.04em;
}

.terminal-banner-shell {
  color: #93c5fd;
}

.terminal-banner-divider {
  color: rgba(148, 163, 184, 0.55);
}

.terminal-banner-state {
  color: #cbd5e1;
}

.terminal-empty-state,
.terminal-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

.terminal-empty-state {
  color: #64748b;
}

.terminal-empty-prompt {
  color: #34d399;
  font-weight: 600;
}

.terminal-empty-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.terminal-row-prefix {
  color: #34d399;
  user-select: none;
}

.terminal-row-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.terminal-row.stdout {
  color: #d7e0ea;
}

.terminal-row.stderr {
  color: #fca5a5;
}

.terminal-row.stderr .terminal-row-prefix {
  color: #fb7185;
}

.terminal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  padding: 0 16px;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(8, 13, 20, 0.98);
  color: #94a3b8;
  font-size: 11px;
}

.terminal-footer-status {
  flex-shrink: 0;
  border-radius: 999px;
  padding: 3px 8px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: rgba(51, 65, 85, 0.72);
}

.terminal-footer-status.busy {
  color: #93c5fd;
  background: rgba(30, 64, 175, 0.28);
}

.terminal-footer-status.idle {
  color: #86efac;
  background: rgba(21, 128, 61, 0.26);
}

.terminal-footer-status.offline {
  color: #94a3b8;
  background: rgba(51, 65, 85, 0.44);
}

.terminal-footer-operation {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 文件预览样式 ── */
.lp-preview-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  background: #f0f2f5;
  border-bottom: 1px solid #e5e7eb;
  font-size: 12px;
  flex-shrink: 0;
}

.lp-preview-name {
  color: #374151;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  margin-right: 8px;
}

.lp-preview-download {
  color: #3b82f6;
  text-decoration: none;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 4px;
  transition: background 0.15s;
}

.lp-preview-download:hover {
  background: rgba(59, 130, 246, 0.08);
}

.lp-preview-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.lp-preview-btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #374151;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.lp-preview-btn:hover { background: #f3f4f6; }
.lp-preview-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.lp-preview-save {
  background: #0052d9;
  color: #fff;
  border-color: #0052d9;
}
.lp-preview-save:hover { background: #0040b0; }
.lp-preview-save:disabled { background: #93b4e8; border-color: #93b4e8; }

.lp-preview-editor {
  flex: 1;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 16px 20px;
  font-size: 13px;
  line-height: 1.6;
  font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
  color: #1f2937;
  background: #fefefe;
  box-sizing: border-box;
  tab-size: 2;
  min-height: 0;
}
.lp-preview-editor:focus { background: #fffef5; }

.lp-preview {
  background: #ffffff;
  position: relative;
  align-items: stretch;
  justify-content: flex-start;
  flex-direction: column;
}

.lp-preview-iframe {
  flex: 1;
  width: 100%;
  border: none;
  display: block;
  min-height: 0;
}

.lp-preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  margin: auto;
  align-self: center;
}

.lp-preview-video {
  width: 100%;
  height: 100%;
  display: block;
  background: #000;
  border-radius: 12px;
}

.lp-preview-markdown {
  flex: 1;
  width: 100%;
  overflow: auto;
  padding: 20px 24px;
  font-size: 14px;
  line-height: 1.7;
  color: #333;
  box-sizing: border-box;
  min-height: 0;
}
.lp-preview-markdown h1 { font-size: 1.6em; font-weight: 700; margin: 0.6em 0 0.4em; }
.lp-preview-markdown h2 { font-size: 1.35em; font-weight: 600; margin: 0.5em 0 0.3em; }
.lp-preview-markdown h3 { font-size: 1.15em; font-weight: 600; margin: 0.4em 0 0.2em; }
.lp-preview-markdown h4 { font-size: 1em; font-weight: 600; margin: 0.3em 0 0.2em; }
.lp-preview-markdown code {
  background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; font-family: 'Fira Code', monospace;
}
.lp-preview-markdown pre {
  background: #1e1e1e; color: #d4d4d4; padding: 14px 16px; border-radius: 8px;
  overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 12px 0;
}
.lp-preview-markdown pre code { background: none; padding: 0; color: inherit; }
.lp-preview-markdown a { color: #0052d9; text-decoration: none; }
.lp-preview-markdown a:hover { text-decoration: underline; }
.lp-preview-markdown hr { border: none; border-top: 1px solid #e5e5e5; margin: 16px 0; }
.lp-preview-markdown li { margin: 4px 0; list-style: disc inside; }
.lp-preview-markdown strong { font-weight: 600; }

.lp-preview-text {
  flex: 1;
  width: 100%;
  overflow: auto;
  padding: 16px 20px;
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  font-family: 'Fira Code', 'Consolas', monospace;
  color: #333;
  white-space: pre-wrap;
  word-break: break-all;
  box-sizing: border-box;
  background: #fafafa;
  min-height: 0;
}

.lp-preview-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(255, 255, 255, 0.9);
  color: #6b7280;
  font-size: 13px;
}

.lp-preview-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid #e5e7eb;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: preview-spin 0.8s linear infinite;
}

@keyframes preview-spin {
  to { transform: rotate(360deg); }
}

/* 底部实时指示条 */
.lp-bottom-bar {
  flex-shrink: 0;
  border-top: 1px solid #e8ecf1;
  background: #fff;
}

.lp-timeline {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
}

.lp-timeline-track {
  flex: 1;
  height: 3px;
  background: #e5e7eb;
  border-radius: 2px;
  overflow: hidden;
}

.lp-timeline-fill {
  height: 100%;
  width: 100%;
  background: #3b82f6;
  border-radius: 2px;
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.3s;
}

.lp-timeline-fill.pulsing {
  transform: scaleX(1);
  animation: timeline-pulse 2s ease-in-out infinite;
}

@keyframes timeline-pulse {
  0% { opacity: 0.4; }
  50% { opacity: 1; }
  100% { opacity: 0.4; }
}

.lp-live-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #9ca3af;
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 10px;
  background: #f3f4f6;
  transition: all 0.2s;
}

.lp-live-badge.active {
  color: #ef4444;
  background: #fef2f2;
}

.lp-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.lp-operation {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid #f3f4f6;
  font-size: 12px;
  color: #4b5563;
}

.lp-op-check { color: #22c55e; font-size: 13px; }

.lp-op-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
