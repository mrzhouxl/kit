<script setup lang="ts">
import type { Session } from '@/api/types'

defineProps<{
  sessions: Session[]
  currentId: number | null
}>()

const emit = defineEmits<{
  (e: 'select', id: number): void
  (e: 'create'): void
  (e: 'delete', id: number): void
}>()
</script>

<template>
  <div class="session-sidebar">
    <!-- 头部 -->
    <div class="session-sidebar-header">
      <h2>对话</h2>
      <button class="new-session-btn" @click="emit('create')">
        ＋ 新建
      </button>
    </div>

    <!-- 会话列表 -->
    <div class="session-list">
      <div
        v-for="session in sessions"
        :key="session.id"
        class="session-item"
        :class="{ active: session.id === currentId }"
        @click="emit('select', session.id)"
      >
        <span class="session-item-title">
          {{ session.title || '新对话' }}
        </span>
        <button
          class="session-item-delete"
          title="删除"
          @click.stop="emit('delete', session.id)"
        >
          ✕
        </button>
      </div>

      <!-- 空状态 -->
      <div v-if="sessions.length === 0" style="padding: 24px; text-align: center; color: rgba(255,255,255,0.4); font-size: 13px;">
        暂无对话，点击上方新建
      </div>
    </div>
  </div>
</template>
