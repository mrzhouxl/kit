<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue'
import type { ChatMessage } from '@/api/types'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = defineProps<{
  messages: ChatMessage[]
  isStreaming: boolean
  streamingContent: string
  thinkingText: string
  hasSession: boolean
}>()

const emit = defineEmits<{
  (e: 'send', content: string): void
  (e: 'stop'): void
}>()

const inputText = ref('')
const messageListRef = ref<HTMLElement | null>(null)

/** 合并展示消息（包括流式输出中的临时内容） */
const displayMessages = computed(() => {
  const msgs = [...props.messages]
  /* 流式输出中追加临时助手消息 */
  if (props.isStreaming && props.streamingContent) {
    msgs.push({
      role: 'assistant',
      content: props.streamingContent,
    })
  }
  return msgs
})

/** 是否显示欢迎页 */
const showWelcome = computed(() => {
  return displayMessages.value.length === 0 && !props.thinkingText
})

/** 发送消息 */
function handleSend() {
  const text = inputText.value.trim()
  if (!text || props.isStreaming) return
  emit('send', text)
  inputText.value = ''
  /* 重置 textarea 高度 */
  nextTick(() => {
    const textarea = document.querySelector('.chat-textarea') as HTMLTextAreaElement
    if (textarea) textarea.style.height = 'auto'
  })
}

/** Shift+Enter 换行，Enter 发送 */
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

/** 自动调整 textarea 高度 */
function handleInput(e: Event) {
  const t = e.target as HTMLTextAreaElement
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 200) + 'px'
}

/** 自动滚动到底部 */
function scrollToBottom() {
  nextTick(() => {
    if (messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight
    }
  })
}

/* 监听消息变化自动滚动 */
watch(
  () => [props.messages.length, props.streamingContent],
  () => scrollToBottom(),
)
</script>

<template>
  <div class="chat-container">
    <!-- 欢迎页：无消息时居中展示 -->
    <div v-if="showWelcome" class="welcome-area">
      <div class="welcome-content">
        <h1 class="welcome-title">准备好了，随时开始</h1>
      </div>
    </div>

    <!-- 消息列表：有消息时展示 -->
    <div v-else ref="messageListRef" class="msg-list">
      <div
        v-for="(msg, idx) in displayMessages"
        :key="idx"
        class="msg-row"
        :class="msg.role"
      >
        <div class="msg-avatar" :class="msg.role">
          {{ msg.role === 'user' ? 'U' : 'M' }}
        </div>
        <div class="msg-content">
          <div class="msg-role">{{ msg.role === 'user' ? '你' : 'Manus' }}</div>
          <div class="msg-body">
            <template v-if="msg.role === 'user'">{{ msg.content }}</template>
            <template v-else><MarkdownRenderer :content="msg.content" /></template>
          </div>
        </div>
      </div>

      <!-- 思考状态 -->
      <div v-if="isStreaming && thinkingText" class="msg-row assistant">
        <div class="msg-avatar assistant">M</div>
        <div class="msg-content">
          <div class="msg-role">Manus</div>
          <div class="thinking-bar">
            <div class="thinking-dots"><span /><span /><span /></div>
            {{ thinkingText }}
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区域（始终在底部） -->
    <div class="input-area" :class="{ centered: showWelcome }">
      <div class="input-box">
        <textarea
          v-model="inputText"
          class="chat-textarea"
          placeholder="有问题，尽管问"
          rows="1"
          :disabled="isStreaming"
          @keydown="handleKeydown"
          @input="handleInput"
        />
        <div class="input-actions">
          <button
            v-if="!isStreaming"
            class="send-icon-btn"
            :disabled="!inputText.trim()"
            @click="handleSend"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
            </svg>
          </button>
          <button
            v-else
            class="stop-icon-btn"
            @click="emit('stop')"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  position: relative;
}

/* ===== 欢迎页 ===== */
.welcome-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-content {
  text-align: center;
}
.welcome-title {
  font-size: 28px;
  font-weight: 600;
  color: var(--color-text);
}

/* ===== 消息列表 ===== */
.msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 0;
}

.msg-row {
  display: flex;
  gap: 16px;
  padding: 16px 24px;
  max-width: 768px;
  margin: 0 auto;
}

.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.msg-avatar.assistant {
  background: var(--color-primary);
  color: #fff;
}
.msg-avatar.user {
  background: #565869;
  color: #fff;
}

.msg-content {
  flex: 1;
  min-width: 0;
}

.msg-role {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--color-text);
}

.msg-body {
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-text);
  word-break: break-word;
}

/* 思考状态 */
.thinking-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 14px;
}
.thinking-dots {
  display: flex;
  gap: 4px;
}
.thinking-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: think 1.4s infinite ease-in-out;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes think {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* ===== 输入区域 ===== */
.input-area {
  flex-shrink: 0;
  padding: 16px 24px 24px;
  display: flex;
  justify-content: center;
}

.input-area.centered {
  margin-top: auto;
}


.input-box {
  width: 100%;
  max-width: 768px;
  background: var(--color-input-bg);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  display: flex;
  align-items: flex-end;
  padding: 12px 16px;
  gap: 8px;
  transition: border-color 0.15s;
}
.input-box:focus-within {
  border-color: #555;
}

.chat-textarea {
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--color-text);
  font-size: 15px;
  font-family: inherit;
  line-height: 1.5;
  min-height: 24px;
  max-height: 200px;
}
.chat-textarea::placeholder {
  color: var(--color-text-tertiary);
}

.input-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.send-icon-btn,
.stop-icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity 0.15s;
}

.send-icon-btn {
  background: #fff;
  color: #000;
}
.send-icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.stop-icon-btn {
  background: #fff;
  color: #000;
}
</style>
