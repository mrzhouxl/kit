<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useAgentStore } from '@/stores/agent'

const auth = useAuthStore()
const agent = useAgentStore()

/** 登出 */
function handleLogout() {
  auth.logout()
  agent.$reset()
}
</script>

<template>
  <div class="settings-page">
    <h2 class="settings-title">设置</h2>

    <!-- 用户信息 -->
    <div class="settings-card">
      <div class="settings-card-label">当前用户</div>
      <div class="settings-card-value">{{ auth.isAuthenticated() ? (auth.username || '已登录') : '未登录' }}</div>
    </div>

    <!-- API 配置说明 -->
    <div class="settings-card">
      <div class="settings-card-label">API 配置</div>
      <p class="settings-card-desc">
        Agent API 地址通过 Vite 代理或环境变量 <code>VITE_API_BASE_URL</code> 配置。<br/>
        模型、API Key 等参数在 Agent 服务端 <code>.env</code> 中配置。
      </p>
    </div>

    <!-- 登出 -->
    <button
      v-if="auth.isAuthenticated()"
      class="settings-logout-btn"
      @click="handleLogout"
    >
      退出登录
    </button>
  </div>
</template>

<style scoped>
.settings-page {
  padding: 32px;
  max-width: 640px;
}

.settings-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 24px;
  color: var(--color-text);
}

.settings-card {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
}

.settings-card-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: 8px;
}

.settings-card-value {
  font-size: 15px;
  color: var(--color-text);
}

.settings-card-desc {
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.6;
}
.settings-card-desc code {
  background: #383838;
  padding: 2px 6px;
  border-radius: 4px;
  color: #f0abfc;
  font-size: 12px;
}

.settings-logout-btn {
  padding: 10px 24px;
  border-radius: 8px;
  border: 1px solid #5c2323;
  background: #2d1515;
  color: #f87171;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}
.settings-logout-btn:hover {
  background: #3d1c1c;
}
</style>
