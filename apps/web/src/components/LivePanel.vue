<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
  browserFrame: string
  browserUrl: string
  terminalLines: { text: string; stream: string }[]
  activeTab: 'browser' | 'terminal'
}>()

const emit = defineEmits<{
  (e: 'tabChange', tab: 'browser' | 'terminal'): void
}>()

const terminalRef = ref<HTMLElement | null>(null)
const shouldAutoScroll = ref(true)

const hasBrowserFrame = computed(() => !!props.browserFrame)
const hasTerminalLines = computed(() => props.terminalLines.length > 0)
const terminalCountText = computed(() => `${props.terminalLines.length} 条`)
const terminalStatusLabel = computed(() => (hasTerminalLines.value ? 'RUNNING' : 'IDLE'))
const panelStatusText = computed(() => {
  if (props.activeTab === 'browser') {
    return hasBrowserFrame.value ? 'Kit 正在使用浏览器' : '等待浏览器操作'
  }
  return hasTerminalLines.value ? 'Kit 正在处理' : 'Kit 就绪'
})

const browserHost = computed(() => {
  if (!props.browserUrl) return '未导航'
  try {
    return new URL(props.browserUrl).host
  } catch {
    return '未知站点'
  }
})

function isNearBottom(el: HTMLElement) {
  const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
  return distance <= 24
}

function handleTerminalScroll() {
  const el = terminalRef.value
  if (!el) return
  shouldAutoScroll.value = isNearBottom(el)
}

function scrollTerminalToBottom() {
  nextTick(() => {
    const el = terminalRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
  })
}

watch(
  () => props.terminalLines.length,
  () => {
    if (props.activeTab === 'terminal' && shouldAutoScroll.value) {
      scrollTerminalToBottom()
    }
  },
)

watch(
  () => props.activeTab,
  (tab) => {
    if (tab === 'terminal') {
      shouldAutoScroll.value = true
      scrollTerminalToBottom()
    }
  },
)
</script>

<template>
  <aside class="live-panel">
    <div class="lp-titlebar">
      <span class="lp-titlebar-text">Kit 的电脑</span>

      <div class="live-panel-tabs">
        <button
          class="live-panel-tab"
          :class="{ active: activeTab === 'browser' }"
          @click="emit('tabChange', 'browser')"
        >
          <span class="tab-icon">🌐</span>
          <span>浏览器</span>
        </button>
        <button
          class="live-panel-tab"
          :class="{ active: activeTab === 'terminal' }"
          @click="emit('tabChange', 'terminal')"
        >
          <span class="tab-icon">💻</span>
          <span>终端</span>
        </button>
      </div>

      <div class="lp-titlebar-actions">
        <span class="meta-badge">{{ activeTab === 'browser' ? (hasBrowserFrame ? browserHost : '等待画面') : terminalCountText }}</span>
      </div>
    </div>

    <div class="lp-status-bar">
      <div class="lp-status-left">
        <span class="lp-status-dot" :class="{ busy: hasBrowserFrame || hasTerminalLines, idle: !hasBrowserFrame && !hasTerminalLines }" />
        <span class="lp-status-text">{{ panelStatusText }}</span>
      </div>
    </div>

    <div class="lp-viewport live-panel-content">
      <div v-if="activeTab === 'browser'" class="browser-preview">
        <div class="browser-url" :class="{ muted: !browserUrl }">
          {{ browserUrl || '等待浏览器导航...' }}
        </div>
        <div class="browser-frame-wrap">
          <img
            v-if="browserFrame"
            :src="browserFrame.startsWith('data:') ? browserFrame : `data:image/png;base64,${browserFrame}`"
            alt="Browser screenshot"
          />
          <div v-else class="browser-empty">
            <div class="empty-title">等待浏览器截图...</div>
            <div class="empty-desc">工具执行后将实时显示页面画面</div>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'terminal'" ref="terminalRef" class="terminal-output" @scroll="handleTerminalScroll">
        <template v-if="hasTerminalLines">
          <div
            v-for="(line, idx) in terminalLines"
            :key="idx"
            class="terminal-line"
            :class="line.stream"
          >
            <span class="terminal-row-prefix">{{ line.stream === 'stderr' ? '!' : '›' }}</span>
            <span class="terminal-row-text">{{ line.text }}</span>
          </div>
        </template>
        <div v-else class="terminal-empty">等待代码执行输出...</div>
      </div>

      <div v-if="activeTab === 'terminal'" class="terminal-footer">
        <span class="terminal-footer-status">{{ terminalStatusLabel }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.live-panel {
  flex-shrink: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f8f9fb;
  border-radius: 0 12px 12px 0;
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.04);
}

.lp-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  background: #fff;
  border-bottom: 1px solid #e8ecf1;
  flex-shrink: 0;
}

.live-panel-tabs {
  display: flex;
  gap: 6px;
}

.lp-titlebar-text {
  font-size: 13px;
  font-weight: 600;
  color: #1a1a2e;
  flex-shrink: 0;
}

.lp-titlebar-actions {
  display: flex;
  gap: 6px;
}

.live-panel-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #6b7280;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}

.live-panel-tab:hover {
  background: #f3f4f6;
  color: #374151;
}

.live-panel-tab.active {
  color: #1f2937;
  border-color: #dbe3f0;
  background: #f9fafb;
}

.tab-icon {
  font-size: 12px;
}

.lp-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid #eef2f7;
  background: #fbfcfd;
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
  background: #9ca3af;
}

.lp-status-dot.busy {
  background: #10b981;
}

.lp-status-dot.idle {
  background: #9ca3af;
}

.lp-status-text {
  font-size: 12px;
  color: #64748b;
}

.meta-badge {
  display: inline-block;
  max-width: 180px;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid #e8ecf1;
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.live-panel-content {
  flex: 1;
  min-height: 0;
  padding: 12px;
  overflow: hidden;
}

.lp-viewport {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.browser-preview {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.browser-url {
  color: #111827;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid #e8ecf1;
  background: #fff;
}

.browser-url.muted {
  color: #9ca3af;
}

.browser-frame-wrap {
  flex: 1;
  min-height: 0;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.browser-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.browser-empty {
  text-align: center;
  color: #64748b;
}

.empty-title {
  font-size: 13px;
  margin-bottom: 4px;
}

.empty-desc {
  font-size: 12px;
  color: #9ca3af;
}

.terminal-output {
  width: 100%;
  height: calc(100% - 26px);
  min-height: 0;
  overflow: auto;
  border-radius: 10px;
  border: 1px solid #e4e8ef;
  background: #111827;
  padding: 12px;
  color: #e2e8f0;
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.terminal-line {
  display: flex;
  gap: 8px;
  margin-bottom: 2px;
}

.terminal-row-prefix {
  color: #60a5fa;
  flex-shrink: 0;
}

.terminal-row-text {
  min-width: 0;
}

.terminal-line.stderr {
  color: #fca5a5;
}

.terminal-line.stderr .terminal-row-prefix {
  color: #f87171;
}

.terminal-empty {
  color: #93a1b7;
}

.terminal-footer {
  height: 18px;
  display: flex;
  align-items: center;
}

.terminal-footer-status {
  font-size: 11px;
  color: #6b7280;
  letter-spacing: 0.04em;
}
</style>
