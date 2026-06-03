import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { localStorageConfig } from "../config.js";

export interface LocalUploadPayload {
  key: string;
  file_url: string;
  expires_in: number;
}

function inferExtByMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("spreadsheetml") || normalized.includes("ms-excel")) return "xlsx";
  if (normalized.includes("wordprocessingml") || normalized.includes("msword")) return "docx";
  if (normalized.includes("presentationml") || normalized.includes("ms-powerpoint")) return "pptx";
  if (normalized.includes("pdf")) return "pdf";
  if (normalized.includes("csv")) return "csv";
  if (normalized.includes("plain")) return "txt";
  if (normalized.includes("markdown")) return "md";
  if (normalized.includes("json")) return "json";
  if (normalized.includes("zip")) return "zip";
  if (normalized.includes("html")) return "html";
  return "bin";
}

function parseBase64Image(base64OrDataUrl: string): { bytes: Buffer; mimeType: string } {
  const trimmed = base64OrDataUrl.trim();
  if (!trimmed) {
    throw new Error("base64 数据为空");
  }

  let mimeType = "image/png";
  let payload = trimmed;

  if (trimmed.startsWith("data:")) {
    const parts = trimmed.split(",", 2);
    if (parts.length !== 2) {
      throw new Error("非法 data URL");
    }
    const header = parts[0] ?? "";
    payload = parts[1] ?? "";
    const mimePart = header.split(";", 1)[0]?.replace("data:", "").trim();
    if (mimePart) {
      mimeType = mimePart;
    }
  }

  const normalized = payload.replace(/[\r\n\t\s]/g, "");
  if (!normalized) {
    throw new Error("base64 数据为空");
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
    if (bytes.length === 0) {
      throw new Error("empty");
    }
  } catch {
    bytes = Buffer.from(normalized, "base64url");
  }

  if (bytes.length === 0) {
    throw new Error("解析 base64 失败");
  }

  return { bytes, mimeType };
}

function buildObjectKey(ext: string): string {
  const prefix = localStorageConfig.keyPrefix.replace(/^\/+|\/+$/g, "");
  const now = new Date();
  const datePath = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const suffix = `${now.getHours()}${now.getMinutes()}${now.getSeconds()}${now.getMilliseconds()}-${randomUUID().slice(0, 8)}`;
  return posix.join(prefix, datePath, `${suffix}.${ext}`);
}

async function saveBufferToLocalStorage(buffer: Buffer, mimeType: string): Promise<LocalUploadPayload> {
  const ext = inferExtByMime(mimeType);
  const key = buildObjectKey(ext);
  const relativePath = key.split("/").join(posix.sep);
  const absolutePath = join(localStorageConfig.rootDir, relativePath);
  const parentDir = absolutePath.slice(0, absolutePath.lastIndexOf(posix.sep));

  await mkdir(parentDir, { recursive: true });
  await writeFile(absolutePath, buffer);

  const cleanBase = localStorageConfig.publicBaseUrl.replace(/\/+$/g, "");
  const fileUrl = `${cleanBase}/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;

  return {
    key,
    file_url: fileUrl,
    expires_in: 0,
  };
}

export async function uploadBase64ImageToLocal(base64OrDataUrl: string, filename?: string): Promise<LocalUploadPayload> {
  const { bytes, mimeType } = parseBase64Image(base64OrDataUrl);
  const guessedExt = inferExtByMime(mimeType);
  const safeFilename = basename((filename?.trim() || `agent-upload-${Date.now()}.${guessedExt}`).replace(/[\\/]/g, "_"));
  const ext = extname(safeFilename).replace(/^\./, "") || guessedExt;
  return saveBufferToLocalStorage(bytes, mimeType || `application/octet-stream;ext=${ext}`);
}

export async function uploadBufferToLocal(buffer: Buffer, mimeType: string, filename: string): Promise<LocalUploadPayload> {
  const safeFilename = basename(filename.replace(/[\\/]/g, "_"));
  void safeFilename;
  return saveBufferToLocalStorage(buffer, mimeType);
}
