/**
 * model.ts — Vercel AI SDK 模型实例
 * 使用 @ai-sdk/openai 的 createOpenAI，兼容所有 OpenAI 格式 API（DeepSeek、Grok 等）。
 */
import { createOpenAI } from "@ai-sdk/openai";
import { modelConfig } from "./config.js";

/**
 * deepseek — 主对话模型 provider。
 * 调用方式：deepseek("deepseek-chat")
 */
export const deepseek = createOpenAI({
  apiKey: modelConfig.apiKey,
  baseURL: modelConfig.baseURL,
});

/**
 * getChatModel — 获取默认聊天模型实例（便于统一切换）。
 * 使用 .chat() 走 /v1/chat/completions 端点，兼容 DeepSeek 等非 OpenAI 服务。
 */
export function getChatModel(): ReturnType<typeof deepseek.chat> {
  return deepseek.chat(modelConfig.chatModel);
}
