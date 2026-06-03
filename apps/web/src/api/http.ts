import axios from 'axios'

/** API 基础地址，从环境变量读取 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'

/** 创建 axios 实例 */
const http = axios.create({
  baseURL: `${API_BASE}/api`,
  timeout: 30000,
})

/** 请求拦截：注入 JWT Token */
http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

/** 响应拦截：统一错误处理 */
http.interceptors.response.use(
  (res) => res,
  (err) => {
    /* 401 跳转登录 */
    if (err.response?.status === 401) {
      localStorage.removeItem('token')
      window.location.hash = '#/login'
    }
    return Promise.reject(err)
  },
)

export default http
