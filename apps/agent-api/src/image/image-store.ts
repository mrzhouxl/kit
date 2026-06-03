/**
 * image/image-store.ts — 生成图片本地存储
 *
 * 将 base64 编码的图片保存到磁盘，返回可通过 HTTP 访问的相对路径。
 * 避免将巨大的 base64 字符串直接放入 LLM 上下文导致 token 超限。
 */
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serverConfig } from "../config.js";

/** 生成图片存储目录（相对于 cwd） */
const STORE_DIR = join(process.cwd(), "generated-images");

/** 确保存储目录存在 */
let dirReady = false;
async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(STORE_DIR, { recursive: true });
  dirReady = true;
}

/**
 * 将 base64 编码的图片数据保存到本地文件。
 * @returns 可通过 HTTP 访问的完整 URL。
 */
export async function saveBase64Image(base64Data: string): Promise<string> {
  await ensureDir();
  const id = randomUUID();
  const filename = `${id}.png`;
  const filePath = join(STORE_DIR, filename);

  // 写入二进制文件
  const buffer = Buffer.from(base64Data, "base64");
  await writeFile(filePath, buffer);

  // 返回可通过 NestJS 静态路由访问的 URL
  const port = serverConfig.port;
  return `http://localhost:${port}/api/generated-images/${filename}`;
}
