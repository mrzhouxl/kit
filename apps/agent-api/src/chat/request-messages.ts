/** 前端消息格式（兼容 Vercel AI SDK）。 */
export interface VercelMessage {
  role: string;
  content: string | unknown[];
}

/**
 * 为 LangGraph 选择本次请求真正需要注入的消息。
 *
 * 规则：
 * - 新会话 / 无持久历史时：保留前端完整消息列表
 * - 已有持久会话时：只追加本轮最新用户消息，避免与 checkpoint 历史重复堆叠
 */
export function selectGraphInputMessages(
  messages: VercelMessage[],
  hasPersistedConversation: boolean,
): VercelMessage[] {
  if (!hasPersistedConversation) {
    return messages;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return [message];
    }
  }

  const lastMessage = messages[messages.length - 1];
  return lastMessage ? [lastMessage] : [];
}