/**
 * executor/runner.ts — 代码执行器
 *
 * 在子进程中执行用户代码（Python / Node.js / Bash），
 * 实时将 stdout/stderr 通过事件总线推送给 Agent API。
 */
import { spawn } from "node:child_process";
import { broadcastEvent } from "../events/ws-server.js";
import type { ExecRequest, ExecResponse, ExecLanguage } from "../types.js";

/** 语言 → 执行命令映射 */
const LANG_CMD: Record<ExecLanguage, { cmd: string; args: (code: string) => string[] }> = {
  python: { cmd: "python3", args: (code) => ["-c", code] },
  node:   { cmd: "node",    args: (code) => ["-e", code] },
  bash:   { cmd: "bash",    args: (code) => ["-c", code] },
};

/** 默认执行超时（30 秒） */
const DEFAULT_TIMEOUT = 30_000;

/**
 * 在子进程中执行代码，实时推送输出，返回最终结果。
 */
export async function executeCode(req: ExecRequest): Promise<ExecResponse> {
  const { language, code, timeout = DEFAULT_TIMEOUT, stdin } = req;
  const langDef = LANG_CMD[language];

  if (!langDef) {
    return { success: false, exitCode: -1, stdout: "", stderr: `不支持的语言: ${language}`, duration: 0 };
  }

  // 通知状态变为 busy
  broadcastEvent({ type: "status", state: "busy", operation: `exec:${language}` });

  const startTime = Date.now();

  return new Promise<ExecResponse>((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;

    const child = spawn(langDef.cmd, langDef.args(code), {
      stdio: ["pipe", "pipe", "pipe"],
      // 执行环境限制
      env: { ...process.env, HOME: "/home/sandbox" },
      cwd: "/home/sandbox",
    });

    // 提供标准输入
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    // 实时推送 stdout
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      broadcastEvent({ type: "stdout", data: text, stream: "stdout" });
    });

    // 实时推送 stderr
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      broadcastEvent({ type: "stdout", data: text, stream: "stderr" });
    });

    // 超时强制终止
    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        stderr += "\n[执行超时，已终止]";
        broadcastEvent({ type: "stdout", data: "\n[执行超时，已终止]", stream: "stderr" });
      }
    }, timeout);

    child.on("close", (exitCode) => {
      finished = true;
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      broadcastEvent({ type: "status", state: "idle" });

      resolve({
        success: exitCode === 0,
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
        duration,
      });
    });

    child.on("error", (err) => {
      finished = true;
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      broadcastEvent({ type: "status", state: "idle" });

      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + `\n[进程错误] ${err.message}`,
        duration,
      });
    });
  });
}
