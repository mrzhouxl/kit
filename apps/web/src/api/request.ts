import axios from 'axios'
import type { ApiResponse } from '@/types/http'

/** 全局鉴权失效事件，供布局层弹出登录框 */
export const AUTH_REQUIRED_EVENT = 'ai-comics:auth-required'

export const redirectToLogin = () => {
  /* 清理本地登录态，避免继续携带失效凭证 */
  localStorage.removeItem('token')
  localStorage.removeItem('username')
  /* 通知界面层打开登录弹窗（当前项目无 /login 独立路由） */
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
}

const service = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 10000,
})

service.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

service.interceptors.response.use(
  (response) => {
    const payload = response.data as ApiResponse
    if (payload?.code === 401) {
      redirectToLogin()
      const message = payload?.msg || payload?.message || '登录已失效，请重新登录'
      return Promise.reject(new Error(message))
    }

    if (typeof payload?.code === 'number' && payload.code !== 0) {
      const message = payload?.msg || payload?.message || '请求失败'
      return Promise.reject(new Error(message))
    }
    if (typeof payload?.code === 'number') {
      return payload?.data
    }

    return response.data
  },
  (error) => {
    if (error?.response?.status === 401) {
      redirectToLogin()
    }

    const message =
      error?.response?.data?.msg ||
      error?.response?.data?.message ||
      error?.message ||
      '网络错误'
    return Promise.reject(new Error(message))
  },
)

export default service
