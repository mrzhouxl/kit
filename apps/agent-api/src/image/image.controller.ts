/**
 * image/image.controller.ts — 图片生成接口（供 Agent/前端调用）
 *
 * 兼容 OpenAPI：POST /v1/images/generations
 */
import { Body, Controller, Headers, HttpException, HttpStatus, Post } from "@nestjs/common";
import { z } from "zod";
import { createImageViaOpenApi, editImageViaOpenApi } from "./image-api.js";

/** 请求参数校验 schema */
const createImageSchema = z.object({
  prompt: z.string().min(1, "prompt 不能为空"),
  model: z.string().min(1, "model 不能为空"),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  image: z.union([z.string(), z.array(z.string())]).optional(),
  quality: z.string().optional(),
  stream: z.boolean().optional(),
  background: z.enum(["transparent", "opaque", "auto"]).optional(),
});

const editImageSchema = z.object({
  image: z.union([z.string().url(), z.array(z.string().url()).min(1)]),
  model: z.string().min(1, "model 不能为空"),
  prompt: z.string().optional(),
  mask: z.string().url().optional(),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
});

@Controller("v1/images")
export class ImageController {
  /**
   * 创建图片
   * 对外暴露统一接口，内部转发到 IMAGE_API_BASE_URL 对应的供应商。
   */
  @Post("generations")
  async createImage(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = createImageSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { error: "请求参数不合法", issues: parsed.error.issues },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await createImageViaOpenApi(parsed.data, authorization);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpException({ error: msg }, HttpStatus.BAD_GATEWAY);
    }
  }

  /**
   * 编辑图片。
   * 对外暴露统一接口，内部转发到 IMAGE_API_BASE_URL 对应的供应商。
   */
  @Post("edits")
  async editImage(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = editImageSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { error: "请求参数不合法", issues: parsed.error.issues },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await editImageViaOpenApi(parsed.data, authorization);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpException({ error: msg }, HttpStatus.BAD_GATEWAY);
    }
  }
}
