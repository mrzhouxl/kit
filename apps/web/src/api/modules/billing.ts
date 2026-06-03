import request from '@/api/request'

/** 余额信息 */
export interface BalanceInfo {
  credits: number
  frozen_credits: number
}

/** 订单记录 */
export interface OrderRecord {
  id: number
  user_id: number
  task_type: string
  task_id: number
  model: string
  credits: number
  status: number
  remark: string
  settled_at: string | null
  created_at: string
}

/** 订单列表分页响应 */
export interface OrderPageData {
  list: OrderRecord[]
  total: number
  page: number
  size: number
}

/** 获取当前用户积分余额 */
export const getBalance = () =>
  request.get<BalanceInfo, BalanceInfo>('/v1/billing/balance')

/** 获取当前用户订单列表 */
export const getOrders = (params?: {
  page?: number
  page_size?: number
  task_type?: string
  status?: number
}) => request.get<OrderPageData, OrderPageData>('/v1/billing/orders', { params })

/** 管理员给用户充值积分 */
export const rechargeUser = (data: {
  user_id: number
  credits: number
  remark?: string
}) => request.post('/v1/billing/recharge', data)
