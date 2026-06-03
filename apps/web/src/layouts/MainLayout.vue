<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAgentStore } from '@/stores/agent'
import { AUTH_REQUIRED_EVENT } from '@/api/request'
import LoginView from '@/views/login/LoginView.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const agent = useAgentStore()

/* 登录弹框状态 */
const showLogin = ref(false)

/* 侧边栏收折（持久化） */
const sidebarOpen = ref(localStorage.getItem('ai-comics-sidebar-open') !== '0')

watch(sidebarOpen, (open) => {
  localStorage.setItem('ai-comics-sidebar-open', open ? '1' : '0')
})

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

/** 鉴权失效事件：弹出登录框 */
function handleAuthRequiredEvent() {
  showLogin.value = true
}

/* 页面加载时拉取会话列表 */
onMounted(() => {
  if (auth.isAuthenticated()) {
    agent.loadSessions()
  }
  window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequiredEvent)
})

onUnmounted(() => {
  window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequiredEvent)
})

/** 打开登录弹框 */
function openLogin() {
  showLogin.value = true
}

/** 登录成功关闭弹框 */
function onLoginClose() {
  showLogin.value = false
  agent.loadSessions()
}

/** 登出 */
function handleLogout() {
  auth.logout()
  agent.$reset()
}

/** 选中会话 */
async function handleSelectSession(id: number) {
  await agent.selectSession(id)
  /* 确保在 Agent 页 */
  if (route.path !== '/agent') {
    router.push('/agent')
  }
}

/** 新建会话 */
async function handleNewSession() {
  if (!auth.isAuthenticated()) {
    openLogin()
    return
  }
  await agent.newSession()
  if (route.path !== '/agent') {
    router.push('/agent')
  }
}

/** 删除会话 */
async function handleDeleteSession(id: number) {
  await agent.removeSession(id)
}

/** 导航 */
function navigateTo(path: string) {
  router.push(path)
}

const isAgentRoute = computed(() => route.path === '/agent')
</script>

<template>
  <div class="main-layout">
    <!-- 左侧侧边栏 -->
    <aside v-if="!isAgentRoute" class="sidebar" :class="{ collapsed: !sidebarOpen }">
      <!-- 侧边栏头部 -->
      <div class="sidebar-top">
        <button class="sidebar-toggle" @click="toggleSidebar" title="收起侧边栏">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <button class="new-chat-btn" @click="handleNewSession" title="新聊天">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <!-- 导航菜单 -->
      <nav class="sidebar-nav" v-if="sidebarOpen">
        <button
          class="nav-btn"
          :class="{ active: route.path === '/agent' }"
          @click="navigateTo('/agent')"
        >
          <span class="nav-icon">💬</span>
          <span>Agent 对话</span>
        </button>
        <button
          class="nav-btn"
          :class="{ active: route.path === '/settings' }"
          @click="navigateTo('/settings')"
        >
          <span class="nav-icon">⚙️</span>
          <span>设置</span>
        </button>
      </nav>

      <!-- 会话列表 -->
      <div class="session-section" v-if="sidebarOpen">
        <div class="session-section-title">最近</div>
        <div class="session-scroll">
          <button
            v-for="session in agent.sessions"
            :key="session.id"
            class="session-btn"
            :class="{ active: session.id === agent.currentSessionId }"
            @click="handleSelectSession(session.id)"
          >
            <span class="session-title">{{ session.title || '新对话' }}</span>
            <span
              class="session-delete"
              @click.stop="handleDeleteSession(session.id)"
              title="删除"
            >✕</span>
          </button>
          <div v-if="agent.sessions.length === 0" class="session-empty">
            暂无对话记录
          </div>
        </div>
      </div>

      <!-- 底部用户区 -->
      <div class="sidebar-bottom" v-if="sidebarOpen">
        <template v-if="auth.isAuthenticated()">
          <div class="user-info">
            <div class="user-avatar">{{ (auth.username || 'U').charAt(0).toUpperCase() }}</div>
            <span class="user-name">{{ auth.username || '用户' }}</span>
          </div>
          <button class="logout-btn" @click="handleLogout" title="登出">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </template>
        <template v-else>
          <button class="login-trigger-btn" @click="openLogin">
            登录
          </button>
        </template>
      </div>
    </aside>

    <!-- 收起状态下的展开按钮 -->
    <button v-if="!isAgentRoute && !sidebarOpen" class="sidebar-expand" @click="toggleSidebar">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    </button>

    <!-- 主内容区 -->
    <main class="main-content">
      <router-view />
    </main>

    <!-- 登录弹框 -->
    <LoginView v-if="showLogin" @close="onLoginClose" />
  </div>
</template>

<style scoped>
.main-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
  position: relative;
}

/* ===== 侧边栏 ===== */
.sidebar {
  width: 260px;
  min-width: 260px;
  background: var(--color-sidebar);
  display: flex;
  flex-direction: column;
  transition: width 0.2s, min-width 0.2s;
  overflow: hidden;
}
.sidebar.collapsed {
  width: 0;
  min-width: 0;
  border: none;
}

.sidebar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 8px;
}

.sidebar-toggle,
.new-chat-btn {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.sidebar-toggle:hover,
.new-chat-btn:hover {
  background: var(--color-sidebar-hover);
  color: var(--color-text);
}

/* 导航按钮 */
.sidebar-nav {
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background 0.15s, color 0.15s;
}
.nav-btn:hover {
  background: var(--color-sidebar-hover);
  color: var(--color-text);
}
.nav-btn.active {
  background: var(--color-sidebar-active);
  color: var(--color-text);
}

.nav-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

/* 会话列表 */
.session-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 8px;
  margin-top: 8px;
}

.session-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  padding: 8px 12px 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.session-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.session-btn {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background 0.15s, color 0.15s;
  position: relative;
}
.session-btn:hover {
  background: var(--color-sidebar-hover);
  color: var(--color-text);
}
.session-btn.active {
  background: var(--color-sidebar-active);
  color: var(--color-text);
}

.session-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-delete {
  opacity: 0;
  font-size: 12px;
  padding: 2px 4px;
  color: var(--color-text-tertiary);
  transition: opacity 0.15s;
}
.session-btn:hover .session-delete {
  opacity: 1;
}
.session-delete:hover {
  color: #f87171;
}

.session-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-tertiary);
}

/* 底部用户区 */
.sidebar-bottom {
  padding: 12px;
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.user-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.user-name {
  font-size: 14px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s;
  flex-shrink: 0;
}
.logout-btn:hover {
  color: #f87171;
}

.login-trigger-btn {
  width: 100%;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}
.login-trigger-btn:hover {
  background: var(--color-sidebar-hover);
}

/* 展开按钮（侧边栏收起时） */
.sidebar-expand {
  position: absolute;
  top: 12px;
  left: 12px;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  transition: background 0.15s, color 0.15s;
}
.sidebar-expand:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

/* 主内容区 */
.main-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}
</style>
