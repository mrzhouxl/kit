/**
 * video/video-api.ts — OpenAPI 视频生成客户端
 *
 * 对接视频异步任务接口：
 * 1. POST /v1/videos 提交任务（application/json）
 * 2. GET  /v1/videos/{task_id} 轮询结果
 * 3. GET  /v1/videos/{task_id}/content 在 success 但无 URL 时补取真实地址
 */
import axios from "axios";
import { videoConfig } from "../config.js";

export interface CreateVideoRequest {
  prompt: string;
  model: string;
  size?: string;
  hd?: boolean;
  watermark?: boolean;
  seconds?: string;
  input_reference?: {
    image_url: string;
  };
  private?: boolean;
  style?: string;
  storyboard?: boolean;
  character_create?: boolean;
  character_from_task?: string;
  character_timestamps?: string;
  character_url?: string;
}

export interface CreateVideoResponse {
  taskId: string;
  url: string;
}

export interface VideoTaskResult {
  taskId: string;
  status: "pending" | "processing" | "success" | "failed";
  rawStatus?: string;
  progress?: number;
  size?: string;
  model?: string;
  seconds?: string;
  createdAt?: number;
  url?: string;
  error?: string;
}

export interface CreateVideoViaOpenApiOptions {
  onStatus?: (status: VideoTaskResult) => void | Promise<void>;
}

function formatAxiosError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const payload = typeof error.response?.data === "string"
      ? error.response.data
      : JSON.stringify(error.response?.data ?? {});
    return new Error(`video API HTTP ${status ?? "unknown"}: ${payload}`);
  }

  return error instanceof Error
    ? error
    : new Error(`video API request failed: ${String(error)}`);
}

function normalizeAuthToken(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : authorization;
}

function normalizeVideoBaseURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, "");
  if (normalized.toLowerCase().endsWith("/v1")) {
    return normalized.slice(0, -3);
  }
  return normalized;
}

function buildVideoRequestBody(request: CreateVideoRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.trim(),
    prompt: request.prompt.trim(),
  };

  if (request.size?.trim()) body.size = request.size.trim();
  if (typeof request.hd === "boolean") body.hd = request.hd;
  if (typeof request.watermark === "boolean") body.watermark = request.watermark;
  if (request.seconds?.trim()) body.seconds = request.seconds.trim();
  if (request.input_reference?.image_url?.trim()) {
    body.input_reference = {
      image_url: request.input_reference.image_url.trim(),
    };
  }
  if (typeof request.private === "boolean") body.private = request.private;
  if (request.style?.trim()) body.style = request.style.trim();
  if (typeof request.storyboard === "boolean") body.storyboard = request.storyboard;
  if (typeof request.character_create === "boolean") body.character_create = request.character_create;
  if (request.character_from_task?.trim()) body.character_from_task = request.character_from_task.trim();
  if (request.character_timestamps?.trim()) body.character_timestamps = request.character_timestamps.trim();
  if (request.character_url?.trim()) body.character_url = request.character_url.trim();

  return body;
}

function extractTaskId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? record.data as Record<string, unknown>
    : null;

  const candidates = [data, record].filter(Boolean) as Array<Record<string, unknown>>;
  for (const target of candidates) {
    for (const key of ["id", "task_id", "job_id"]) {
      const value = target[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return "";
}

function normalizeTaskStatus(raw: unknown): VideoTaskResult["status"] {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  switch (value) {
    case "success":
    case "succeeded":
    case "completed":
    case "done":
      return "success";
    case "failed":
    case "failure":
    case "fail":
    case "error":
    case "canceled":
    case "cancelled":
      return "failed";
    case "pending":
    case "submitted":
    case "queued":
      return "pending";
    case "in_progress":
    case "processing":
    case "running":
      return "processing";
    default:
      return "processing";
  }
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractVideoTaskError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;

  for (const key of ["fail_reason", "error_message", "message", "msg"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  if (record.data && typeof record.data === "object") {
    const nested = extractVideoTaskError(record.data);
    if (nested) return nested;
  }

  const resultUrl = record.result_url;
  if (typeof resultUrl === "string" && resultUrl.trim() && !resultUrl.trim().startsWith("http")) {
    return resultUrl.trim();
  }

  return "";
}

function findFirstPlayableUrl(payload: unknown): string {
  if (!payload) return "";

  if (typeof payload === "string") {
    const value = payload.trim();
    if (value.startsWith("http") && value.toLowerCase().includes(".mp4")) {
      return value;
    }
    return "";
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findFirstPlayableUrl(item);
      if (found) return found;
    }
    return "";
  }

  if (typeof payload !== "object") return "";

  const record = payload as Record<string, unknown>;
  for (const key of ["video_url", "output_url", "download_url", "play_url", "url", "src", "file_url"]) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("http") && (trimmed.toLowerCase().includes(".mp4") || key !== "url")) {
        return trimmed;
      }
    }
  }

  for (const value of Object.values(record)) {
    const found = findFirstPlayableUrl(value);
    if (found) return found;
  }

  return "";
}

