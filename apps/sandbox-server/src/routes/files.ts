/**
 * routes/files.ts — 沙箱文件操作路由
 *
 * POST /files/read  — 读取沙箱内指定文件，返回 base64 编码内容。
 * POST /files/write — 将内容写入沙箱内指定文件。
 * POST /files/list  — 列出沙箱内指定目录的文件列表。
 *
 * 安全限制：仅允许访问 /home/sandbox 和 /tmp 下的路径。
 */
import type { FastifyInstance } from "fastify";
import { readFile, stat, readdir, writeFile, mkdir } from "node:fs/promises";
import { resolve, normalize, join, extname, dirname } from "node:path";

/** 允许读取的目录白名单 */
const ALLOWED_ROOTS = ["/home/sandbox", "/tmp"];

/** 单文件最大读取限制（50MB） */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** 请求体类型 */
interface ReadFileBody {
  path: string;
}

export async function registerFilesRoute(app: FastifyInstance) {
  app.post<{ Body: ReadFileBody }>("/files/read", async (request) => {
    const { path: filePath } = request.body;
    const tag = "[Files]";

    if (!filePath || typeof filePath !== "string") {
      console.warn(`${tag} 参数缺失: path`);
      return { success: false, error: "缺少 path 参数" };
    }

    // 安全校验：路径必须在白名单目录下
    const resolved = normalize(resolve(filePath));
    if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root))) {
      console.warn(`${tag} 路径越界: ${resolved}`);
      return { success: false, error: "不允许访问此路径" };
    }

    try {
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) {
        return { success: false, error: "指定路径不是文件" };
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        return { success: false, error: `文件过大 (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)，上限 50MB` };
      }

      console.log(`${tag} 读取文件 | ${resolved} | ${fileStat.size} 字节`);
      const fileBuffer = await readFile(resolved);

      return {
        success: true,
        data: fileBuffer.toString("base64"),
        size: fileStat.size,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 读取失败: ${msg}`);
      return { success: false, error: `读取失败: ${msg}` };
    }
  });

  // ── POST /files/write — 将内容写入沙箱文件 ───────────────
  app.post<{ Body: { path: string; content: string; encoding?: string } }>("/files/write", async (request) => {
    const { path: filePath, content, encoding } = request.body;
    const tag = "[Files]";

    if (!filePath || typeof filePath !== "string") {
      return { success: false, error: "缺少 path 参数" };
    }
    if (typeof content !== "string") {
      return { success: false, error: "缺少 content 参数" };
    }

    // 安全校验：路径必须在白名单目录下
    const resolved = normalize(resolve(filePath));
    if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root))) {
      console.warn(`${tag} write 路径越界: ${resolved}`);
      return { success: false, error: "不允许访问此路径" };
    }

    // 内容大小限制（10MB）
    const buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf-8");
    if (buf.length > 10 * 1024 * 1024) {
      return { success: false, error: "内容超过 10MB 限制" };
    }

    try {
      // 确保目录存在
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, buf);
      console.log(`${tag} write 完成 | ${resolved} | ${buf.length} 字节`);
      return { success: true, size: buf.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} write 失败: ${msg}`);
      return { success: false, error: `写入失败: ${msg}` };
    }
  });

  // ── POST /files/list — 列出目录内文件 ────────────────────
  app.post<{ Body: { directory: string } }>("/files/list", async (request) => {
    const { directory } = request.body;
    const tag = "[Files]";

    if (!directory || typeof directory !== "string") {
      return { success: false, error: "缺少 directory 参数" };
    }

    // 安全校验：路径必须在白名单目录下
    const resolved = normalize(resolve(directory));
    if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root))) {
      console.warn(`${tag} list 路径越界: ${resolved}`);
      return { success: false, error: "不允许访问此路径" };
    }

    try {
      const dirStat = await stat(resolved);
      if (!dirStat.isDirectory()) {
        return { success: false, error: "指定路径不是目录" };
      }

      const entries = await readdir(resolved, { withFileTypes: true });
      const files = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = join(resolved, entry.name);
          try {
            const s = await stat(fullPath);
            return {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              size: s.size,
              ext: entry.isDirectory() ? "" : extname(entry.name).toLowerCase(),
              modifiedAt: s.mtime.toISOString(),
            };
          } catch {
            return { name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), size: 0, ext: "", modifiedAt: "" };
          }
        }),
      );

      console.log(`${tag} list ${resolved} → ${files.length} 条目`);
      return { success: true, files };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} list 失败: ${msg}`);
      return { success: false, error: `列目录失败: ${msg}` };
    }
  });
}
