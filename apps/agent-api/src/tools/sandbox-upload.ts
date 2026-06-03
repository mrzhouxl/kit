/**
 * tools/sandbox-upload.ts — 沙箱文件上传工具
 *
 * upload_sandbox_file : 从沙箱容器中读取指定文件，上传到本地存储，
 * 返回可访问的下载 URL。解决"容器关闭后文件丢失"的问题。
 *
 * 流程：
 *   1. 通过 sandbox-server /files/read 接口读取文件（base64）
 *   2. 上传到本地存储
 *   3. 返回下载 URL
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
  sandboxReadFile,
  sandboxEvents,
} from "../sandbox/index.js";
import {
  getRequestSessionKey,
  getRequestThreadId,
  getRequestUserKey,
} from "../context/request-context.js";
import { uploadBufferToLocal } from "./local-storage.js";

/** 根据文件扩展名推断 MIME 类型 */
const MIME_MAP: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".html": "text/html",
};

function inferMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? "application/octet-stream";
}

/** 可在线预览的文件扩展名 */
const PREVIEWABLE_EXTS = new Set([
  ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls", ".pdf",
  ".png", ".jpg", ".jpeg", ".webp",
  ".md", ".txt", ".csv", ".json", ".xml", ".log", ".yaml", ".yml",
  // HTML 预览 & 思维导图
  ".html", ".htm", ".mmd", ".mermaid",
]);

/** 发送上传进度事件到前端（状态 + 终端输出） */
function emitUploadProgress(message: string, operation: string): void {
  const sessionKey = getRequestSessionKey() ?? "";
  const threadId = getRequestThreadId() ?? "";
  const base = { sessionKey, userId: "", threadId };
  sandboxEvents.emit("event", { ...base, event: { type: "status", state: "busy", operation } });
  sandboxEvents.emit("event", { ...base, event: { type: "stdout", data: `[文件上传] ${message}\n`, stream: "stdout" } });
}

/** 推断预览文件类型分类 */
function inferPreviewType(ext: string): "office" | "pdf" | "image" | "markdown" | "text" | "html" | "mindmap" {
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".md") return "markdown";
  if ([".txt", ".csv", ".json", ".xml", ".log", ".yaml", ".yml"].includes(ext)) return "text";
  if ([".html", ".htm"].includes(ext)) return "html";
  if ([".mmd", ".mermaid"].includes(ext)) return "mindmap";
  return "office";
}

/** 发送文件预览事件到前端，触发右侧面板预览 */
function emitFilePreview(url: string, fileName: string, ext: string): void {
  if (!PREVIEWABLE_EXTS.has(ext)) return;
  const sessionKey = getRequestSessionKey() ?? "";
  const threadId = getRequestThreadId() ?? "";
  const fileType = inferPreviewType(ext);
  sandboxEvents.emit("event", {
    sessionKey, userId: "", threadId,
    event: { type: "file_preview", url, fileName, fileType },
  });
}

export const uploadSandboxFile = tool({
  description:
    "将沙箱中生成的文件上传到本地存储，返回可下载的 URL。" +
    "在沙箱中生成了文件（如 PPT、Excel、Word、PDF、图片等）后调用此工具，" +
    "让用户可以直接下载。容器关闭后文件会丢失，所以生成后必须调用此工具。",
  inputSchema: z.object({
    filePath: z.string()
      .describe("沙箱内的文件绝对路径（如 /home/sandbox/output.pptx 或 /tmp/report.xlsx）"),
    fileName: z.string()
      .describe("用户可见的文件名（含扩展名，如 report.xlsx）"),
  }),
  execute: async ({ filePath, fileName }) => {
    const userId = getRequestUserKey();
    const threadId = getRequestThreadId() ?? "upload-session";
    const tag = "[UploadTool]";
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";

    console.log(`${tag} 开始 | 文件: ${filePath} | 名称: ${fileName} | user=${userId}`);
    const t0 = Date.now();

    try {
      // 1. 获取沙箱
      emitUploadProgress(`准备上传文件 ${fileName}`, "upload:prepare");
      const sandbox = await getOrCreateSandbox(userId, threadId);

      // 2. 从沙箱读取文件
      emitUploadProgress("从沙箱读取文件...", "upload:read");
      const fileResult = await sandboxReadFile(sandbox, filePath);

      if (!fileResult.success || !fileResult.data) {
        emitUploadProgress(`读取失败: ${fileResult.error}`, "upload:failed");
        return {
          success: false,
          error: fileResult.error ?? "读取沙箱文件失败",
          url: "",
        };
      }

      console.log(`${tag} 文件读取成功 | ${fileResult.size} 字节`);

      // 3. 上传到本地存储
      emitUploadProgress(`上传到本地存储 (${((fileResult.size ?? 0) / 1024).toFixed(1)} KB)...`, "upload:uploading");
      const fileBuffer = Buffer.from(fileResult.data, "base64");
      const mimeType = inferMimeType(ext);

      const uploadResult = await uploadBufferToLocal(fileBuffer, mimeType, fileName);

      emitUploadProgress(`上传完成: ${fileName}`, "upload:done");
      console.log(`${tag} 上传完成 | 总耗时=${Date.now() - t0}ms | url=${uploadResult.file_url}`);

      // 发送预览事件，触发前端右侧面板展示文件
      emitFilePreview(uploadResult.file_url, fileName, ext);

      return {
        success: true,
        url: uploadResult.file_url,
        key: uploadResult.key,
        fileName,
        size: fileResult.size,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 异常 | 总耗时=${Date.now() - t0}ms | error=${msg}`);
      emitUploadProgress(`上传失败: ${msg}`, "upload:error");
      return {
        success: false,
        error: `文件上传失败: ${msg}`,
        url: "",
      };
    }
  },
});
