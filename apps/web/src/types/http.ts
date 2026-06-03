export interface ApiResponse<T = unknown> {
  code: number
  msg?: string
  message?: string
  data: T
}
