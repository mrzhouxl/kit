/**
 * tools/comics.ts — AI Comics 平台操作工具
 *
 * 允许 Agent 查询和操作 ai-comics 的核心业务数据：
 * - 项目列表 / 详情
 * - 片段列表 / 创建 / 更新
 * - 触发片段分镜图生成
 * - 素材列表
 *
 * 所有接口都必须使用当前请求携带的用户 JWT，确保按登录用户身份访问 Go 服务。
 */
import { tool } from "ai";
import { z } from "zod";
import { comicsConfig } from "../config.js";
import { requireRequestJwtToken } from "../context/request-context.js";

// ---------- 内部 HTTP 工具 ----------

interface FetchOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function comicsRequest<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  // 只允许使用当前登录用户的 JWT，避免误用共享环境变量导致越权或串用户。
  const { method = "GET", body, token } = opts;
  const effectiveToken = token ?? requireRequestJwtToken();

  if (!effectiveToken) {
    throw new Error("未提供 JWT Token，无法操作 ai-comics 平台。请在请求头中携带 Authorization");
  }

  const url = `${comicsConfig.baseURL}/api/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${effectiveToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ai-comics API ${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ---------- 项目工具 ----------

export const listProjects = tool({
  description: "列出当前用户在 ai-comics 平台上的所有项目（标题、状态、创建时间等）。",
  inputSchema: z.object({
    page: z.number().int().min(1).default(1).describe("页码，默认第 1 页"),
    pageSize: z.number().int().min(1).max(50).default(10).describe("每页条数，默认 10"),
  }),
  execute: async ({ page, pageSize }) => {
    try {
      const data = await comicsRequest<unknown>(
        `/projects?page=${page}&page_size=${pageSize}`
      );
      return { success: true, data };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const getProjectDetail = tool({
  description: "获取指定 ai-comics 项目的详细信息，包括脚本内容、设计风格、分镜数量等。",
  inputSchema: z.object({
    projectId: z.string().describe("项目 ID"),
  }),
  execute: async ({ projectId }) => {
    try {
      const data = await comicsRequest<unknown>(`/projects/${projectId}`);
      return { success: true, data };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

// ---------- 片段工具 ----------

export const listFragments = tool({
  description:
    "获取指定项目的所有片段（分镜格）列表，包含台词、场景描述、当前生成图片等信息。",
  inputSchema: z.object({
    projectId: z.string().describe("项目 ID"),
  }),
  execute: async ({ projectId }) => {
    try {
      const data = await comicsRequest<unknown>(`/projects/${projectId}/fragments`);
      return { success: true, data };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const createFragment = tool({
  description: "在指定项目中新建一个片段（分镜格），包含场景描述或台词。",
  inputSchema: z.object({
    projectId: z.string().describe("项目 ID"),
    content: z.string().describe("片段内容，通常是台词或场景描述文字"),
    imagePrompt: z
      .string()
      .optional()
      .describe("可选：该片段的图像生成提示词（英文效果更佳）"),
    orderIndex: z
      .number()
      .int()
      .optional()
      .describe("可选：片段排序索引，不填时追加到末尾"),
  }),
  execute: async ({ projectId, content, imagePrompt, orderIndex }) => {
    try {
      const body: Record<string, unknown> = { content };
      if (imagePrompt) body.image_prompt = imagePrompt;
      if (orderIndex !== undefined) body.order_index = orderIndex;

      const data = await comicsRequest<unknown>(`/projects/${projectId}/fragments`, {
        method: "POST",
        body,
      });
      return { success: true, data };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const triggerFragmentImage = tool({
  description:
    "触发为指定片段生成分镜图片。图像任务为异步，触发后使用 getProjectDetail 或轮询接口检查结果。",
  inputSchema: z.object({
    projectId: z.string().describe("项目 ID"),
    fragmentId: z.string().describe("片段 ID"),
    imagePrompt: z
      .string()
      .optional()
      .describe("可选：覆盖片段默认提示词，临时指定此次生成使用的描述"),
    model: z.string().optional().describe("可选：指定图像模型名"),
  }),
  execute: async ({ projectId, fragmentId, imagePrompt, model }) => {
    try {
      const body: Record<string, unknown> = {};
      if (imagePrompt) body.image_prompt = imagePrompt;
      if (model) body.model = model;

      const data = await comicsRequest<unknown>(
        `/projects/${projectId}/fragments/${fragmentId}/image-generation`,
        { method: "POST", body }
      );
      return { success: true, message: "图片生成任务已提交", data };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const listMaterials = tool({
  description: "列出指定项目的素材库（角色原型、背景图等），返回素材名称、URL、类型。",
  inputSchema: z.object({
    projectId: z.string().describe("项目 ID"),
  }),
  execute: async ({ projectId }) => {
    try {
      const data = await comicsRequest<unknown>(`/projects/${projectId}/materials`);
      return { success: true, data };
    } catch (err) {
      return { error: String(err) };
    }
  },
});
