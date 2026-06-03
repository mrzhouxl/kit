/**
 * image/image-api.ts — OpenAPI 图像生成客户端
 *
 * 对接标准接口：POST /v1/images/generations
 * 服务器：IMAGE_API_BASE_URL（默认 https://aigc.x-see.cn）
 */
import { imageConfig } from "../config.js";
import axios from "axios";

/** 图像生成请求参数 */
export interface CreateImageRequest {
  prompt: string;
  model: string;
  n?: number;
  size?: string;
  aspect_ratio?: string;
  image?: string | string[];
  quality?: string;
  stream?: boolean;
  background?: "transparent" | "opaque" | "auto";
}

/** 图像编辑请求参数。 */
export interface EditImageRequest {
  image: string | string[];
  model: string;
  prompt?: string;
  mask?: string;
  n?: number;
  size?: string;
}

/** 图像生成响应项 */
interface CreateImageDataItem {
  url?: string;
  b64_json?: string;
  mime_type?: string;
  revised_prompt?: string;
}

/** 图像生成响应 */
export interface CreateImageResponse {
  created?: number;
  data: CreateImageDataItem[];
}

function inferExtensionFromMimeType(mimeType?: string): string {
  const normalized = (mimeType ?? "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
}

function inferExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.includes(".") ? pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase() : "";
    if (ext && ext.length <= 6) {
      return ext;
    }
  } catch {
    // ignore
  }
  return "png";
}

