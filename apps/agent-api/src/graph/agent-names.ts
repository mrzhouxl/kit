/** 所有可用 Worker Agent 名称常量，供 Supervisor、状态机和测试共享。 */
export const AGENT_NAMES = [
  "web_agent",
  "code_agent",
  "image_agent",
] as const;

/** Worker Agent 名称联合类型。 */
export type AgentName = (typeof AGENT_NAMES)[number];