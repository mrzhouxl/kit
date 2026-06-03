<script setup lang="ts">
import { ref } from 'vue'
import { resolveAgentBaseUrl } from '@/api/agent-base'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const agentBaseUrl = resolveAgentBaseUrl()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const errorMsg = ref('')
const mode = ref<'login' | 'register'>('login')

/** 手机号基础校验 */
function isValidPhone(value: string) {
  return /^1\d{10}$/.test(value.trim())
}

/** 执行登录请求并写入本地登录态 */
async function requestLogin() {
  if (!phone.value || !password.value) {
    errorMsg.value = '请输入手机号和密码'
    return
  }

  if (!isValidPhone(phone.value)) {
    errorMsg.value = '手机号格式不正确'
    return
  }

  loading.value = true
  errorMsg.value = ''

  try {
    /* 调用 agent-api 登录接口获取 JWT */
    const res = await fetch(`${agentBaseUrl}/api/v1/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: phone.value.trim(),
        password: password.value,
      }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      errorMsg.value = data.message || '登录失败，请检查手机号和密码'
      return
    }

    const data = await res.json()
    const token = data.token || data.data?.token

    if (!token) {
      errorMsg.value = '登录响应异常，未获取到 Token'
      return
    }

    /* 获取用户名 */
    const displayName = data.user?.nickname || data.user?.username || phone.value

    /* 保存登录状态并关闭弹框 */
    auth.login(token, displayName)
    emit('close')
  } catch {
    errorMsg.value = '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}

/** 执行注册请求，成功后自动登录 */
async function requestRegister() {
  if (!phone.value || !password.value) {
    errorMsg.value = '请输入手机号和密码'
    return
  }

  if (!isValidPhone(phone.value)) {
    errorMsg.value = '手机号格式不正确'
    return
  }

  if (password.value.length < 6) {
    errorMsg.value = '密码长度不能少于 6 位'
    return
  }

  if (password.value !== confirmPassword.value) {
    errorMsg.value = '两次输入的密码不一致'
    return
  }

  loading.value = true
  errorMsg.value = ''

  try {
    /* 调用 agent-api 注册接口写入 SQLite users 表 */
    const registerRes = await fetch(`${agentBaseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: phone.value.trim(),
        password: password.value,
      }),
    })

    if (!registerRes.ok) {
      const data = await registerRes.json().catch(() => ({}))
      errorMsg.value = data.message || '注册失败，请稍后重试'
      return
    }

    /* 注册成功后自动登录，保持当前交互闭环 */
    const loginRes = await fetch(`${agentBaseUrl}/api/v1/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: phone.value.trim(),
        password: password.value,
      }),
    })

    if (!loginRes.ok) {
      const data = await loginRes.json().catch(() => ({}))
      errorMsg.value = data.message || '注册成功，但自动登录失败，请手动登录'
      mode.value = 'login'
      return
    }

    const data = await loginRes.json()
    const token = data.token || data.data?.token
    if (!token) {
      errorMsg.value = '注册成功，但登录响应异常，请手动登录'
      mode.value = 'login'
      return
    }

    const displayName = data.user?.nickname || data.user?.username || phone.value
    auth.login(token, displayName)
    emit('close')
  } catch {
    errorMsg.value = '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}

/** 提交：根据当前模式分发登录或注册 */
function handleSubmit() {
  if (mode.value === 'register') {
    void requestRegister()
    return
  }
  void requestLogin()
}

/** 切换登录/注册模式 */
function switchMode(nextMode: 'login' | 'register') {
  if (mode.value === nextMode) return
  mode.value = nextMode
  errorMsg.value = ''
  password.value = ''
  confirmPassword.value = ''
}

/** 回车提交 */
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') handleSubmit()
}

/** 关闭弹框 */
function handleClose() {
  emit('close')
}
</script>

<template>
  <!-- 登录弹框（Dialog 组件） -->
  <t-dialog
    :visible="true"
    :header="false"
    :footer="false"
    :close-btn="false"
    :close-on-overlay-click="true"
    width="460px"
    dialog-class-name="login-dialog-shell"
    @close="handleClose"
  >
    <div class="login-card">
      <button class="login-close-btn" type="button" aria-label="关闭登录弹窗" @click="handleClose">
        ×
      </button>

      <!-- 标题 -->
      <div class="login-dialog-header">
        <div class="login-dialog-logo">Manus</div>
        <p class="login-dialog-subtitle">
          {{ mode === 'login' ? '登录以开始使用 AI Agent' : '注册后即可开始使用 AI Agent' }}
        </p>
      </div>

      <!-- 模式切换 -->
      <div class="login-mode-switch" role="tablist" aria-label="登录注册切换">
        <button
          type="button"
          class="login-mode-btn"
          :class="{ active: mode === 'login' }"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="login-mode-btn"
          :class="{ active: mode === 'register' }"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>

      <!-- 表单 -->
      <div class="login-dialog-form">
        <div class="login-field">
          <label>手机号</label>
          <input
            v-model="phone"
            type="tel"
            placeholder="请输入手机号"
            autocomplete="tel"
            @keydown="handleKeydown"
          />
        </div>

        <div class="login-field">
          <label>密码</label>
          <input
            v-model="password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            @keydown="handleKeydown"
          />
        </div>

        <div v-if="mode === 'register'" class="login-field">
          <label>确认密码</label>
          <input
            v-model="confirmPassword"
            type="password"
            placeholder="请再次输入密码"
            autocomplete="new-password"
            @keydown="handleKeydown"
          />
        </div>

        <!-- 错误提示 -->
        <p v-if="errorMsg" class="login-error-msg">{{ errorMsg }}</p>

        <!-- 提交按钮 -->
        <button class="login-submit-btn" :disabled="loading" @click="handleSubmit">
          {{ loading ? (mode === 'login' ? '登录中...' : '注册中...') : (mode === 'login' ? '登 录' : '注 册') }}
        </button>
      </div>
    </div>
  </t-dialog>
</template>

<style scoped>
:global(.login-dialog-shell) {
  --login-shell-border: rgba(255, 255, 255, 0.08);
  --login-shell-bg: linear-gradient(165deg, #1f232d 0%, #171b24 100%);
  --login-shell-shadow: 0 26px 80px rgba(0, 0, 0, 0.42);
  --login-text-primary: #ececec;
  --login-text-secondary: #8e8ea0;
  --login-close-color: #9aa4b2;
  --login-close-hover-color: #e5eaf0;
  --login-close-hover-bg: rgba(255, 255, 255, 0.08);
  --login-input-bg: #303030;
  --login-input-border: #555;
  --login-input-placeholder: #6e6e80;
  --login-focus: #10a37f;
  --login-primary-btn: #10a37f;
  --login-primary-btn-hover: #0d8a6c;
  --login-segment-bg: rgba(255, 255, 255, 0.06);
  --login-segment-border: rgba(255, 255, 255, 0.08);
  --login-segment-text: #a8afbe;
  --login-segment-active-bg: rgba(16, 163, 127, 0.2);
  --login-segment-active-border: rgba(16, 163, 127, 0.5);
  --login-segment-active-text: #dcfff6;
  border-radius: 20px;
  border: 1px solid var(--login-shell-border);
  background: var(--login-shell-bg);
  box-shadow: var(--login-shell-shadow);
}

:global(html.theme-light .login-dialog-shell) {
  --login-shell-border: rgba(44, 62, 80, 0.15);
  --login-shell-bg: linear-gradient(165deg, #ffffff 0%, #f7f9fc 100%);
  --login-shell-shadow: 0 22px 56px rgba(15, 23, 42, 0.15);
  --login-text-primary: #1f2a37;
  --login-text-secondary: #5f6c80;
  --login-close-color: #6b7280;
  --login-close-hover-color: #1f2937;
  --login-close-hover-bg: rgba(15, 23, 42, 0.06);
  --login-input-bg: #ffffff;
  --login-input-border: #d8dee9;
  --login-input-placeholder: #94a3b8;
  --login-focus: #0f9f7d;
  --login-primary-btn: #0fa37f;
  --login-primary-btn-hover: #0c8b6c;
  --login-segment-bg: rgba(15, 23, 42, 0.04);
  --login-segment-border: rgba(15, 23, 42, 0.12);
  --login-segment-text: #64748b;
  --login-segment-active-bg: rgba(15, 163, 127, 0.14);
  --login-segment-active-border: rgba(15, 163, 127, 0.35);
  --login-segment-active-text: #0a5b46;
}

:global(.login-dialog-shell .t-dialog__body) {
  padding: 0;
}

.login-card {
  position: relative;
  padding: 28px 28px 24px;
}

.login-close-btn {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--login-close-color);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.18s ease;
}

.login-close-btn:hover {
  color: var(--login-close-hover-color);
  background: var(--login-close-hover-bg);
}

.login-dialog-header {
  text-align: center;
  margin-bottom: 24px;
}

.login-dialog-logo {
  font-size: 28px;
  font-weight: 700;
  color: var(--login-text-primary);
  margin-bottom: 8px;
}

.login-dialog-subtitle {
  color: var(--login-text-secondary);
  font-size: 14px;
}

.login-mode-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 16px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--login-segment-border);
  background: var(--login-segment-bg);
}

.login-mode-btn {
  height: 34px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--login-segment-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s ease;
}

.login-mode-btn.active {
  color: var(--login-segment-active-text);
  border-color: var(--login-segment-active-border);
  background: var(--login-segment-active-bg);
}

.login-dialog-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.login-field label {
  font-size: 13px;
  font-weight: 500;
  color: var(--login-text-secondary);
}

.login-field input {
  height: 44px;
  border: 1px solid var(--login-input-border);
  border-radius: 10px;
  padding: 0 14px;
  font-size: 14px;
  outline: none;
  background: var(--login-input-bg);
  color: var(--login-text-primary);
  transition: border-color 0.15s;
}

.login-field input:focus {
  border-color: var(--login-focus);
}

.login-field input::placeholder {
  color: var(--login-input-placeholder);
}

.login-submit-btn {
  height: 44px;
  border: none;
  border-radius: 10px;
  background: var(--login-primary-btn);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  margin-top: 4px;
}

.login-submit-btn:hover {
  background: var(--login-primary-btn-hover);
}

.login-submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-error-msg {
  color: #ef4444;
  font-size: 13px;
  text-align: center;
}

@media (max-width: 640px) {
  .login-card {
    padding: 24px 16px 18px;
  }

  .login-dialog-logo {
    font-size: 24px;
  }
}
</style>
