/**
 * graph/index.ts — LangGraph 多 Agent 图组装 & 导出
 *
 * 核心架构（Supervisor 模式）：
 *
 *   START → supervisor ──┬── web_agent     ──┐
 *                        ├── code_agent    ──┤
 *                        ├── image_agent   ──┤
 *                        └── FINISH ────────┘
 *                             ↑              │
 *                             └──────────────┘
 *
 * 执行流程：
 * 1. 消息进入 Supervisor
 * 2. Supervisor 分析并路由到合适的 Worker Agent（或 FINISH）
 * 3. Worker Agent 处理任务并返回结果
 * 4. 控制回到 Supervisor，决定是否继续分发或结束
 *
 * 扩展方式：
 * - 新增 Agent：在 agents.ts 中定义节点，在此文件中 addNode + addEdge
 * - 新增工具：在 tools.ts 中添加适配，分配到对应 Agent 的工具集
 */
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  BaseMessage,
} from "@langchain/core/messages";
import { resolve } from "node:path";
import { databaseConfig } from "../config.js";
import { AgentState } from "./state.js";
import {
  webAgentNode,
  codeAgentNode,
  imageAgentNode,
  AGENT_NAMES,
} from "./agents.js";
import { supervisorNode, routeFromSupervisor } from "./supervisor.js";
import { buildMultimodalHumanMessage } from "./message-utils.js";

// ── 消息转换工具 ─────────────────────────────────────────────

import type { VercelMessage } from "../chat/request-messages.js";

/**
 * 将前端发来的 Vercel AI SDK 格式消息转换为 LangChain BaseMessage。
 * 支持 user/assistant/system 三种角色。
 * 对 user 角色消息自动检测图片 URL 并构建多模态内容（文本+图片），
 * 使视觉模型能够识别和理解用户上传的图片。
 */
export function convertMessages(messages: VercelMessage[]): BaseMessage[] {
  return messages.map((msg) => {
    // content 可能是 string 或 ContentPart[]，统一转为 string
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);

    switch (msg.role) {
      case "user":
        // 用户消息自动检测图片 URL，构建多模态消息
        return buildMultimodalHumanMessage(content);
      case "assistant":
        return new AIMessage(content);
      case "system":
        return new SystemMessage(content);
      default:
        return buildMultimodalHumanMessage(content);
    }
  });
}

// ── 图构建 ───────────────────────────────────────────────────

/**
 * 构建并编译多 Agent 状态图。
 */
function buildGraph() {
  const graph = new StateGraph(AgentState)
    // ── 添加节点 ──
    .addNode("supervisor", supervisorNode)
    .addNode("web_agent", webAgentNode)
    .addNode("code_agent", codeAgentNode)
    .addNode("image_agent", imageAgentNode)

    // ── 入口边：从 START 进入 Supervisor ──
    .addEdge(START, "supervisor")

    // ── 条件路由：Supervisor → Worker Agent 或 END ──
    .addConditionalEdges("supervisor", routeFromSupervisor, {
      web_agent: "web_agent",
      code_agent: "code_agent",
      image_agent: "image_agent",
      FINISH: END,
    })

    // ── 回流边：Worker Agent 完成后回到 Supervisor ──
    .addEdge("web_agent", "supervisor")
    .addEdge("code_agent", "supervisor")
    .addEdge("image_agent", "supervisor");

  return graph;
}

/** 编译后的图实例（延迟初始化） */
let compiledGraphInstance: ReturnType<ReturnType<typeof buildGraph>["compile"]> | null = null;
/** SQLite Checkpointer 文件路径（复用 SQLite 数据库文件）。 */
const sqliteCheckpointPath = resolve(process.cwd(), databaseConfig.sqlitePath);

/**
 * 初始化 checkpointer 并编译图。
 * 必须在服务启动时调用一次。
 */
export async function initGraph(): Promise<void> {
  if (compiledGraphInstance) return;

  try {
    const checkpointer = SqliteSaver.fromConnString(sqliteCheckpointPath);
    compiledGraphInstance = buildGraph().compile({ checkpointer });
    console.log(`[LangGraph] 已启用 SQLite Checkpointer: ${sqliteCheckpointPath}`);
  } catch (err) {
    // SQLite checkpointer 初始化失败时，兜底到内存模式以保证服务可启动。
    const fallback = new MemorySaver();
    compiledGraphInstance = buildGraph().compile({ checkpointer: fallback });
    console.warn(
      "[LangGraph] SQLite Checkpointer 初始化失败，降级到 MemorySaver:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * 获取已编译的多 Agent 图实例。
 * 需要先调用 initGraph() 完成初始化。
 */
export function getCompiledGraph() {
  if (!compiledGraphInstance) {
    throw new Error("[LangGraph] 图尚未初始化，请先调用 initGraph()");
  }
  return compiledGraphInstance;
}

// ── 类型导出 ─────────────────────────────────────────────────

export type { AgentStateType } from "./state.js";
export { AGENT_NAMES } from "./agents.js";
