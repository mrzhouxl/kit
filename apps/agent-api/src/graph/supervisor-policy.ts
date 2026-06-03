import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { AGENT_NAMES, type AgentName } from "./agent-names.js";
import { getMessageName, getMessageText } from "./message-utils.js";

export type IntentCategory =
  | "casual_chat"
  | "knowledge_question"
  | "web_task"
  | "coding_task"
  | "image_task"
  | "document_task"
  | "file_analysis_task"
  | "unknown";

export type TaskStatus =
  | "idle"
  | "awaiting_routing"
  | "worker_running"
  | "worker_completed"
  | "ready_to_finish"
  | "direct_response";

export interface SupervisorTaskState {
  taskId: string;
  intent: IntentCategory;
  status: TaskStatus;
  currentAgent: AgentName | null;
  nextAgent: AgentName | "FINISH" | null;
  completedAgents: AgentName[];
  directResponseAllowed: boolean;
  lastWorkerFailed: boolean;
}

const AGENT_SET = new Set<string>(AGENT_NAMES);

function isWorkerAgentName(name: string | undefined): name is AgentName {
  return Boolean(name && AGENT_SET.has(name));
}

function classifyIntent(text: string): IntentCategory {
  const normalizedText = text.toLowerCase();

  if (!normalizedText.trim()) {
    return "unknown";
  }

  if (/(你好|hello|hi|谢谢|感谢|再见|早上好|晚上好)/i.test(text)) {
    return "casual_chat";
  }

  if (/(画一张|画个|画一幅|绘制|生成图片|出图|海报|插画|原画|参考图|以图生图|生成.*视频|做.*视频|制作.*视频|创建.*视频|视频生成|动态视频|视频短片|短视频|动画|镜头动画|运镜|让图片动起来|把图片做成视频)/i.test(text)) {
    return "image_task";
  }

  if (/(搜索|查询|浏览|打开网站|网页|官网|查一下|搜一下|资料|新闻|机票|火车票)/i.test(text)) {
    return "web_task";
  }

  if (/(ppt|word|excel|pdf|文档|表格|演示文稿)/i.test(text)) {
    return "document_task";
  }

  if (/(解析文件|分析附件|读取附件|提取文件内容)/i.test(text)) {
    return "file_analysis_task";
  }

  if (/(代码|脚本|程序|修复|重构|实现|生成文件|裁剪|缩放|压缩|转格式|水印|png|jpg|webp)/i.test(text)) {
    return "coding_task";
  }

  return "knowledge_question";
}

function pickNextAgent(intent: IntentCategory): AgentName | null {
  switch (intent) {
    case "web_task":
      return "web_agent";
    case "coding_task":
    case "document_task":
    case "file_analysis_task":
      return "code_agent";
    case "image_task":
      return "image_agent";
    default:
      return null;
  }
}

function buildTaskId(text: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim() || "idle";
  let hash = 0;
  for (const char of normalizedText.slice(0, 80)) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000000;
  }
  return `task_${hash.toString().padStart(6, "0")}`;
}

function getLatestUserText(messages: BaseMessage[]): string {
  const latestUserIndex = findLatestUserMessageIndex(messages);
  if (latestUserIndex === -1) {
    return "";
  }
  return getMessageText(messages[latestUserIndex]);
}

function findLatestUserMessageIndex(messages: BaseMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof HumanMessage && !getMessageName(message)) {
      return index;
    }
  }
  return -1;
}

export function createEmptyTaskState(): SupervisorTaskState {
  return {
    taskId: "task_idle",
    intent: "unknown",
    status: "idle",
    currentAgent: null,
    nextAgent: null,
    completedAgents: [],
    directResponseAllowed: true,
    lastWorkerFailed: false,
  };
}

export function getDirectResponsePolicy(intent: IntentCategory): boolean {
  return intent === "casual_chat" || intent === "knowledge_question" || intent === "unknown";
}

export function deriveTaskStateFromMessages(messages: BaseMessage[]): SupervisorTaskState {
  const latestUserIndex = findLatestUserMessageIndex(messages);
  const latestUserText = getLatestUserText(messages);
  const intent = classifyIntent(latestUserText);
  const completedAgents: AgentName[] = [];
  let currentAgent: AgentName | null = null;
  let lastWorkerFailed = false;

  const currentTurnMessages = latestUserIndex === -1 ? [] : messages.slice(latestUserIndex + 1);

  for (const message of currentTurnMessages) {
    const messageName = getMessageName(message);
    if (!isWorkerAgentName(messageName)) {
      continue;
    }

    currentAgent = messageName;
    lastWorkerFailed = /执行失败|error|失败/i.test(getMessageText(message));
    if (!completedAgents.includes(messageName)) {
      completedAgents.push(messageName);
    }
  }

  const directResponseAllowed = getDirectResponsePolicy(intent);
  const preferredAgent = pickNextAgent(intent);

  if (!latestUserText) {
    return createEmptyTaskState();
  }

  if (currentAgent) {
    return {
      taskId: buildTaskId(latestUserText),
      intent,
      status: "worker_completed",
      currentAgent,
      nextAgent: "FINISH",
      completedAgents,
      directResponseAllowed,
      lastWorkerFailed,
    };
  }

  return {
    taskId: buildTaskId(latestUserText),
    intent,
    status: directResponseAllowed ? "direct_response" : "awaiting_routing",
    currentAgent: null,
    nextAgent: preferredAgent,
    completedAgents,
    directResponseAllowed,
    lastWorkerFailed,
  };
}

export function shouldFinishCurrentTurn(taskState: SupervisorTaskState): boolean {
  return taskState.status === "worker_completed" && !taskState.lastWorkerFailed;
}

export function applySupervisorDecision(
  taskState: SupervisorTaskState,
  next: AgentName | "FINISH",
): SupervisorTaskState {
  if (next === "FINISH") {
    return {
      ...taskState,
      status: taskState.directResponseAllowed ? "direct_response" : "ready_to_finish",
      nextAgent: "FINISH",
      lastWorkerFailed: taskState.lastWorkerFailed,
    };
  }

  return {
    ...taskState,
    status: "worker_running",
    currentAgent: next,
    nextAgent: next,
    lastWorkerFailed: false,
  };
}

export function buildTaskStateSummary(taskState: SupervisorTaskState): string {
  const completedAgentsText = taskState.completedAgents.length
    ? taskState.completedAgents.join(", ")
    : "none";

  return [
    "<task_state>",
    `task_id: ${taskState.taskId}`,
    `intent: ${taskState.intent}`,
    `status: ${taskState.status}`,
    `current_agent: ${taskState.currentAgent ?? "none"}`,
    `next_agent: ${taskState.nextAgent ?? "none"}`,
    `completed_agents: ${completedAgentsText}`,
    `direct_response_allowed: ${String(taskState.directResponseAllowed)}`,
    `last_worker_failed: ${String(taskState.lastWorkerFailed)}`,
    "</task_state>",
  ].join("\n");
}