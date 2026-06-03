/**
 * graph/message-utils.ts — 消息处理工具函数
 *
 * 独立模块，避免 supervisor ↔ agents 循环依赖。
 * 包含图片 URL 提取与多模态消息构建工具。
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import { getCachedContextContinuity, setCachedContextContinuity } from "../context/request-context.js";
import { createSupervisorModel } from "./llm.js";

export function getMessageName(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const name = (message as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

export function getMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  // 多模态消息：content 为数组时，提取所有 text 类型 part 拼接
  if (Array.isArray(content)) {
    return content
      .filter((part: unknown) => part && typeof part === "object" && (part as { type?: string }).type === "text")
      .map((part: unknown) => (part as { text?: string }).text ?? "")
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

/** 检查 AIMessage 是否携带 tool_calls */
function hasToolCalls(msg: BaseMessage): boolean {
  if (!(msg instanceof AIMessage)) return false;
  const calls = msg.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/** 早期消息摘要的最大字符数 */
const SUMMARY_MAX_CHARS = 6000;

/** 显式指代上一轮内容的跟进表达；命中时保留历史，避免误伤连续追问。 */
const FOLLOW_UP_REFERENCE_RE = /(刚才|上一个|上一条|上面|之前|继续|接着|重新|再来|再次|基于|参考|这个|那个|它|这些|上述|同样|一样)/i;

type ContextIntent =
  | "casual_chat"
  | "knowledge_question"
  | "web_task"
  | "image_task"
  | "document_task"
  | "file_analysis_task"
  | "coding_task"
  | "unknown";

interface ContextContinuityInput {
  previousUserText: string;
  latestUserText: string;
  previousAssistantText: string;
}

interface ContextTrimOptions {
  classifyTaskContinuity?: (input: ContextContinuityInput) => Promise<boolean | null>;
}

const contextClassifierModel = createSupervisorModel({
  maxTokens: 120,
  streaming: false,
});

/**
 * 轻量意图分类，仅用于判断是否需要在新任务开始时隔离历史。
 * 这里保持和 supervisor-policy 接近的规则，但避免形成模块循环依赖。
 */
function classifyContextIntent(text: string): ContextIntent {
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

/** 查找最近两条真实用户消息，用于判断当前轮是否切换到了新任务。 */
function getLatestUserTurnIndices(messages: BaseMessage[]): number[] {
  const indices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] instanceof HumanMessage && !getMessageName(messages[i])) {
      indices.unshift(i);
      if (indices.length >= 2) {
        break;
      }
    }
  }
  return indices;
}

/**
 * 当最新一轮和上一轮属于不同任务，且最新问题没有显式引用上一轮时，
 * 仅保留最新用户轮，避免旧任务把 Supervisor 拉回到前一个执行流。
 */
function isolateLatestTurnOnIntentSwitch(messages: BaseMessage[]): BaseMessage[] | null {
  const userTurnIndices = getLatestUserTurnIndices(messages);
  if (userTurnIndices.length < 2) {
    return null;
  }

  const latestUserIndex = userTurnIndices[userTurnIndices.length - 1];
  const previousUserIndex = userTurnIndices[userTurnIndices.length - 2];
  const latestUserText = getMessageText(messages[latestUserIndex]).trim();
  const previousUserText = getMessageText(messages[previousUserIndex]).trim();

  if (!latestUserText || !previousUserText || FOLLOW_UP_REFERENCE_RE.test(latestUserText)) {
    return null;
  }

  const latestIntent = classifyContextIntent(latestUserText);
  const previousIntent = classifyContextIntent(previousUserText);
  if (latestIntent === "unknown" || previousIntent === "unknown" || latestIntent === previousIntent) {
    return null;
  }

  return sanitizeToolCallPairs(messages.slice(latestUserIndex));
}

