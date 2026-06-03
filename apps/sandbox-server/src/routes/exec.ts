/**
 * routes/exec.ts — 代码执行路由
 *
 * POST /exec — 在沙箱内执行代码（Python / Node.js / Bash）。
 * stdout/stderr 通过 WebSocket /events 实时推送，
 * HTTP 响应返回最终执行结果。
 */
import type { FastifyInstance } from "fastify";
import { executeCode } from "../executor/runner.js";
import type { ExecRequest } from "../types.js";

export async function registerExecRoute(app: FastifyInstance) {
  app.post<{ Body: ExecRequest }>("/exec", async (request) => {
    const { language, code, timeout, stdin } = request.body;
    const tag = `[Exec]`;
    const codePreview = code ? (code.length > 100 ? code.slice(0, 100) + '...' : code) : '';

    // 参数校验
    if (!language || !code) {
      console.warn(`${tag} 参数缺失 | language=${language} | code=${!!code}`);
      return { success: false, exitCode: -1, stdout: "", stderr: "缺少 language 或 code", duration: 0 };
    }

    const validLanguages = ["python", "node", "bash"];
    if (!validLanguages.includes(language)) {
      console.warn(`${tag} 不支持的语言: ${language}`);
      return { success: false, exitCode: -1, stdout: "", stderr: `不支持的语言: ${language}`, duration: 0 };
    }

    console.log(`${tag} 开始 | ${language} | timeout=${timeout ?? 'default'}ms | code=${codePreview}`);
    const t0 = Date.now();

    // 执行代码，期间 stdout/stderr 通过 WS 实时推送
    const result = await executeCode({ language, code, timeout, stdin });
    console.log(`${tag} 完成 | ${language} | ${Date.now() - t0}ms | exitCode=${result.exitCode} | stdout=${result.stdout.length}字符 | stderr=${result.stderr.length}字符`);
    return result;
  });
}
