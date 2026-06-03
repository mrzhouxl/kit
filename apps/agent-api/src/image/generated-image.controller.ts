/**
 * image/generated-image.controller.ts — 静态生成图片服务
 *
 * 提供 GET /api/generated-images/:filename 路由，
 * 用于访问由 image tool 保存到本地的生成图片文件。
 */
import { Controller, Get, Param, Res, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { join } from "node:path";
import { createReadStream, existsSync } from "node:fs";

/** 生成图片存储目录（与 image-store.ts 保持一致） */
const STORE_DIR = join(process.cwd(), "generated-images");

@Controller("api/generated-images")
export class GeneratedImageController {
  /** 按文件名返回生成的图片 */
  @Get(":filename")
  serveImage(@Param("filename") filename: string, @Res() res: Response) {
    // 安全：只允许 uuid.png 格式，防止路径遍历
    if (!/^[0-9a-f-]+\.png$/i.test(filename)) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: "非法文件名" });
    }

    const filePath = join(STORE_DIR, filename);
    if (!existsSync(filePath)) {
      return res.status(HttpStatus.NOT_FOUND).json({ error: "图片不存在" });
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    createReadStream(filePath).pipe(res);
  }
}
