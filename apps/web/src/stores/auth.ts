import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 用户认证状态管理 */
export const useAuthStore = defineStore('auth', () => {
  /* 从 localStorage 恢复 token */
  const token = ref(localStorage.getItem('token') || '')
  const username = ref(localStorage.getItem('username') || '')

  /** 是否已登录 */
  const isAuthenticated = () => !!token.value

  /** 登录：保存 token */
  function login(jwt: string, user: string) {
    token.value = jwt
    username.value = user
    localStorage.setItem('token', jwt)
    localStorage.setItem('username', user)
  }

  /** 登出：清除 token */
  function logout() {
    token.value = ''
    username.value = ''
    localStorage.removeItem('token')
    localStorage.removeItem('username')
  }

  return { token, username, isAuthenticated, login, logout }
})
