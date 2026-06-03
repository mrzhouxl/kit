import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getBalance } from '@/api/modules/billing'

type ThemeMode = 'dark' | 'light'

export const useAppStore = defineStore('app', () => {
  const appName = ref('轻灵AI')
  const requestCount = ref(0)
  const theme = ref<ThemeMode>('dark')

  // 积分余额状态
  const credits = ref(0)
  const frozenCredits = ref(0)

  const applyTheme = (mode: ThemeMode) => {
    theme.value = mode
    localStorage.setItem('theme', mode)
    document.documentElement.classList.toggle('theme-dark', mode === 'dark')
    document.documentElement.classList.toggle('theme-light', mode === 'light')
    // TDesign Vue Next 暗黑模式：需要 :root.dark 或 :root[theme-mode='dark']
    document.documentElement.classList.toggle('dark', mode === 'dark')
    document.documentElement.setAttribute('theme-mode', mode)
  }

  const initTheme = () => {
    const savedTheme = localStorage.getItem('theme') as ThemeMode | null
    if (savedTheme === 'dark' || savedTheme === 'light') {
      applyTheme(savedTheme)
      return
    }

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    applyTheme(prefersDark ? 'dark' : 'light')
  }

  const toggleTheme = () => {
    applyTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  const startRequest = () => {
    requestCount.value += 1
  }

  const endRequest = () => {
    requestCount.value = Math.max(0, requestCount.value - 1)
  }

  /** 拉取最新积分余额 */
  const fetchBalance = async () => {
    try {
      const res = await getBalance()
      credits.value = res.credits ?? 0
      frozenCredits.value = res.frozen_credits ?? 0
    } catch {
      // 静默失败，不影响主流程
    }
  }

  return {
    appName,
    requestCount,
    theme,
    credits,
    frozenCredits,
    startRequest,
    endRequest,
    initTheme,
    toggleTheme,
    fetchBalance,
  }
})
