/**
 * tools/sandbox-list.ts — 沙箱文件列表工具
 *
 * list_sandbox_files : 列出沙箱容器中指定目录的文件，
 * 帮助 agent 判断文件是否已存在、避免重复下载。
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
  sandboxListFiles,
} from "../sandbox/index.js";
import {
  getRequestThreadId,
  getRequestUserKey,
} from "../context/request-context.js";

export const listSandboxFiles = tool({
  description:
    "列出沙箱容器中指定目录的文件列表。" +
    "用于检查文件是否已存在于沙箱中，避免重复下载。" +
    "默认目录为 /home/sandbox，也可查看 /tmp。",
  inputSchema: z.object({
    directory: z.string()
      .default("/home/sandbox")
      .describe("要列出的沙箱目录路径（默认 /home/sandbox）"),
  }),
  execute: async ({ directory }) => {
    const userId = getRequestUserKey();
    const threadId = getRequestThreadId() ?? "list-session";
    const tag = "[ListTool]";

    console.log(`${tag} 列出 ${directory} | user=${userId}`);

    try {
      const sandbox = await getOrCreateSandbox(userId, threadId);
      const result = await sandboxListFiles(sandbox, directory);

      if (!result.success) {
        return { success: false, error: result.error ?? "列目录失败", files: [] };
      }

      // 格式化为简洁输出
      const files = (result.files ?? []).map((f) => ({
        name: f.name,
        path: f.path,
        size: f.size,
        isDirectory: f.isDirectory,
        ext: f.ext,
      }));

      console.log(`${tag} 完成 | ${files.length} 条目`);
      return { success: true, files, count: files.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 异常: ${msg}`);
      return { success: false, error: msg, files: [] };
    }
  },
});
