/**
 * tools/skill.ts — Skill 工具
 *
 * execute_skill : 查看 Skill 详情或执行 Skill 脚本
 * list_skills   : 列出沙箱中可用的 Skill 列表（轻量，仅 name + description）
 *
 * 工作流程：list_skills → execute_skill(detail) → 阅读文档 → 安装依赖 → execute_skill(run)
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
} from "../sandbox/index.js";
import {
  getRequestThreadId,
  getRequestSessionKey,
  getRequestUserKey,
  markSkillsChecked,
} from "../context/request-context.js";
import { sandboxEvents } from "../sandbox/index.js";
import type {
  SkillDetailResponse,
  SkillRunResponse,
  SkillListResponse,
} from "../skills/types.js";

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

/**
 * execute_skill — 在沙箱中使用 Skill
 *
 * 两种动作：
 * - detail: 读取 Skill 完整文档和文件列表，了解使用方法和依赖要求
 * - run: 执行 Skill 中的脚本文件
 */
export const executeSkill = tool({
  description:
    "在沙箱中使用预定义的 Skill。支持两种动作：\n" +
    "- detail: 读取 Skill 的完整使用文档（SKILL.md）和文件列表，了解如何使用、需要什么依赖\n" +
    "- run: 执行 Skill 中的脚本文件\n\n" +
     "使用流程：list_skills → execute_skill(detail) → execute_skill(run) 执行脚本。\n" +
     "依赖由 Skill 引擎自动处理（requirements.txt / package.json）。\n" +
    "适用于数据分析、图表生成、文件处理等场景。",
  inputSchema: z.object({
    action: z.enum(["detail", "run"])
      .describe("动作类型：detail 读取 Skill 文档，run 执行脚本"),
    skillName: z.string()
      .describe("Skill 名称"),
    scriptFile: z.string().optional()
      .describe("run 动作时必填：要执行的脚本文件相对路径（如 scripts/analyze.py）"),
    args: z.string().optional()
      .describe("run 动作时可选：传给脚本的命令行参数"),
    timeout: z.number().optional()
      .describe("执行超时毫秒数（默认 60000）"),
  }),
  execute: async ({ action, skillName, scriptFile, args, timeout }) => {
    const userId = getRequestUserKey();
    const threadId = getRequestThreadId() ?? "skill-session";
    const tag = `[SkillTool]`;

    console.log(`${tag} ${action} | skill=${skillName} | script=${scriptFile ?? "-"} | user=${userId}`);
    emitTerminalLine(`[命令] execute_skill action=${action} skill=${skillName}${scriptFile ? ` script=${scriptFile}` : ""}\n`);
    if (args && args.trim()) {
      const argsPreview = args.length > 300 ? args.slice(0, 300) + "..." : args;
      emitTerminalLine(`[参数] ${argsPreview}\n`);
    }
    const t0 = Date.now();

    try {
      // 获取或创建沙箱
      const sandbox = await getOrCreateSandbox(userId, threadId);

      if (action === "detail") {
        // 调用 /skill/detail/:name 端点，获取 Skill 完整文档
        const res = await fetch(`${sandbox.baseUrl}/skill/detail/${encodeURIComponent(skillName)}`, {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        });

        const data = await res.json() as SkillDetailResponse;
        console.log(`${tag} detail 完成 | skill=${skillName} | success=${data.success}`);
        if (data.success) {
          emitTerminalLine(`[结果] execute_skill detail ${skillName} | ${data.files?.length ?? 0} 个文件\n`);
        } else {
          emitTerminalLine(`[结果] execute_skill detail 失败: ${data.error ?? "未知错误"}\n`, "stderr");
        }
        return {
          action: "detail",
          success: data.success,
          name: data.name,
          description: data.description,
          body: data.body,
          files: data.files,
          error: data.error,
        };
      } else {
        // action === "run"
        if (!scriptFile) {
          return {
            action: "run",
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: "run 动作需要 scriptFile 参数",
            duration: 0,
          };
        }

        // 调用 /skill/run 端点
        const res = await fetch(`${sandbox.baseUrl}/skill/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillName,
            scriptFile,
            args: args ?? "",
            timeout: timeout ?? 60_000,
          }),
          signal: AbortSignal.timeout(120_000),
        });

        const data = await res.json() as SkillRunResponse;
        const elapsed = Date.now() - t0;

        console.log(`${tag} run 完成 | ${elapsed}ms | exitCode=${data.exitCode}`);
        const stdoutText = data.stdout?.trim() ?? "";
        const stderrText = data.stderr?.trim() ?? "";
        if (stdoutText) {
          const cappedStdout = stdoutText.length > 4000 ? stdoutText.slice(0, 4000) + "\n...<stdout truncated>" : stdoutText;
          emitTerminalLine(`[输出][${skillName}/${scriptFile}]\n${cappedStdout}\n`, "stdout");
        }
        if (stderrText) {
          const cappedStderr = stderrText.length > 4000 ? stderrText.slice(0, 4000) + "\n...<stderr truncated>" : stderrText;
          emitTerminalLine(`[错误输出][${skillName}/${scriptFile}]\n${cappedStderr}\n`, "stderr");
        }
        emitTerminalLine(
          `[结果] execute_skill run exitCode=${data.exitCode} duration=${data.duration}ms\n`,
          data.success ? "stdout" : "stderr",
        );

        return {
          action: "run",
          success: data.success,
          exitCode: data.exitCode,
          stdout: data.stdout,
          stderr: data.stderr,
          duration: data.duration,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 异常 | ${Date.now() - t0}ms | ${msg}`);
      emitTerminalLine(`[错误] execute_skill ${action} 异常: ${msg.slice(0, 200)}\n`, "stderr");
      return {
        action,
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: `Skill ${action} 失败: ${msg}`,
        duration: Date.now() - t0,
      };
    }
  },
});

/**
 * list_skills — 列出沙箱中可用的 Skill
 *
 * 查询沙箱容器的 /skill/list 端点，返回所有可用 Skill 的名称、描述和文件列表。
 */
export const listSkills = tool({
  description:
    "列出沙箱中可用的 Skill 列表（仅返回名称和描述，用于快速了解有哪些可用 Skill）。\n" +
    "选中 Skill 后，用 execute_skill(action=detail) 读取完整使用文档。",
  inputSchema: z.object({}),
  execute: async () => {
    const userId = getRequestUserKey();
    const threadId = getRequestThreadId() ?? "skill-session";
    const tag = `[SkillTool]`;

    try {
      emitTerminalLine("[命令] list_skills\n");
      const sandbox = await getOrCreateSandbox(userId, threadId);

      const res = await fetch(`${sandbox.baseUrl}/skill/list`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });

      const data = await res.json() as SkillListResponse;
      console.log(`${tag} 查询 Skill 列表 | 共 ${data.skills.length} 个`);
      const skillNames = data.skills.map((s) => s.name).join(", ");
      emitTerminalLine(`[结果] list_skills 共 ${data.skills.length} 个${skillNames ? `: ${skillNames}` : ""}\n`);
      markSkillsChecked();

      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 查询 Skill 列表失败: ${msg}`);
      emitTerminalLine(`[错误] list_skills 失败: ${msg.slice(0, 200)}\n`, "stderr");
      return {
        skills: [],
        error: `查询失败: ${msg}`,
      };
    }
  },
});
