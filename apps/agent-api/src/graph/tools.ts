/**
 * graph/tools.ts — LangChain 工具注册表
 *
 * 将现有 Vercel AI SDK 工具适配为 LangChain DynamicStructuredTool，
 * 并按 Agent 类型分组导出，供各 Worker Agent 节点使用。
 *
 * 适配策略：复用现有工具的 execute 函数，避免重复业务逻辑。
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { hasCheckedSkills } from "../context/request-context.js";

// ── 导入现有 Vercel AI SDK 工具 ──────────────────────────────
import { messageNotifyUser } from "../tools/notify.js";
import { fetchWebpage } from "../tools/web.js";
import { browseWeb } from "../tools/browser.js";
import { editImage, generateImage } from "../tools/image.js";
import { generateVideo } from "../tools/video.js";
import { saveCode, explainCode } from "../tools/code.js";
import { executeCode } from "../tools/sandbox-exec.js";
import { processFile } from "../tools/file.js";
import { uploadSandboxFile } from "../tools/sandbox-upload.js";
import { listSandboxFiles } from "../tools/sandbox-list.js";
import {
  listProjects,
  getProjectDetail,
  listFragments,
  createFragment,
  triggerFragmentImage,
  listMaterials,
} from "../tools/comics.js";
import { executeSkill, listSkills } from "../tools/skill.js";

// ── 通用适配器 ──────────────────────────────────────────────

/**
 * 将 Vercel AI SDK tool() 创建的工具适配为 LangChain DynamicStructuredTool。
 *
 * Vercel AI SDK tool 运行时结构：{ description, inputSchema/parameters, execute }
 * LangChain DynamicStructuredTool 需要：{ name, description, schema, func }
 *
 * @param name - 工具名称（LangChain 要求显式命名）
 * @param vercelTool - Vercel AI SDK tool() 返回的对象
 */
function adaptTool(name: string, vercelTool: Record<string, unknown>): DynamicStructuredTool {
  // Vercel AI SDK v6 使用 inputSchema，部分版本使用 parameters
  const schema = (vercelTool.inputSchema ?? vercelTool.parameters) as
    import("zod").ZodObject<Record<string, import("zod").ZodTypeAny>>;

  if (!schema) {
    throw new Error(`工具 "${name}" 缺少 inputSchema 或 parameters 属性`);
  }

  const description = (vercelTool.description as string) ?? "";
  const executeFn = vercelTool.execute as (input: unknown) => Promise<unknown>;

  const requiresSkillCheck = new Set(["execute_code", "process_file", "execute_skill"]);

  if (typeof executeFn !== "function") {
    throw new Error(`工具 "${name}" 缺少 execute 函数`);
  }

  return new DynamicStructuredTool({
    name,
    description,
    schema,
    func: async (input: Record<string, unknown>) => {
      try {
        if (requiresSkillCheck.has(name) && !hasCheckedSkills()) {
          const msg = `调用 ${name} 前必须先调用 list_skills，先检查当前可用 skills，再决定使用 skill 还是普通代码方案。`;
          console.warn(`[Tool] ${name} 被拦截: ${msg}`);
          return JSON.stringify({ error: msg, requiresSkillCheck: true });
        }

        const result = await executeFn(input);
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        // 必须返回字符串而非抛异常，否则 LangGraph 无法生成 tool message，
        // 导致 "insufficient tool messages following tool_calls message" 错误
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Tool] ${name} 执行异常: ${msg}`);
        return JSON.stringify({ error: msg });
      }
    },
  });
}

// ── 按 Agent 分组的工具集 ────────────────────────────────────

/** 通知工具：所有 Agent 共享，用于向用户发送动态状态通知 */
const notifyTool = adaptTool("message_notify_user", messageNotifyUser as unknown as Record<string, unknown>);

/** Web Agent 工具集：网络搜索 & 浏览器操作 & 网页抓取 */
export const webTools = [
  notifyTool,
  adaptTool("browse_web", browseWeb as unknown as Record<string, unknown>),
  // adaptTool("fetch_webpage", fetchWebpage as unknown as Record<string, unknown>),
];

/** Code Agent 工具集：代码生成 & 分析 & 沙箱执行 & 文件处理 & 文件上传 & 文件列表 & Skill 执行 */
export const codeTools = [
  notifyTool,
  adaptTool("save_code", saveCode as unknown as Record<string, unknown>),
  adaptTool("explain_code", explainCode as unknown as Record<string, unknown>),
  adaptTool("execute_code", executeCode as unknown as Record<string, unknown>),
  adaptTool("process_file", processFile as unknown as Record<string, unknown>),
  adaptTool("upload_sandbox_file", uploadSandboxFile as unknown as Record<string, unknown>),
  adaptTool("list_sandbox_files", listSandboxFiles as unknown as Record<string, unknown>),
  adaptTool("execute_skill", executeSkill as unknown as Record<string, unknown>),
  adaptTool("list_skills", listSkills as unknown as Record<string, unknown>),
];

/** Image Agent 工具集：图像生成 */
export const imageTools = [
  notifyTool,
  adaptTool("generate_image", generateImage as unknown as Record<string, unknown>),
  adaptTool("edit_image", editImage as unknown as Record<string, unknown>),
  adaptTool("generate_video", generateVideo as unknown as Record<string, unknown>),
];

/** Comics Agent 工具集：AI Comics 平台操作 */
export const comicsTools = [
  notifyTool,
  adaptTool("list_projects", listProjects as unknown as Record<string, unknown>),
  adaptTool("get_project_detail", getProjectDetail as unknown as Record<string, unknown>),
  adaptTool("list_fragments", listFragments as unknown as Record<string, unknown>),
  adaptTool("create_fragment", createFragment as unknown as Record<string, unknown>),
  adaptTool("trigger_fragment_image", triggerFragmentImage as unknown as Record<string, unknown>),
  adaptTool("list_materials", listMaterials as unknown as Record<string, unknown>),
];

/** 全部工具（扁平列表），供调试或通用 Agent 使用 */
export const allLangChainTools = [
  ...webTools,
  ...codeTools,
  ...imageTools,
  ...comicsTools,
];

/** 沙箱工具列表（需要 Docker 环境的工具） */
export const sandboxTools = [
  adaptTool("browse_web", browseWeb as unknown as Record<string, unknown>),
  adaptTool("execute_code", executeCode as unknown as Record<string, unknown>),
];

/** Agent 名称 → 工具集的映射表，便于动态查找 */
export const toolsByAgent: Record<string, DynamicStructuredTool[]> = {
  web_agent: webTools,
  code_agent: codeTools,
  image_agent: imageTools,
  comics_agent: comicsTools,
};
