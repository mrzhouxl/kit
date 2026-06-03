/**
 * graph/llm.ts — LangChain 模型提供者
 *
 * 使用 @langchain/openai 的 ChatOpenAI，兼容 DeepSeek 等 OpenAI 格式 API。
 * 提供工厂函数，方便按需创建不同配置的模型实例。
 */
import { ChatOpenAI } from "@langchain/openai";
import { modelConfig } from "../config.js";

/** 模型创建选项 */
interface ChatModelOptions {
  /** 温度参数，默认 0（确定性输出） */
  temperature?: number;
  /** 最大生成 Token 数 */
  maxTokens?: number;
  /** 模型名称，默认使用配置中的 chatModel */
  modelName?: string;
  /** 是否启用流式输出，默认 true。 */
  streaming?: boolean;
}

/**
 * 创建 LangChain ChatOpenAI 实例。
 * 配置为 DeepSeek（OpenAI 兼容端点），支持 function calling 和流式输出。
 */
export function createChatModel(options?: ChatModelOptions): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: modelConfig.apiKey,
    configuration: {
      baseURL: modelConfig.baseURL,
    },
    modelName: options?.modelName ?? modelConfig.chatModel,
    temperature: options?.temperature ?? 0,
    maxTokens: options?.maxTokens,
    streaming: options?.streaming ?? true,
    modelKwargs: {
      thinking: { type: "disabled" },
    },
  });
}

export function createSupervisorModel(
  options?: Omit<ChatModelOptions, "temperature">,
): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: modelConfig.apiKey,
    configuration: {
      baseURL: modelConfig.baseURL,
    },
    modelName: "deepseek-v4-pro",
    temperature: 0,
    maxTokens: options?.maxTokens,
    streaming: options?.streaming ?? true,
    modelKwargs: {
      thinking: { type: "disabled" },
    },
  });
}

/** 默认聊天模型实例（供 Worker Agent 使用） */
export const chatModel = createChatModel();

/** Supervisor 专用模型（温度 0，确保路由稳定） */
export const supervisorModel = createSupervisorModel();
// export const supervisorModel = createChatModel({ temperature: 0 });