function extractVideoUrl(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;

  const video = record.video;
  if (video && typeof video === "object") {
    const url = (video as Record<string, unknown>).url;
    if (typeof url === "string" && url.trim()) {
      return url.trim();
    }
  }

  const videoResult = record.video_result;
  if (Array.isArray(videoResult) && videoResult.length > 0) {
    const first = videoResult[0];
    if (first && typeof first === "object") {
      const url = (first as Record<string, unknown>).url;
      if (typeof url === "string" && url.trim()) {
        return url.trim();
      }
    }
  }

  for (const key of ["url", "video_url", "output_url", "file_url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().startsWith("http")) {
      return value.trim();
    }
  }

  const outputs = record.outputs;
  if (Array.isArray(outputs) && outputs.length > 0) {
    const first = outputs[0];
    if (typeof first === "string" && first.trim().startsWith("http")) {
      return first.trim();
    }
    if (first && typeof first === "object") {
      const url = (first as Record<string, unknown>).url;
      if (typeof url === "string" && url.trim()) {
        return url.trim();
      }
    }
  }

  return findFirstPlayableUrl(record);
}

function parseVideoTaskResult(taskId: string, payload: unknown): VideoTaskResult {
  const generic = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const target = generic.data && typeof generic.data === "object"
    ? generic.data as Record<string, unknown>
    : generic;

  const rawStatus = typeof (target.state ?? target.status) === "string"
    ? String(target.state ?? target.status).trim()
    : undefined;
  const status = normalizeTaskStatus(target.state ?? target.status);
  const result: VideoTaskResult = {
    taskId,
    status,
    rawStatus,
    progress: parseNumber(target.progress ?? generic.progress),
    size: typeof (target.size ?? generic.size) === "string" ? String(target.size ?? generic.size).trim() : undefined,
    model: typeof (target.model ?? generic.model) === "string" ? String(target.model ?? generic.model).trim() : undefined,
    seconds: typeof (target.seconds ?? generic.seconds) === "string" ? String(target.seconds ?? generic.seconds).trim() : undefined,
    createdAt: parseNumber(target.created_at ?? generic.created_at),
  };

  if (status === "success") {
    result.url = extractVideoUrl(target) || extractVideoUrl(generic);
  }
  if (status === "failed") {
    result.error = extractVideoTaskError(target) || extractVideoTaskError(generic) || "视频生成失败（上游返回失败状态）";
  }

  return result;
}

async function submitVideoTask(
  request: CreateVideoRequest,
  token: string,
): Promise<string> {
  const endpoint = `${normalizeVideoBaseURL(videoConfig.baseURL)}/v1/videos`;
  const body = buildVideoRequestBody(request);
  try {
    const response = await axios.post(endpoint, body, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: videoConfig.requestTimeoutMs,
    });

    const taskId = extractTaskId(response.data);
    if (!taskId) {
      throw new Error(`视频服务未返回任务 ID: ${JSON.stringify(response.data)}`);
    }
    return taskId;
  } catch (error) {
    throw formatAxiosError(error);
  }
}

async function queryVideoTask(taskId: string, token: string): Promise<VideoTaskResult> {
  const endpoint = `${normalizeVideoBaseURL(videoConfig.baseURL)}/v1/videos/${taskId}`;
  try {
    const response = await axios.get(endpoint, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: Math.min(videoConfig.requestTimeoutMs, 30_000),
    });

    const result = parseVideoTaskResult(taskId, response.data);
    if (result.status === "success" && !result.url) {
      result.url = await queryVideoContent(taskId, token).catch(() => undefined);
    }
    return result;
  } catch (error) {
    throw formatAxiosError(error);
  }
}

async function queryVideoContent(taskId: string, token: string): Promise<string> {
  const endpoint = `${normalizeVideoBaseURL(videoConfig.baseURL)}/v1/videos/${taskId}/content`;
  try {
    const response = await axios.get(endpoint, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: Math.min(videoConfig.requestTimeoutMs, 30_000),
    });

    const payload = response.data;
    const url = extractVideoUrl(payload) || extractFirstHttpUrl(payload);
    if (!url) {
      throw new Error(`视频内容接口未返回可用 URL: ${JSON.stringify(payload)}`);
    }
    return url;
  } catch (error) {
    throw formatAxiosError(error);
  }
}

function extractFirstHttpUrl(payload: unknown): string {
  if (typeof payload !== "string") return "";
  const match = payload.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0]?.trim() ?? "";
}

export async function createVideoViaOpenApi(
  request: CreateVideoRequest,
  authorization?: string,
  options?: CreateVideoViaOpenApiOptions,
): Promise<CreateVideoResponse> {
  const token = normalizeAuthToken(authorization) ?? videoConfig.apiKey;
  if (!token) {
    throw new Error("未提供 Authorization 且 VIDEO_API_KEY 未配置");
  }

  const taskId = await submitVideoTask(request, token);
  await options?.onStatus?.({
    taskId,
    status: "pending",
    rawStatus: "submitted",
    model: request.model,
    size: request.size,
    seconds: request.seconds,
  });
  const deadline = Date.now() + videoConfig.maxWaitMs;

  while (Date.now() < deadline) {
    const result = await queryVideoTask(taskId, token);
    await options?.onStatus?.(result);

    if (result.status === "success") {
      if (!result.url) {
        await new Promise((resolve) => setTimeout(resolve, videoConfig.pollIntervalMs));
        continue;
      }

      return {
        taskId,
        url: result.url,
      };
    }

    if (result.status === "failed") {
      throw new Error(result.error || "视频生成失败");
    }

    await new Promise((resolve) => setTimeout(resolve, videoConfig.pollIntervalMs));
  }

  throw new Error(`视频生成超时（等待超过 ${Math.round(videoConfig.maxWaitMs / 1000)} 秒）`);
}