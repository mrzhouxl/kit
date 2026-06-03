/**
 * chat/chat.controller.ts — 聊天路由控制器（LangGraph 版）
 *
 * 使用 LangGraph 多 Agent Supervisor 图处理对话请求：
 *   POST /api/chat           → 流式 Agent 对话（chunked text）
 *   POST /api/chat/generate  → 非流式对话
 *   POST /api/chat/sse       → TDesign Chat 兼容 SSE（token 级流式）
 *   GET  /api/chat/models    → 可用模型列表
 */
import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { getCompiledGraph, convertMessages } from "../graph/index.js";
import { selectGraphInputMessages } from "./request-messages.js";
import {
  beginActiveRun,
  endActiveRun,
  isActiveRun,
  normalizeRunId,
} from "./active-run-registry.js";
import {
  getRequestSessionKey,
  requestContextStorage,
} from "../context/request-context.js";
import { sandboxEvents } from "../sandbox/index.js";
import { getOrCreateSandbox, sandboxWriteFile, getMetrics, getActiveSessions } from "../sandbox/index.js";
import type { SandboxEvent } from "../sandbox/index.js";
import { AGENT_NAMES } from "../graph/agents.js";
import * as sessionService from "../session/session.service.js";
import { uploadBufferToLocal } from "../tools/local-storage.js";
import { extractUserIdFromAuthorizationHeader } from "../auth/jwt.js";
import {
  resolveRequestRecursionLimit,
} from "./request-guard.js";
import {
  appendModelChunk,
  consumeSupervisorStreamDelta,
  consumeWorkerStreamDelta,
  createSseStreamBufferState,
  discardSupervisorText,
  endModelTurn,
  endWorkerTurn,
  startModelTurn,
  startWorkerTurn,
} from "./sse-stream-buffer.js";
import { sanitizeAssistantOutput } from "./response-sanitizer.js";

/** Worker Agent 节点名集合（用于识别 task 级事件边界） */
const WORKER_AGENT_SET = new Set<string>(AGENT_NAMES);

/** Agent 节点名 → 中文标签映射 */
const AGENT_LABELS: Record<string, string> = {
  web_agent: "网络助手",
  code_agent: "代码助手",
  image_agent: "图像助手",
};

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

// ---------- 请求体 DTO ----------

/** 前端消息格式（兼容 Vercel AI SDK） */
interface ChatMessage {
  role: string;
  content: string | unknown[];
}

interface ChatRequestDto {
  /** 消息列表 */
  messages: ChatMessage[];
  /** 可选：覆盖系统提示词（保留接口兼容，暂不使用） */
  systemPrompt?: string;
  /** 可选：最大 Agent 迭代步数（保留接口兼容） */
  maxSteps?: number;
  /** 可选：会话 ID（用于 Checkpointer 持久化） */
  threadId?: string;
  /** 可选：本轮请求 ID，用于隔离旧流事件和当前回复 */
  runId?: string;
  /** 可选：项目上下文 */
  projectContext?: { projectId: string; projectName?: string };
}

type ToolInput = Record<string, unknown> | string | undefined;

interface ToolOutputPayload {
  urls?: string[];
  videos?: string[];
  error?: string;
}

@Controller("api/chat")
export class ChatController {
  /**
   * 从请求头 JWT 中解析 user_id，并校验签名是否合法。
   */
  private extractUserId(req: Request): number {
    return extractUserIdFromAuthorizationHeader(req.headers.authorization);
  }

  /**
   * 将用户消息和助手回复保存到数据库。
   * 若 threadId 对应的会话不存在则自动创建。
   */
  private async saveMessages(
    threadId: string,
    userId: number | undefined,
    userContent: string,
    assistantContent: string,
    /** 可选：助手消息附带的结构化工具执行日志 */
    assistantMetadata?: Record<string, unknown> | null,
  ): Promise<void> {
    if (!userId) return;

    try {
      // 查找或创建会话
      let session = await sessionService.getSessionByThreadId(threadId);
      if (!session) {
        session = await sessionService.createSession({
          userId,
          threadId,
          title: sessionService.extractTitle(userContent),
          mode: "chat",
        });
      }

      // 保存消息（assistant 消息附带 metadata）
      const shouldSaveAssistantMessage = !!assistantContent || !!assistantMetadata;
      const assistantMessages = shouldSaveAssistantMessage
        ? [{
            sessionId: session.id,
            role: "assistant" as const,
            content: assistantContent,
            ...(assistantMetadata ? { metadata: assistantMetadata } : {}),
          }]
        : [];

      await sessionService.addMessages([
        { sessionId: session.id, role: "user", content: userContent },
        ...assistantMessages,
      ]);

      // 更新会话时间戳
      await sessionService.touchSession(session.id);

      // 如果是首条消息，自动设置标题
      if (session.title === "新会话" && userContent) {
        await sessionService.updateSessionTitle(session.id, sessionService.extractTitle(userContent));
      }
    } catch (err) {
      // 消息保存失败不影响聊天响应
      console.error("[Chat] 保存消息失败:", err instanceof Error ? err.message : err);
    }
  }

