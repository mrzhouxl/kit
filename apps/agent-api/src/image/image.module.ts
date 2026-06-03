/**
 * image/image.module.ts — 图片模块
 */
import { Module } from "@nestjs/common";
import { ImageController } from "./image.controller.js";
import { GeneratedImageController } from "./generated-image.controller.js";

@Module({
  controllers: [ImageController, GeneratedImageController],
})
export class ImageModule {}
