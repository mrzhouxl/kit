/**
 * tools/image.ts — 图像生成工具
 *
 * generateImage   : 调用 Grok / 任意 OpenAI-image 兼容接口生成图片。
 * editImage       : 图生图（inpainting / variation）。
 *
 * 统一调用 OpenAPI 图片生成接口（/v1/images/generations）。
 */
import { tool } from "ai";
import { z } from "zod";
import { imageConfig } from "../config.js";
import { createImageViaOpenApi, editImageViaOpenApi, type CreateImageResponse } from "../image/image-api.js";
import { uploadBase64ImageToLocal } from "./local-storage.js";

function inferExtFromMimeType(mimeType?: string): string {
  const normalized = (mimeType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
}


export const generateImage = tool({
  description:
    "根据文字描述（提示词）生成一张图片，返回图片 URL。适合角色原画、场景插图、漫画格、UI 设计稿等各类图像需求。",
  inputSchema: z.object({
    prompt: z
      .string()
      .max(1000)
      .describe(
        "所需图像的文本描述，最大长度 1000 字符。",
      ),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("要生成的图像数，范围 1-10。"),
    size: z
      .string()
      .optional()
      .describe("图片尺寸，格式 widthxheight，如 auto、1024x1024、1536x1024、1024x1536、2048x2048。"),
    image: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("输入图片 URL，支持单图字符串或多图数组。"),
    background: z
      .enum(["transparent", "opaque", "auto"])
      .optional()
      .describe("生成图像背景透明度设置。"),
  }),
  execute: async ({ prompt, size, n, image, background }) => {
    const targetModel = "gpt-image-2-reverse";
    try {
      const result = await createImageViaOpenApi({
        prompt,
        model: targetModel,
        n,
        size,
        image,
        background,
      });
      const transferredUrls = await persistImageResults(result, "image-gen");
      return {
        urls: transferredUrls,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[image-tool] generate failed", message);
      return {
        error: `图像生成失败: ${message}`,
        prompt,
      };
    }
  },
});

async function persistImageResults(result: CreateImageResponse, filePrefix: string): Promise<string[]> {
  console.log("[image-tool] raw result count", result.data.length);
  const urls: string[] = [];

  for (let index = 0; index < result.data.length; index += 1) {
    const item = result.data[index];
    if (!item) continue;

    const base64 = item.b64_json?.trim();
    if (base64) {
      try {
        const ext = inferExtFromMimeType(item.mime_type);
        const uploaded = await uploadBase64ImageToLocal(
          base64,
          `${filePrefix}-${Date.now()}-${index + 1}.${ext}`,
        );
        urls.push(uploaded.file_url);
        continue;
      } catch (err) {
        console.warn("[image-tool] base64 上传本地失败，尝试 URL 兜底", err);
      }
    }

    const sourceUrl = item.url?.trim();
    if (sourceUrl) {
      urls.push(sourceUrl);
    }
  }

  return urls;
}

export const editImage = tool({
  description:
    "根据输入图片执行图像编辑，可用于局部重绘、去字、换背景、调整元素、风格改造等，返回编辑后的图片 URL。",
  inputSchema: z.object({
    image: z
      .union([z.string().url(), z.array(z.string().url()).min(1)])
      .describe("待编辑图片 URL，支持单图字符串或多图数组。"),
    prompt: z
      .string()
      .max(1000)
      .optional()
      .describe("编辑指令，例如“把背景改成海边日落”“移除图片里的文字”。"),
    mask: z
      .string()
      .url()
      .optional()
      .describe("可选蒙版图片 URL；透明区域表示允许编辑的区域。"),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("要生成的图像数，范围 1-10。"),
    size: z
      .string()
      .optional()
      .describe("图片尺寸，格式 widthxheight，如 auto、1024x1024、1536x1024。"),
  }),
  execute: async ({ image, prompt, mask, n, size }) => {
    const targetModel = "gpt-image-2-reverse";
    try {
      const result = await editImageViaOpenApi({
        image,
        model: targetModel,
        prompt,
        mask,
        n,
        size,
      });
      const transferredUrls = await persistImageResults(result, "image-edit");
      return {
        urls: transferredUrls,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[image-tool] edit failed", message);
      return {
        error: `图片编辑失败: ${message}`,
        prompt,
      };
    }
  },
});