  /** 将工具输入规范化为对象，便于后续生成结构化提示。 */
  private normalizeToolInput(input: ToolInput): Record<string, unknown> | undefined {
    if (!input) return undefined;
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input) as unknown;
        return parsed && typeof parsed === "object"
          ? parsed as Record<string, unknown>
          : undefined;
      } catch {
        return undefined;
      }
    }
    return typeof input === "object" ? input : undefined;
  }


  /**
   * 解包工具输出。
   * LangGraph 在 on_tool_end 中经常返回 ToolMessage 包装对象，真实 JSON 在 kwargs.content。
   */
  private unwrapToolOutput(rawOutput: unknown): {
    resultStr: string;
    outputObj: ToolOutputPayload | null;
  } {
    let resultStr = "";
    let outputObj: ToolOutputPayload | null = null;

    const tryParse = (value: unknown): ToolOutputPayload | null => {
      if (!value) return null;
      if (typeof value === "string") {
        resultStr = value;
        try {
          const parsed = JSON.parse(value) as unknown;
          return parsed && typeof parsed === "object"
            ? parsed as ToolOutputPayload
            : null;
        } catch {
          return null;
        }
      }
      if (typeof value === "object") {
        resultStr = JSON.stringify(value);
        return value as ToolOutputPayload;
      }
      resultStr = String(value);
      return null;
    };

    outputObj = tryParse(rawOutput);
    if (outputObj?.videos || outputObj?.urls || outputObj?.error) {
      return { resultStr, outputObj };
    }

    const wrapper = rawOutput && typeof rawOutput === "object"
      ? rawOutput as Record<string, unknown>
      : null;
    const kwargs = wrapper?.kwargs && typeof wrapper.kwargs === "object"
      ? wrapper.kwargs as Record<string, unknown>
      : null;
    const nestedContent = kwargs?.content;
    const nestedOutput = tryParse(nestedContent);
    if (nestedOutput) {
      outputObj = nestedOutput;
    }

    return { resultStr, outputObj };
  }

  /** 组装助手消息 metadata。 */
  private buildAssistantMetadata(params: {
    toolLogs?: Array<Record<string, unknown>>;
    images?: string[];
    videos?: string[];
  }): Record<string, unknown> | null {
    const metadata: Record<string, unknown> = {};

    if (params.toolLogs && params.toolLogs.length > 0) {
      metadata.toolLogs = params.toolLogs;
    }
    if (params.images && params.images.length > 0) {
      metadata.images = params.images;
    }
    if (params.videos && params.videos.length > 0) {
      metadata.videos = params.videos;
    }
    return Object.keys(metadata).length > 0 ? metadata : null;
  }

  /** 根据浏览器动作生成给前端展示的步骤文案。 */
  private describeBrowserAction(item: Record<string, unknown>): string {
    const action = typeof item.action === "string" ? item.action : "";
    const selector = typeof item.selector === "string" ? item.selector.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim().slice(0, 24) : "";

    switch (action) {
      case "click":
        return selector ? `点击页面元素 ${selector}` : "点击页面指定元素";
      case "type":
        if (selector && text) return `在 ${selector} 输入“${text}”`;
        if (selector) return `在 ${selector} 输入文本`;
        return text ? `在页面输入“${text}”` : "在页面中输入文本";
      case "scroll": {
        const direction = item.direction === "up" ? "向上" : "向下";
        const distance = typeof item.distance === "number" ? `${item.distance}px` : "指定距离";
        return `${direction}滚动页面（${distance}）`;
      }
      case "wait":
        return selector ? `等待页面元素 ${selector} 出现` : "等待页面渲染完成";
      case "content":
        return "提取当前页面正文内容";
      case "screenshot":
        return "截取当前页面截图";
      case "evaluate":
        return "执行页面脚本并读取结果";
      default:
        return "执行页面交互操作";
    }
  }

  /** 为工具调用生成“当前要做什么”的步骤说明，供前端直接展示。 */
  private buildToolIntentSteps(toolName: string, input?: Record<string, unknown>): string[] {
    switch (toolName) {
      case "execute_code": {
        const language = typeof input?.language === "string" ? input.language : "bash";
        return [`执行 ${language} 代码`];
      }
      case "browse_web": {
        const url = typeof input?.url === "string" ? input.url : "";
        const actions = Array.isArray(input?.actions)
          ? input.actions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          : [];
        const steps = [url ? `访问目标页面 ${url}` : "访问目标页面"];
        actions.forEach((item) => steps.push(this.describeBrowserAction(item)));
        return steps;
      }
      case "fetch_webpage": {
        const url = typeof input?.url === "string" ? input.url : "";
        const selector = typeof input?.selector === "string" ? input.selector.trim() : "";
        const steps = [url ? `抓取页面内容 ${url}` : "抓取目标页面内容"];
        if (selector) {
          steps.push(`提取选择器 ${selector} 对应的内容`);
        } else {
          steps.push("提取页面正文与关键信息");
        }
        return steps;
      }
      case "generate_image": {
        const prompt = typeof input?.prompt === "string" ? input.prompt.slice(0, 100) : "";
        const ratio = typeof input?.aspect_ratio === "string" ? input.aspect_ratio : "";
        return [
          prompt ? `生成图片：${prompt}` : "根据提示词生成图片",
          ratio ? `使用画幅比例 ${ratio}` : "使用默认画幅比例",
        ];
      }
      case "edit_image": {
        const prompt = typeof input?.prompt === "string" ? input.prompt.slice(0, 100) : "";
        const hasMask = typeof input?.mask === "string" && input.mask.trim().length > 0;
        return [
          prompt ? `编辑图片：${prompt}` : "根据要求编辑图片",
          hasMask ? "使用蒙版限制编辑区域" : "按整图或默认区域进行编辑",
        ];
      }
      case "generate_video": {
        const prompt = typeof input?.prompt === "string" ? input.prompt.slice(0, 100) : "";
        const seconds = typeof input?.seconds === "string" ? input.seconds : "";
        return [
          prompt ? `生成视频：${prompt}` : "根据提示词生成视频",
          seconds ? `目标时长 ${seconds} 秒` : "使用默认视频时长",
        ];
      }
      case "save_code": {
        const filename = typeof input?.filename === "string" ? input.filename.trim() : "";
        const description = typeof input?.description === "string" ? input.description.trim() : "";
        const steps = [filename ? `生成并整理代码文件 ${filename}` : "整理并输出本次生成的代码结果"];
        if (description) steps.push(description);
        return steps;
      }
      case "explain_code": {
        const focus = typeof input?.focus === "string" ? input.focus : "overview";
        const focusLabel: Record<string, string> = {
          overview: "结构与职责",
          security: "安全风险",
          performance: "性能瓶颈",
          bugs: "潜在缺陷",
        };
        return [`分析代码，重点检查${focusLabel[focus] ?? "代码内容"}`];
      }
      case "list_projects": {
        const page = typeof input?.page === "number" ? input.page : undefined;
        const pageSize = typeof input?.pageSize === "number" ? input.pageSize : undefined;
        const suffix = [
          page ? `第 ${page} 页` : "",
          pageSize ? `每页 ${pageSize} 条` : "",
        ].filter(Boolean).join("，");
        return [suffix ? `读取 AI Comics 项目列表（${suffix}）` : "读取 AI Comics 项目列表"];
      }
      case "get_project_detail": {
        const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : "";
        return [projectId ? `读取项目详情：${projectId}` : "读取指定项目的详细信息"];
      }
      case "list_fragments": {
        const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : "";
        return [projectId ? `读取项目分镜列表：${projectId}` : "读取指定项目的分镜列表"];
      }
      case "create_fragment": {
        const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : "";
        const content = typeof input?.content === "string" ? input.content.trim().slice(0, 36) : "";
        const steps = [projectId ? `在项目 ${projectId} 中创建新分镜` : "在当前项目中创建新分镜"];
        if (content) steps.push(`写入分镜内容：${content}`);
        return steps;
      }
      case "trigger_fragment_image": {
        const fragmentId = typeof input?.fragmentId === "string" ? input.fragmentId.trim() : "";
        const prompt = typeof input?.imagePrompt === "string" ? input.imagePrompt.trim().slice(0, 48) : "";
        const steps = [fragmentId ? `为分镜 ${fragmentId} 发起图片生成` : "为指定分镜发起图片生成"];
        if (prompt) steps.push(`使用临时提示词：${prompt}`);
        return steps;
      }
      case "list_materials": {
        const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : "";
        return [projectId ? `读取项目素材库：${projectId}` : "读取指定项目的素材库"];
      }
      default:
        return [`使用工具 ${toolName} 处理当前请求`];
    }
  }

  /**
   * 从请求头提取 JWT Token（去掉 Bearer 前缀）
   */
  private extractToken(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (!auth) return undefined;
    return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  }

  /**
   * 在请求上下文中执行回调，使工具可通过 getRequestJwtToken() 获取 Token
   */
  private runWithContext<T>(req: Request, threadId: string, fn: () => T): T {
    const jwtToken = this.extractToken(req);
    return requestContextStorage.run({ jwtToken, threadId }, fn);
  }

  /**
   * 构建 LangGraph 调用配置（含 thread_id 和可选 abort signal）
   */
  private buildGraphConfig(threadId: string, signal?: AbortSignal, maxSteps?: number) {
    return {
      configurable: { thread_id: threadId },
      recursionLimit: resolveRequestRecursionLimit(maxSteps),
      ...(signal ? { signal } : {}),
    };
  }
  
  /**
   * 判断事件是否来自 Supervisor 节点。
   */
  private isSupervisorEvent(event: {
    name?: unknown;
    metadata?: { langgraph_node?: unknown };
  }): boolean {
    const node = event.metadata?.langgraph_node;
    const name = event.name;

    if (node === "supervisor") return true;
    if (name === "supervisor") return true;
    return false;
  }

  /** 判断是否为 Supervisor 的路由工具调用事件。 */
  private isRouteToolEvent(event: { name?: unknown }): boolean {
    return event.name === "route_to_agent";
  }

  // ---------- 流式聊天（chunked text） ----------

  @Post()
  async streamChat(
    @Body() body: ChatRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new HttpException("messages 不能为空", HttpStatus.BAD_REQUEST);
    }

    const threadId = body.threadId?.trim() || randomUUID();
    const runId = normalizeRunId(body.runId);

    return this.runWithContext(req, threadId, async () => {
      const graph = getCompiledGraph();
      const incomingMessages = selectGraphInputMessages(
        body.messages,
        await sessionService.hasPersistedConversationByThreadId(threadId),
      );
      const messages = convertMessages(incomingMessages);
      const userId = this.extractUserId(req);
      const userContent = typeof body.messages[body.messages.length - 1]?.content === "string"
        ? body.messages[body.messages.length - 1].content as string
        : JSON.stringify(body.messages[body.messages.length - 1]?.content ?? "");

      const abortController = beginActiveRun(threadId, runId);
      req.on("close", () => abortController.abort());

      const config = this.buildGraphConfig(threadId, abortController.signal, body.maxSteps);

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");

      // 收集助手回复文本用于保存
      let fullAssistantText = "";
      try {
        // 使用 streamEvents 获取 token 级流式输出
        const eventStream = graph.streamEvents(
          { messages },
          { ...config, version: "v2" },
        );

        // Supervisor 文本先缓冲，不立即输出：
        // - 若后续触发 route_to_agent，整段视为内部路由话术，直接丢弃
        // - 若未触发路由工具，则在 on_chat_model_end 时一次性输出
        let supervisorBuffer = "";
        let hasPendingSupervisorText = false;
        let discardSupervisorBuffer = false;

        for await (const event of eventStream) {
          if (event.event === "on_chat_model_start" && this.isSupervisorEvent(event)) {
            supervisorBuffer = "";
            hasPendingSupervisorText = false;
            discardSupervisorBuffer = false;
            continue;
          }

          if (event.event === "on_tool_start" && this.isRouteToolEvent(event)) {
            discardSupervisorBuffer = true;
            continue;
          }

          // 只转发 LLM 的文本增量（过滤掉 tool call 等非文本内容）
          if (event.event === "on_chat_model_stream") {
            const chunk = event.data?.chunk;
            if (chunk && typeof chunk.content === "string" && chunk.content) {
              if (this.isSupervisorEvent(event)) {
                if (!discardSupervisorBuffer) {
                  supervisorBuffer += chunk.content;
                  hasPendingSupervisorText = true;
                }
              } else {
                res.write(chunk.content);
                fullAssistantText += chunk.content;
              }
            }
            continue;
          }

          if (event.event === "on_chat_model_end" && this.isSupervisorEvent(event)) {
            if (hasPendingSupervisorText && supervisorBuffer.length > 0 && !discardSupervisorBuffer) {
              const safeSupervisorText = sanitizeAssistantOutput(supervisorBuffer);
              res.write(safeSupervisorText);
              fullAssistantText += safeSupervisorText;
            }
            supervisorBuffer = "";
            hasPendingSupervisorText = false;
            discardSupervisorBuffer = false;
          } else if (event.event === "on_chat_model_end") {
          }
        }
      } catch (err) {
        // AbortError 是正常的客户端断开
        if (err instanceof Error && err.name === "AbortError") {
          console.log("[LangGraph] 客户端断开连接");
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[LangGraph] 流式执行失败:", msg);
          res.write(`\n\n[错误] ${msg}`);
        }
      }

      // 保存消息到数据库
      const assistantMetadata = this.buildAssistantMetadata({});
      try {
        if (isActiveRun(threadId, runId)) {
          await this.saveMessages(threadId, userId, userContent, fullAssistantText, assistantMetadata);
        }
      } finally {
        endActiveRun(threadId, runId);
        res.end();
      }
    });
  }

  // ---------- 非流式生成 ----------

  @Post("generate")
  async generate(
    @Body() body: ChatRequestDto,
    @Req() req: Request,
  ) {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new HttpException("messages 不能为空", HttpStatus.BAD_REQUEST);
    }

    const threadId = body.threadId?.trim() || randomUUID();
    const runId = normalizeRunId(body.runId);

    return this.runWithContext(req, threadId, async () => {
      const graph = getCompiledGraph();
      const incomingMessages = selectGraphInputMessages(
        body.messages,
        await sessionService.hasPersistedConversationByThreadId(threadId),
      );
      const messages = convertMessages(incomingMessages);
      const abortController = beginActiveRun(threadId, runId);
      const config = this.buildGraphConfig(threadId, abortController.signal, body.maxSteps);
      const userId = this.extractUserId(req);
      const userContent = typeof body.messages[body.messages.length - 1]?.content === "string"
        ? body.messages[body.messages.length - 1].content as string
        : JSON.stringify(body.messages[body.messages.length - 1]?.content ?? "");

      let text = "";
      const eventStream = graph.streamEvents(
        { messages },
        { ...config, version: "v2" },
      );
      let supervisorBuffer = "";
      let hasPendingSupervisorText = false;
      let discardSupervisorBuffer = false;

      try {
        for await (const event of eventStream) {
          if (event.event === "on_chat_model_start" && this.isSupervisorEvent(event)) {
            supervisorBuffer = "";
            hasPendingSupervisorText = false;
            discardSupervisorBuffer = false;
            continue;
          }

          if (event.event === "on_tool_start" && this.isRouteToolEvent(event)) {
            discardSupervisorBuffer = true;
            continue;
          }

          if (event.event === "on_chat_model_stream") {
            const chunk = event.data?.chunk;
            if (chunk && typeof chunk.content === "string" && chunk.content) {
              if (this.isSupervisorEvent(event)) {
                if (!discardSupervisorBuffer) {
                  supervisorBuffer += chunk.content;
                  hasPendingSupervisorText = true;
                }
              } else {
                text += chunk.content;
              }
            }
            continue;
          }

          if (event.event === "on_chat_model_end") {
            if (this.isSupervisorEvent(event)) {
              if (hasPendingSupervisorText && supervisorBuffer.length > 0 && !discardSupervisorBuffer) {
                text += supervisorBuffer;
              }
              supervisorBuffer = "";
              hasPendingSupervisorText = false;
              discardSupervisorBuffer = false;
            }
          }
        }

        text = sanitizeAssistantOutput(text);

        const assistantMetadata = this.buildAssistantMetadata({});
        if (isActiveRun(threadId, runId)) {
          await this.saveMessages(threadId, userId, userContent, text, assistantMetadata);
        }

        return {
          text,
          steps: 0,
          threadId: config.configurable.thread_id,
          runId,
        };
      } finally {
        endActiveRun(threadId, runId);
      }
    });
  }

  // ---------- SSE 流式聊天（TDesign Chat 兼容） ----------

  @Post("sse")
  @HttpCode(HttpStatus.OK)
  async sseChat(
    @Body() body: ChatRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new HttpException("messages 不能为空", HttpStatus.BAD_REQUEST);
    }

    const threadId = body.threadId?.trim() || randomUUID();
    const runId = normalizeRunId(body.runId);

    return this.runWithContext(req, threadId, async () => {
      // 先建立 SSE 连接，这样业务型限制错误可以通过事件流返回给前端，
      // 避免聊天组件把 429/402 渲染成笼统的“请求出错”。
      res.status(HttpStatus.OK);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      /** 发送一条 SSE 事件 */
      const sendEvent = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify({ runId, ...data })}\n\n`);
      };

      const graph = getCompiledGraph();
      const incomingMessages = selectGraphInputMessages(
        body.messages,
        await sessionService.hasPersistedConversationByThreadId(threadId),
      );
      const messages = convertMessages(incomingMessages);
      const userId = this.extractUserId(req);
      const userContent = typeof body.messages[body.messages.length - 1]?.content === "string"
        ? body.messages[body.messages.length - 1].content as string
        : JSON.stringify(body.messages[body.messages.length - 1]?.content ?? "");

      const abortController = beginActiveRun(threadId, runId);
      req.on("close", () => abortController.abort());
      const heartbeatTimer = setInterval(() => {
        sendEvent({ type: "ping", ts: Date.now() });
      }, SSE_HEARTBEAT_INTERVAL_MS);

      const config = this.buildGraphConfig(threadId, abortController.signal, body.maxSteps);

      // 监听沙箱实时事件（screencast 帧、stdout 等），转发到当前 SSE 连接
      const sessionKey = getRequestSessionKey();
      const onSandboxEvent = (payload: {
        sessionKey: string;
        threadId: string;
        event: SandboxEvent;
      }) => {
        // 优先按 sessionKey 匹配；若工具执行链路中上下文丢失导致 sessionKey 为空，
        // 则退化按 threadId 匹配，避免右侧终端收不到命令和输出。
        const matchedBySession = !!sessionKey && payload.sessionKey === sessionKey;
        const matchedByThread = payload.threadId === threadId;
        if (!matchedBySession && !matchedByThread) return;
        const evt = payload.event;
        switch (evt.type) {
          case "screencast":
            sendEvent({ type: "browser_frame", image: evt.frame, url: evt.url });
            break;
          case "navigate":
            sendEvent({ type: "browser_navigate", url: evt.url, title: evt.title });
            break;
          case "stdout":
            sendEvent({ type: "code_output", data: evt.data, stream: evt.stream });
            // 持久化终端输出
            toolExecutionLogs.push({ type: "code_output", data: evt.data, stream: evt.stream, ts: Date.now() });
            break;
          case "status":
            sendEvent({ type: "sandbox_status", state: evt.state, operation: evt.operation });
            break;
          case "notify":
            // Agent 主动通知（通过 message_notify_user 工具发射）
            sendEvent({ type: "agent_notify", message: evt.message });
            break;
          case "video_status":
            sendEvent({
              type: "video_status",
              taskId: evt.taskId,
              status: evt.status,
              rawStatus: evt.rawStatus,
              progress: evt.progress,
              size: evt.size,
              model: evt.model,
              seconds: evt.seconds,
              createdAt: evt.createdAt,
              url: evt.url,
              error: evt.error,
            });
            toolExecutionLogs.push({
              type: "video_status",
              taskId: evt.taskId,
              status: evt.status,
              rawStatus: evt.rawStatus,
              progress: evt.progress,
              size: evt.size,
              model: evt.model,
              seconds: evt.seconds,
              createdAt: evt.createdAt,
              url: evt.url,
              error: evt.error,
              ts: Date.now(),
            });
            break;
          case "file_preview":
            sendEvent({ type: "file_preview", url: evt.url, fileName: evt.fileName, fileType: evt.fileType });
            // 持久化文件预览事件
            toolExecutionLogs.push({ type: "file_preview", url: evt.url, fileName: evt.fileName, fileType: evt.fileType, ts: Date.now() });
            break;
          case "error":
            sendEvent({ type: "error", msg: evt.message });
            break;
        }
      };
      sandboxEvents.on("event", onSandboxEvent);

      // 客户端断开时移除监听
      req.on("close", () => {
        clearInterval(heartbeatTimer);
        sandboxEvents.removeListener("event", onSandboxEvent);
      });

      /** 收集完整助手回复文本用于持久化 */
      let sseFullAssistantText = "";
      /** 发给前端的助手文本，同时按相同顺序累计到最终落库内容。 */
      const emitAssistantText = (text: string) => {
        const safeText = sanitizeAssistantOutput(text);
        if (!safeText) return;

        sendEvent({ type: "text", msg: safeText });
        sseFullAssistantText += safeText;
      };
      const generatedImageUrls = new Set<string>();
      const generatedVideoUrls = new Set<string>();

      /** 收集结构化工具执行日志，保存到 metadata */
      const toolExecutionLogs: Array<Record<string, unknown>> = [];

      try {
        const eventStream = graph.streamEvents(
          { messages },
          { ...config, version: "v2" },
        );

        // 仅在确认是"直接回复"时才输出 Supervisor 文本，避免暴露内部路由过程。
        /** 文本流缓冲状态：控制 supervisor / worker 的对用户输出策略 */
        const streamBufferState = createSseStreamBufferState();
        /** 当前正在执行的 Worker Agent 节点名（用于 task_end 匹配） */
        let activeWorkerAgent = "";
        /** Supervisor 路由时携带的任务描述（reason 字段） */
        let pendingTaskReason = "";
        /** 是否已有 Worker Agent 产出内容（用于压制 Supervisor 后续评论） */
        let hasWorkerOutput = false;

        for await (const event of eventStream) {
          switch (event.event) {
            // ── Worker Agent 节点开始 → 发出 task_start ──
            case "on_chain_start": {
              const node = event.metadata?.langgraph_node;
              if (typeof node === "string" && WORKER_AGENT_SET.has(node) && node !== activeWorkerAgent) {
                activeWorkerAgent = node;
                startWorkerTurn(streamBufferState, node);
                sendEvent({
                  type: "task_start",
                  agent: node,
                  title: AGENT_LABELS[node] ?? node,
                  reason: pendingTaskReason || undefined,
                });
                // 持久化任务启动事件
                toolExecutionLogs.push({ type: "task_start", agent: node, title: AGENT_LABELS[node] ?? node, reason: pendingTaskReason || undefined, ts: Date.now() });
                pendingTaskReason = "";
              }
              break;
            }

            // ── Worker Agent 节点结束 → 发出 task_end ──
            case "on_chain_end": {
              const node = event.metadata?.langgraph_node;
              if (typeof node === "string" && node === activeWorkerAgent) {
                const { finalText: workerText, pendingText } = endWorkerTurn(streamBufferState, node);
                if (pendingText) {
                  emitAssistantText(pendingText);
                }
                if (workerText) {
                  hasWorkerOutput = true;
                }
                sendEvent({
                  type: "task_end",
                  agent: node,
                  title: AGENT_LABELS[node] ?? node,
                });
                // 持久化任务结束事件
                toolExecutionLogs.push({ type: "task_end", agent: node, title: AGENT_LABELS[node] ?? node, ts: Date.now() });
                activeWorkerAgent = "";
              }
              break;
            }

            // Supervisor 一轮模型输出开始时，重置缓冲区
            case "on_chat_model_start": {
              startModelTurn(streamBufferState, this.isSupervisorEvent(event));
              break;
            }

            // LLM token 流 — 转发文本增量
            case "on_chat_model_stream": {
              const chunk = event.data?.chunk;
              if (chunk && typeof chunk.content === "string" && chunk.content) {
                if (this.isSupervisorEvent(event)) {
                  // Worker Agent 已产出内容后，Supervisor 的文本只是路由决策/反思，不应追加给用户
                  if (!hasWorkerOutput) {
                    appendModelChunk(streamBufferState, true, chunk.content);
                    const supervisorDelta = consumeSupervisorStreamDelta(streamBufferState);
                    if (supervisorDelta) {
                      emitAssistantText(supervisorDelta);
                    }
                  }
                } else if (activeWorkerAgent) {
                  appendModelChunk(streamBufferState, false, chunk.content);
                  const workerDelta = consumeWorkerStreamDelta(streamBufferState);
                  if (workerDelta) {
                    emitAssistantText(workerDelta);
                  }
                }
              }
              break;
            }

            // Supervisor 该轮 model 输出完成：将缓冲文本计入完整回复
            case "on_chat_model_end": {
              if (this.isSupervisorEvent(event)) {
                const { pendingText } = endModelTurn(streamBufferState, true);
                if (pendingText) {
                  emitAssistantText(pendingText);
                }
              } else if (activeWorkerAgent) {
                endModelTurn(streamBufferState, false);
              }
              break;
            }

            // 工具调用开始 — 结构化事件通知前端
            case "on_tool_start": {
              const toolName = event.name ?? "unknown";
              // 跳过 Supervisor 的路由工具调用提示，但提取 reason 作为任务描述
              if (this.isRouteToolEvent(event)) {
                discardSupervisorText(streamBufferState);
                const routeInput = this.normalizeToolInput(event.data?.input);
                if (routeInput && typeof routeInput.reason === "string" && routeInput.reason.trim()) {
                  pendingTaskReason = routeInput.reason.trim();
                }
                break;
              }
              // message_notify_user 工具的通知已通过 sandboxEvents 发射，不需要发 tool_start
              if (toolName === "message_notify_user") {
                break;
              }
              // 检测 Agent 切换（仅对真正的 Worker Agent 发射，过滤子图内部节点如 "tools"）
              const agentNode = event.metadata?.langgraph_node;
              if (typeof agentNode === "string" && WORKER_AGENT_SET.has(agentNode)) {
                sendEvent({ type: "agent_start", agent: agentNode });
              }
              // 确保 input 是对象（LangGraph 有时传字符串）
              const toolInput = this.normalizeToolInput(event.data?.input ?? {});
              // 发送工具元信息，不再发送固定步骤文案（由 agent 通过 message_notify_user 动态通知）
              sendEvent({
                type: "tool_start",
                tool: toolName,
                input: toolInput,
              });
              // 持久化工具启动事件
              toolExecutionLogs.push({ type: "tool_start", tool: toolName, input: toolInput, ts: Date.now() });
              break;
            }

            // 工具执行完成 — 结构化结果
            case "on_tool_end": {
              const toolName = event.name ?? "unknown";
              // 跳过路由工具和通知工具
              if (toolName === "route_to_agent" || toolName === "message_notify_user") break;
              const rawOutput = event.data?.output;
              const { resultStr, outputObj } = this.unwrapToolOutput(rawOutput);
              const resultPreview =
                resultStr.length > 500
                  ? resultStr.slice(0, 500) + "…"
                  : resultStr;
              const imageUrls = Array.isArray(outputObj?.urls)
                ? outputObj.urls.filter((url): url is string => typeof url === "string" && !!url.trim())
                : [];
              const videoUrls = Array.isArray(outputObj?.videos)
                ? outputObj.videos.filter((url): url is string => typeof url === "string" && !!url.trim())
                : [];
              if (imageUrls.length > 0 && (toolName === "generate_image" || toolName === "edit_image")) {
                for (const imageUrl of imageUrls) {
                  generatedImageUrls.add(imageUrl);
                }
              }
              if (videoUrls.length > 0 && toolName === "generate_video") {
                for (const videoUrl of videoUrls) {
                  generatedVideoUrls.add(videoUrl);
                }
                sendEvent({
                  type: "video",
                  videos: videoUrls,
                });
              }
              sendEvent({
                type: "tool_end",
                tool: toolName,
                result: resultPreview || null,
                success: !(outputObj?.error),
              });
              // 持久化工具结束事件
              toolExecutionLogs.push({ type: "tool_end", tool: toolName, result: resultPreview || null, success: !(outputObj?.error), ts: Date.now() });
              break;
            }

            default:
              break;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          console.log("[LangGraph/SSE] 客户端断开连接");
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[LangGraph/SSE] 流式执行失败:", msg);
          sendEvent({ type: "error", msg });
        }
      }

      // 清理沙箱事件监听
      clearInterval(heartbeatTimer);
      sandboxEvents.removeListener("event", onSandboxEvent);

      // 保存消息到数据库（附带工具执行日志）
      const metadata = this.buildAssistantMetadata({
        toolLogs: toolExecutionLogs,
        images: Array.from(generatedImageUrls),
        videos: Array.from(generatedVideoUrls),
      });
      try {
        if (isActiveRun(threadId, runId)) {
          await this.saveMessages(threadId, userId, userContent, sseFullAssistantText, metadata);
        }
      } finally {
        sendEvent({ type: "done" });
        endActiveRun(threadId, runId);
        res.end();
      }
    });
  }

  // ---------- 可用模型列表 ----------

  @Get("models")
  getModels() {
    return {
      models: [
        { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
        {
          id: "deepseek-reasoner",
          name: "DeepSeek R1",
          provider: "deepseek",
          reasoning: true,
        },
      ],
      agents: [
        {
          id: "supervisor",
          name: "Supervisor",
          description: "LangGraph 多 Agent 调度器",
        },
        { id: "web-agent", name: "Web Agent", description: "网络搜索 & 抓取" },
        {
          id: "code-agent",
          name: "Code Agent",
          description: "代码生成 & 分析",
        },
        { id: "image-agent", name: "Image Agent", description: "图像与视频生成" },
      ],
      architecture: "langgraph-supervisor",
    };
  }

  @Get("usage/summary")
  async getUsageSummary(
    @Req() _req: Request,
    @Query("month") month?: string,
  ) {
    return {
      enabled: false,
      message: "开源版已关闭用量统计与计费能力",
      month: month ?? null,
    };
  }

  // ---------- 文件在线保存 ----------

  /**
   * POST /api/chat/save-file
   *
   * 前端在线编辑 Markdown / 文本文件后调用此接口保存：
   *   1. 将内容写回沙箱容器（便于后续 Agent 操作）
  *   2. 上传到本地存储
   *   3. 返回新的下载 URL
   */
  @Post("save-file")
  async saveFile(
    @Body() body: { content: string; fileName: string; sandboxPath?: string; threadId?: string },
    @Req() req: Request,
  ) {
    const userId = this.extractUserId(req);
    const { content, fileName, sandboxPath, threadId } = body;

    if (!content && content !== "") {
      throw new HttpException("缺少 content 参数", HttpStatus.BAD_REQUEST);
    }
    if (!fileName) {
      throw new HttpException("缺少 fileName 参数", HttpStatus.BAD_REQUEST);
    }

    const tag = "[SaveFile]";
    console.log(`${tag} 开始 | file=${fileName} | user=${userId}`);

    // 推断 MIME 类型
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
    const MIME: Record<string, string> = {
      ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
      ".json": "application/json", ".xml": "application/xml", ".yaml": "text/yaml",
      ".yml": "text/yaml", ".log": "text/plain", ".html": "text/html",
    };
    const mimeType = MIME[ext] ?? "text/plain";

    try {
      // 写回沙箱（best-effort，沙箱可能已销毁）
      if (sandboxPath && threadId && userId) {
        try {
          const sandbox = await getOrCreateSandbox(String(userId), threadId);
          await sandboxWriteFile(sandbox, sandboxPath, content);
          console.log(`${tag} 沙箱写回成功 | ${sandboxPath}`);
        } catch (err) {
          console.warn(`${tag} 沙箱写回失败（忽略）:`, err instanceof Error ? err.message : err);
        }
      }

      // 上传到本地存储
      const buffer = Buffer.from(content, "utf-8");
      const result = await uploadBufferToLocal(buffer, mimeType, fileName);

      console.log(`${tag} 上传完成 | url=${result.file_url}`);
      return { success: true, url: result.file_url, fileName };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 失败: ${msg}`);
      throw new HttpException(`文件保存失败: ${msg}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * GET /api/chat/sandbox/status
   *
   * 沙箱运行状态与执行指标（运维/监控用）
   * 返回当前活跃会话、预热池状态、排队信息、累计执行统计
   */
  @Get("sandbox/status")
  getSandboxStatus() {
    return {
      sessions: getActiveSessions(),
      metrics: getMetrics(),
    };
  }
}
