/**
 * graph/state.ts — LangGraph 图状态定义
 *
 * 使用 LangGraph Annotation API 定义类型安全的图状态。
 * 状态在 Supervisor 和 Worker Agent 节点之间共享。
 */
import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { createEmptyTaskState, type SupervisorTaskState } from "./supervisor-policy.js";

/**
 * AgentState — 多 Agent 图的共享状态。
 *
 * - messages: 对话消息历史（自动追加合并）
 * - next:     Supervisor 的路由决策（下一个要执行的节点名）
 * - task:     当前轮的显式任务状态
 */
export const AgentState = Annotation.Root({
  /** 对话消息列表，使用追加式 reducer */
  messages: Annotation<BaseMessage[]>({
    reducer: (current, incoming) => current.concat(incoming),
    default: () => [],
  }),

  /** Supervisor 路由目标：agent 节点名 或 "FINISH" */
  next: Annotation<string>({
    reducer: (_current, incoming) => incoming,
    default: () => "",
  }),

  /** Supervisor 显式任务状态：意图、完成 agent、下一步目标等 */
  task: Annotation<SupervisorTaskState>({
    reducer: (_current, incoming) => incoming,
    default: createEmptyTaskState,
  }),
});

/** AgentState 的类型别名，方便在节点函数中使用 */
export type AgentStateType = typeof AgentState.State;
