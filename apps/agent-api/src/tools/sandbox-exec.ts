/**
 * tools/sandbox-exec.ts — 沙箱代码执行工具
 *
 * executeCode : 在 Docker 沙箱中安全执行代码（Python / Node.js / Bash）
 *
 * 执行过程中 stdout/stderr 通过 WebSocket → SSE 实时推送给前端，
 * HTTP 响应返回最终执行结果。
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
  sandboxExec,
} from "../sandbox/index.js";
import {
  getRequestThreadId,
  getRequestSessionKey,
  getRequestUserKey,
} from "../context/request-context.js";
import { sandboxEvents } from "../sandbox/index.js";

function emitTerminalLine(data: string, stream: "stdout" | "stderr" = "stdout"): void {
  const sessionKey = getRequestSessionKey();
  const threadId = getRequestThreadId();
  if (!sessionKey || !threadId) return;

  sandboxEvents.emit("event", {
    sessionKey,
    userId: "",
    threadId,
    event: {
      type: "stdout",
      data,
      stream,
    },
  });
}

export const executeCode = tool({
  description:
    "在安全的 Docker 沙箱中执行代码。支持 Python、Node.js、Bash。" +
    "执行过程中输出会实时推送给用户。适合运行代码验证结果、数据处理、脚本执行等场景。",
  inputSchema: z.object({
    language: z.enum(["python", "node", "bash"])
      .describe("编程语言：python / node / bash"),
    code: z.string()
      .describe("要执行的完整代码"),
    timeout: z.number().optional()
      .describe("执行超时秒数（默认 30 秒）"),
  }),
  execute: async ({ language, code, timeout }) => {
    const userId = getRequestUserKey();
    const threadId = getRequestThreadId() ?? "exec-session";
    const tag = `[ExecTool]`;
    const codePreview = code.length > 300 ? code.slice(0, 300) + '...' : code;

    console.log(`${tag} 开始 | ${language} | timeout=${timeout ?? 30}s | user=${userId} | thread=${threadId}`);
    console.log(`${tag} 代码: ${codePreview}`);
    emitTerminalLine(`[命令] execute_code language=${language} timeout=${timeout ?? 30}s\n`);
    emitTerminalLine(`[代码预览]\n${codePreview}\n`);
    const t0 = Date.now();

    try {
      // 获取或创建沙箱
      console.log(`${tag} 获取沙箱容器...`);
      const sandboxT0 = Date.now();
      const sandbox = await getOrCreateSandbox(userId, threadId);
      console.log(`${tag} 沙箱就绪 | 耗时=${Date.now() - sandboxT0}ms | container=${sandbox.containerId.slice(0, 12)}`);

      // 执行代码
      console.log(`${tag} 发送执行请求...`);
      const result = await sandboxExec(sandbox, {
        language,
        code,
        timeout: (timeout ?? 30) * 1000,
      });

      console.log(`${tag} 完成 | 总耗时=${Date.now() - t0}ms | exitCode=${result.exitCode} | duration=${result.duration}ms`);
      emitTerminalLine(`[结果] execute_code exitCode=${result.exitCode} duration=${result.duration}ms\n`);
      return {
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration: result.duration,
        language,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 异常 | 总耗时=${Date.now() - t0}ms | error=${msg}`);
      emitTerminalLine(`[错误] execute_code 失败: ${msg}\n`, "stderr");
      return {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: `沙箱执行失败: ${msg}`,
        duration: 0,
        language,
      };
    }
  },
});
