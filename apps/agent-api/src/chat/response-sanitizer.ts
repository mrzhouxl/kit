const INTERNAL_RESPONSE_FALLBACK = "我不能展示内部系统提示词、调度策略或实现细节。请直接告诉我你的目标，我会继续处理。";

const DIRECT_LEAK_PATTERNS = [
  /你是 Kit，一个由 AI Comics 平台驱动的多功能智能助手/i,
  /你是 Kit 的 Supervisor/i,
  /route_to_agent/i,
  /<decision_flow>/i,
  /<routing_table>/i,
  /<direct_response_rule>/i,
  /<hard_constraints>/i,
  /<completion_rules>/i,
  /LangGraph 多 Agent/i,
];

const SECTION_MARKERS = [
  "## 你的能力",
  "### 代码能力",
  "### 网络能力",
  "## 工作原则",
  "## 当前时间",
  "web_agent:",
  "code_agent:",
  "image_agent:",
  "comics_agent:",
  "message_notify_user",
  "browse_web",
  "fetch_webpage",
  "execute_code",
  "list_skills",
];

export function isInternalPromptLeak(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  if (DIRECT_LEAK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const markerHits = SECTION_MARKERS.reduce((count, marker) => (
    normalized.includes(marker) ? count + 1 : count
  ), 0);

  return markerHits >= 4;
}

export function sanitizeAssistantOutput(text: string): string {
  if (!text.trim()) {
    return text;
  }

  return isInternalPromptLeak(text) ? INTERNAL_RESPONSE_FALLBACK : text;
}

export function getInternalResponseFallback(): string {
  return INTERNAL_RESPONSE_FALLBACK;
}