async function appendRemoteFile(
  formData: FormData,
  fieldName: string,
  fileUrl: string,
  index: number,
): Promise<void> {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`下载远程图片失败 (${response.status}): ${fileUrl}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const mimeType = response.headers.get("content-type") ?? "image/png";
  const ext = inferExtensionFromMimeType(mimeType) || inferExtensionFromUrl(fileUrl);
  const blob = new Blob([arrayBuffer], { type: mimeType });
  formData.append(fieldName, blob, `${fieldName}-${index + 1}.${ext}`);
}

/**
 * 从 Authorization 请求头中提取 token。
 * 支持 "Bearer xxx" 或直接传入裸 token。
 */
function normalizeAuthToken(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : authorization;
}

/** Grok 图片模型支持的官方 aspect_ratio 值 */
const GROK_SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "auto",
]);

/** 常见像素尺寸到 Grok aspect_ratio 的映射 */
const PIXEL_SIZE_TO_GROK_ASPECT_RATIO: Record<string, string> = {
  "1024x1024": "1:1",
  "1280x720": "16:9",
  "1920x1080": "16:9",
  "720x1280": "9:16",
  "1080x1920": "9:16",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
};

function isGrokImageModel(model?: string): boolean {
  const normalized = (model ?? "").trim().toLowerCase();
  return normalized.startsWith("grok-");
}

function normalizeGrokAspectRatio(raw?: string): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;

  if (GROK_SUPPORTED_ASPECT_RATIOS.has(trimmed)) {
    return trimmed;
  }

  const mapped = PIXEL_SIZE_TO_GROK_ASPECT_RATIO[trimmed];
  if (mapped) {
    return mapped;
  }

  return undefined;
}

function buildCompatibleRequestBody(
  request: CreateImageRequest,
): Record<string, unknown> {
  if (!isGrokImageModel(request.model)) {
    return request as unknown as Record<string, unknown>;
  }

  const ratio =
    normalizeGrokAspectRatio(request.aspect_ratio ?? request.aspect_ratio) ?? "1:1";
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    model: request.model,
    aspect_ratio: ratio,
  };

  if (typeof request.n === "number") body.n = request.n;
  if (typeof request.size === "string" && request.size.trim()) body.size = request.size.trim();
  if (typeof request.image !== "undefined") body.image = request.image;
  if (typeof request.quality === "string" && request.quality.trim()) body.quality = request.quality.trim();
  if (typeof request.stream !== "undefined") body.stream = request.stream;
  if (typeof request.background !== "undefined") body.background = request.background;

  return body;
}

/**
 * 调用 OpenAPI 图像生成接口。
 * 优先使用请求头传入 token，未提供时回退到 IMAGE_API_KEY。
 */
export async function createImageViaOpenApi(
  request: CreateImageRequest,
  authorization?: string,
): Promise<CreateImageResponse> {
  const token = normalizeAuthToken(authorization) ?? imageConfig.apiKey;
  if (!token) {
    throw new Error("未提供 Authorization 且 IMAGE_API_KEY 未配置");
  }
  const endpoint = `${imageConfig.baseURL.replace(/\/$/, "")}/v1/images/generations`;
  const body = buildCompatibleRequestBody(request);

  try {
    console.log("[image-api] request", {
      endpoint,
      model: request.model,
      promptLength: request.prompt.length,
      n: request.n,
      size: request.size,
      hasImage: typeof request.image !== "undefined",
      background: request.background,
    });
    const response = await axios.post<CreateImageResponse>(endpoint, body, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: 120_0000000,
    });
    console.log("[image-api] response", {
      status: response.status,
      hasData: Boolean(response.data?.data),
      count: Array.isArray(response.data?.data) ? response.data.data.length : 0,
    });
    const data = response.data;
    if (!data || !Array.isArray(data.data)) {
      throw new Error(`接口响应格式异常: ${JSON.stringify(data)}`);
    }

    return {
      data: data.data,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const payload =
        typeof error.response?.data === "string"
          ? error.response.data
          : JSON.stringify(error.response?.data ?? {});
      console.error("[image-api] request failed", {
        endpoint,
        status: status ?? "unknown",
        message: error.message,
        payload: payload.slice(0, 500),
      });
      throw new Error(`image API HTTP ${status ?? "unknown"}: ${payload}`);
    }
    console.error("[image-api] unexpected error", error);
    throw error;
  }
}

/**
 * 调用 OpenAPI 图像编辑接口。
 * 对外暴露统一的 multipart/form-data 编辑能力，支持单图/多图和可选蒙版。
 */
export async function editImageViaOpenApi(
  request: EditImageRequest,
  authorization?: string,
): Promise<CreateImageResponse> {
  const token = normalizeAuthToken(authorization) ?? imageConfig.apiKey;
  if (!token) {
    throw new Error("未提供 Authorization 且 IMAGE_API_KEY 未配置");
  }

  const endpoint = `${imageConfig.baseURL.replace(/\/$/, "")}/v1/images/edits`;
  const formData = new FormData();
  const images = Array.isArray(request.image) ? request.image : [request.image];

  if (images.length === 0) {
    throw new Error("至少需要提供一张待编辑图片");
  }

  for (let index = 0; index < images.length; index += 1) {
    await appendRemoteFile(formData, "image", images[index], index);
  }

  if (request.mask?.trim()) {
    await appendRemoteFile(formData, "mask", request.mask.trim(), 0);
  }

  formData.append("model", request.model);
  if (request.prompt?.trim()) formData.append("prompt", request.prompt.trim());
  if (typeof request.n === "number") formData.append("n", String(request.n));
  if (request.size?.trim()) formData.append("size", request.size.trim());

  try {
    console.log("[image-api] edit request", {
      endpoint,
      model: request.model,
      promptLength: request.prompt?.length ?? 0,
      imageCount: images.length,
      hasMask: Boolean(request.mask?.trim()),
      n: request.n,
      size: request.size,
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`image API HTTP ${response.status}: ${text}`);
    }

    const data = JSON.parse(text) as CreateImageResponse;
    if (!data || !Array.isArray(data.data)) {
      throw new Error(`接口响应格式异常: ${text}`);
    }

    return {
      data: data.data,
    };
  } catch (error) {
    console.error("[image-api] edit request failed", error);
    throw error;
  }
}