function buildContextContinuityCacheKey(input: ContextContinuityInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function findLatestAssistantTextBefore(messages: BaseMessage[], latestUserIndex: number): string {
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const text = getMessageText(messages[index]).trim();
    if (text) {
      return text.length > 400 ? `${text.slice(0, 400)}…` : text;
    }
  }
  return "";
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

async function classifyTaskContinuityWithModel(input: ContextContinuityInput): Promise<boolean | null> {
  const cacheKey = buildContextContinuityCacheKey(input);
  const cached = getCachedContextContinuity(cacheKey);
  if (typeof cached === "boolean") {
    return cached;
  }

  try {
    const response = await contextClassifierModel.invoke([
      new SystemMessage([
        "你是对话任务边界分类器。",
        "判断最新用户问题是否需要继续继承上一轮任务的完整上下文。",
        "只输出一行 JSON，不要 Markdown，不要解释。",
        '{"reusePreviousTask":true|false,"reason":"不超过20字"}',
        "如果最新问题是在继续、修改、重试、追问上一轮结果，返回 true。",
        "如果最新问题已经切到新目标、新信息源、新任务，返回 false。",
        "如果没有明确依赖上一轮结果，也优先返回 false。",
      ].join("\n")),
      new HumanMessage([
        `上一轮用户问题：${input.previousUserText || "无"}`,
        `上一轮助手结果摘要：${input.previousAssistantText || "无"}`,
        `最新用户问题：${input.latestUserText || "无"}`,
      ].join("\n")),
    ]);

    const content = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
    const jsonText = extractFirstJsonObject(content);
    if (!jsonText) {
      return null;
    }

    const parsed = JSON.parse(jsonText) as { reusePreviousTask?: unknown };
    if (typeof parsed.reusePreviousTask !== "boolean") {
      return null;
    }

    setCachedContextContinuity(cacheKey, parsed.reusePreviousTask);
    return parsed.reusePreviousTask;
  } catch (error) {
    console.warn(
      "[LangGraph] 任务连续性模型判定失败，回退规则裁剪:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function isolateLatestTurnWithModel(
  messages: BaseMessage[],
  options?: ContextTrimOptions,
): Promise<BaseMessage[] | null> {
  const userTurnIndices = getLatestUserTurnIndices(messages);
  if (userTurnIndices.length < 2) {
    return null;
  }

  const latestUserIndex = userTurnIndices[userTurnIndices.length - 1];
  const previousUserIndex = userTurnIndices[userTurnIndices.length - 2];
  const latestUserText = getMessageText(messages[latestUserIndex]).trim();
  const previousUserText = getMessageText(messages[previousUserIndex]).trim();
  if (!latestUserText || !previousUserText) {
    return null;
  }

  const reusePreviousTask = await (options?.classifyTaskContinuity ?? classifyTaskContinuityWithModel)({
    previousUserText,
    latestUserText,
    previousAssistantText: findLatestAssistantTextBefore(messages, latestUserIndex),
  });

  if (reusePreviousTask === false) {
    return sanitizeToolCallPairs(messages.slice(latestUserIndex));
  }

  return null;
}

/**
 * 从被裁掉的早期消息中提取对话摘要。
 *
 * 信息压缩策略：
 * - 用户消息：保留完整内容（通常较短，是关键上下文）
 * - AI 直接回复（无 name）：提取前 300 字符作为结论摘要
 * - Agent 内部消息/ToolMessage：跳过（执行细节不需要记忆）
 * - AI 回复中的重复列表/技能清单：进一步压缩
 */
function buildEarlySummary(discardedMessages: BaseMessage[]): string {
  const lines: string[] = [];
  let totalLen = 0;

  for (const msg of discardedMessages) {
    // 跳过 ToolMessage 和带 name 的内部 agent 消息（工具调用/agent 中间结果）
    if (msg instanceof ToolMessage) continue;
    const name = getMessageName(msg);
    if (name && /agent/i.test(name)) continue;

    const text = getMessageText(msg).trim();
    if (!text) continue;

    const isUser = msg instanceof HumanMessage;

    let condensed: string;
    if (isUser) {
      // 用户消息保留更多内容（通常较短且是关键需求）
      condensed = text.length > 800 ? text.slice(0, 800) + "…" : text;
    } else {
      // AI 回复：提取核心结论，跳过中间推理过程
      // 如果回复很长（代码输出、详细解释），只保留开头的结论部分
      condensed = text.length > 300 ? text.slice(0, 300) + "…" : text;
    }

    const role = isUser ? "用户" : "AI";
    const line = `[${role}] ${condensed}`;

    if (totalLen + line.length > SUMMARY_MAX_CHARS) break;
    lines.push(line);
    totalLen += line.length;
  }

  return lines.join("\n");
}

/**
 * 裁剪消息列表，保留足够的对话上下文。
 *
 * 策略（基于用户轮次）：
 * 1. 从消息末尾向前扫描，找到最近 keepTurns 条用户消息（无 name 的 HumanMessage）
 * 2. 从最早的那条用户消息往前再保留 keepPadding 条，确保不截断工具调用对
 * 3. 被裁掉的早期消息压缩成对话摘要，作为 SystemMessage 注入上下文头部
 *
 * 这样无论中间有多少 Agent 工具调用消息，前几轮的用户-AI 交互都能被保留，
 * 避免模型因丢失上下文而重复相似回复。
 *
 * 安全保障：裁剪后移除孤立的 tool_calls 消息。
 */
export function trimMessagesForContext(messages: BaseMessage[], keepTurns = 3, keepPadding = 4): BaseMessage[] {
  const isolatedLatestTurn = isolateLatestTurnOnIntentSwitch(messages);
  if (isolatedLatestTurn) {
    return isolatedLatestTurn;
  }

  if (messages.length <= 15) return messages;

  // 从后往前收集最近 keepTurns 条用户消息的位置
  const userTurnIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage && !getMessageName(messages[i])) {
      userTurnIndices.unshift(i);
      if (userTurnIndices.length >= keepTurns) break;
    }
  }

  if (userTurnIndices.length === 0) {
    return messages.slice(-15);
  }

  // 从最早的用户消息再往前保留 keepPadding 条，避免截断 tool_call-ToolMessage 对
  const earliestUserIdx = userTurnIndices[0];
  const contextStart = Math.max(0, earliestUserIdx - keepPadding);
  const recentMessages = messages.slice(contextStart);

  // 如果有被裁掉的早期消息，生成对话摘要注入上下文
  if (contextStart > 0) {
    const discarded = messages.slice(0, contextStart);
    const summaryText = buildEarlySummary(discarded);
    if (summaryText) {
      const summaryMsg = new SystemMessage(
        `[对话历史摘要 — 以下是本次对话早期的关键内容，供你参考]\n${summaryText}\n[摘要结束]`
      );
      return sanitizeToolCallPairs([summaryMsg, ...recentMessages]);
    }
  }

  return sanitizeToolCallPairs(recentMessages);
}

/**
 * 模型辅助的上下文裁剪。
 * 优先使用模型判断任务是否延续，失败时回退到规则裁剪。
 */
export async function trimMessagesForContextWithModel(
  messages: BaseMessage[],
  keepTurns = 3,
  keepPadding = 4,
  options?: ContextTrimOptions,
): Promise<BaseMessage[]> {
  const isolatedMessages = await isolateLatestTurnWithModel(messages, options);
  if (isolatedMessages) {
    return isolatedMessages;
  }

  return trimMessagesForContext(messages, keepTurns, keepPadding);
}

/**
 * 移除孤立的 tool_calls 消息。
 *
 * 规则：如果一条 AIMessage 带有 tool_calls，但紧跟其后的消息不是 tool 类型，
 * 则将该 AIMessage 替换为不含 tool_calls 的纯文本版本。
 */
function sanitizeToolCallPairs(messages: BaseMessage[]): BaseMessage[] {
  const result: BaseMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (hasToolCalls(msg)) {
      const nextIsToolResult = messages[i + 1] instanceof ToolMessage;
      if (!nextIsToolResult) {
        // 孤立的 tool_calls → 保留文本、剥离 tool_calls
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content.trim()) {
          result.push(new AIMessage({ content }));
        }
        continue;
      }
    }
    result.push(msg);
  }
  return result;
}

