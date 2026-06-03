/** 单次 Agent 请求最多允许消耗的 token 数。 */
export const MAX_REQUEST_TOTAL_TOKENS = 200_000;

/** 单次 Agent 请求最多允许触发的模型调用次数。 */
export const MAX_REQUEST_MODEL_CALLS = 24;

/** 单次 Agent 请求允许的最大图递归步数。 */
export const MAX_REQUEST_RECURSION_LIMIT = 60;

/** 解析并钳制单次请求允许的最大步数。 */
export function resolveRequestRecursionLimit(maxSteps?: number): number {
  if (!Number.isFinite(maxSteps) || !maxSteps || maxSteps <= 0) {
    return MAX_REQUEST_RECURSION_LIMIT;
  }

  return Math.min(Math.floor(maxSteps), MAX_REQUEST_RECURSION_LIMIT);
}

/** 判断单次请求是否已经触发 token 熔断阈值。 */
export function isRequestTokenBudgetExceeded(
  totalTokens: number,
  limit: number = MAX_REQUEST_TOTAL_TOKENS,
): boolean {
  return totalTokens >= limit;
}

/** 判断单次请求是否已经触发模型调用次数阈值。 */
export function isRequestModelCallLimitExceeded(
  callCount: number,
  limit: number = MAX_REQUEST_MODEL_CALLS,
): boolean {
  return callCount >= limit;
}

/** 构造单次请求 token 超限提示。 */
export function buildRequestTokenLimitMessage(
  totalTokens: number,
  limit: number = MAX_REQUEST_TOTAL_TOKENS,
): string {
  return `本次请求已消耗 ${totalTokens.toLocaleString("zh-CN")} / ${limit.toLocaleString("zh-CN")} tokens，已触发异常保护并自动停止，避免重复执行持续消耗。`;
}

/** 构造单次请求模型调用次数超限提示。 */
export function buildRequestModelCallLimitMessage(
  callCount: number,
  limit: number = MAX_REQUEST_MODEL_CALLS,
): string {
  return `本次请求已触发 ${callCount.toLocaleString("zh-CN")} / ${limit.toLocaleString("zh-CN")} 次模型调用，疑似进入重复执行，已自动停止。`;
}