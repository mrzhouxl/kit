/**
 * Agent 服务基地址解析。
 * 优先使用显式环境变量；未配置时默认走同域反代，避免线上构建回退到 localhost。
 */
export function resolveAgentBaseUrl(): string {
  const envUrl = (import.meta.env.VITE_AGENT_URL as string | undefined)?.trim()
  if (envUrl) {
    return envUrl.replace(/\/$/, '')
  }

  return '/agent-api'
}