// ── 图片 URL 提取与多模态消息构建 ────────────────────────────

/** 匹配消息内容中嵌入的图片 URL 标记：[image_url:https://...] */
const IMAGE_URL_MARKER_RE = /\[image_url:(https?:\/\/[^\]\s]+)\]/g;

/** 常见图片扩展名，用于判断附件 URL 是否为图片 */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

/** 常见图片 MIME 类型前缀 */
const IMAGE_MIME_PREFIX = "image/";

/**
 * 判断附件 URL 是否为图片资源。
 * 通过扩展名或 MIME 类型判断。
 */
function isImageUrl(url: string, mimeType?: string): boolean {
  if (mimeType && mimeType.startsWith(IMAGE_MIME_PREFIX)) return true;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = pathname.slice(pathname.lastIndexOf("."));
    return IMAGE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

/**
 * 从附件块中提取图片 URL。
 *
 * 附件块格式：
 * ```
 * [用户上传的附件]
 * - 附件1：image.jpg（image/jpeg，123 KB）
 *   URL: https://example.com/image.jpg
 * ```
 */
const ATTACHMENT_BLOCK_RE = /\[用户上传的附件\]\n([\s\S]*?)(?=\n\n|\n\[|$)/;
const ATTACHMENT_LINE_RE = /附件\d+：(.+?)（([^）]+)\）[\s\S]*?URL:\s*(https?:\/\/\S+)/g;

/**
 * 从消息文本中提取所有图片 URL。
 * 支持两种格式：
 * 1. [image_url:URL] 标记
 * 2. [用户上传的附件] 块中的图片类型附件
 *
 * @returns { imageUrls: 提取到的图片 URL 数组, cleanText: 移除图片标记后的纯文本 }
 */
export function extractImageUrls(text: string): { imageUrls: string[]; cleanText: string } {
  const imageUrls: string[] = [];
  let cleanText = text;

  // 1. 提取 [image_url:URL] 标记
  const markerMatches = [...text.matchAll(IMAGE_URL_MARKER_RE)];
  for (const match of markerMatches) {
    imageUrls.push(match[1]);
  }
  // 移除 [image_url:URL] 标记
  cleanText = cleanText.replace(IMAGE_URL_MARKER_RE, "").trim();

  // 2. 从附件块中提取图片 URL
  const blockMatch = cleanText.match(ATTACHMENT_BLOCK_RE);
  if (blockMatch) {
    const blockContent = blockMatch[0];
    const lineMatches = [...blockContent.matchAll(ATTACHMENT_LINE_RE)];
    for (const lineMatch of lineMatches) {
      const mimeInfo = lineMatch[2]; // e.g. "image/jpeg，123 KB"
      const url = lineMatch[3];
      // 判断是否为图片类型附件
      if (isImageUrl(url, mimeInfo)) {
        imageUrls.push(url);
      }
    }
  }

  return { imageUrls, cleanText };
}

/**
 * 构建包含图片引用的 HumanMessage。
 * 将图片 URL 从标记格式提取并以结构化文本注释呈现，
 * 使 Agent 能识别图片并通过工具下载处理。
 *
 * 注意：当前模型（DeepSeek）不支持多模态 image_url content part，
 * 因此以文本形式保留图片 URL 引用，由 Agent 通过沙箱工具处理。
 *
 * @param text - 原始消息文本（可能包含 [image_url:...] 标记或附件块）
 * @returns LangChain HumanMessage，图片 URL 以结构化文本注释呈现
 */
export function buildMultimodalHumanMessage(text: string): HumanMessage {
  const { imageUrls, cleanText } = extractImageUrls(text);

  // 无图片时返回普通文本消息
  if (imageUrls.length === 0) {
    return new HumanMessage(text);
  }

  // 以结构化文本注释方式附加图片 URL，Agent 可通过工具下载处理
  const imageAnnotations = imageUrls
    .map((url, i) => `  - 图片${i + 1}: ${url}`)
    .join("\n");
  const annotatedText = `${cleanText}\n\n[用户消息中包含以下图片]\n${imageAnnotations}`;

  console.log(`[MessageUtils] 构建图片引用消息 | 文本: ${cleanText.slice(0, 80)}... | 图片数: ${imageUrls.length}`);

  return new HumanMessage(annotatedText);
}
