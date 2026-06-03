/**
 * agents/index.ts — Agent 工厂 & 导出
 *
 * 使用 Vercel AI SDK v6 的 ToolLoopAgent，按职责拆分为：
 * - webAgent    : 网络搜索 & 抓取
 * - codeAgent   : 代码生成 & 分析
 * - imageAgent  : 图像生成
 * - comicsAgent : AI Comics 平台操作
 * - orchestrator: 主调度 Agent（携带 delegateToSubAgent 工具）
 */
import {
  ToolLoopAgent,
  stepCountIs,
  tool,
  type ToolSet,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { getChatModel } from "../model.js";
import { fetchWebpage } from "../tools/web.js";
import { generateImage } from "../tools/image.js";
import { saveCode, explainCode } from "../tools/code.js";
import {
  listProjects,
  getProjectDetail,
  listFragments,
  createFragment,
  triggerFragmentImage,
  listMaterials,
} from "../tools/comics.js";

// ── SubAgent 定义 ────────────────────────────────────────────

/** 网络搜索 & 抓取 SubAgent */
export const webAgent = new ToolLoopAgent({
  id: "web-agent",
  instructions: `你是一个专业的网络信息检索助手（Web Agent）。
能力：使用 fetchWebpage 抓取网页内容并做结构化摘要。
工作原则：直接调用工具，抓取目标页面，输出中文摘要并附来源 URL。`,
  model: getChatModel(),
  tools: { fetchWebpage } as ToolSet,
  stopWhen: stepCountIs(10),
});

/** 代码生成 & 分析 SubAgent */
export const codeAgent = new ToolLoopAgent({
  id: "code-agent",
  instructions: `你是一个高级代码工程师助手（Code Agent）。
能力：编写各类语言代码、使用 explainCode 分析代码、使用 saveCode 保存代码片段。
工作原则：代码用 Markdown 代码块，安全问题主动指出，生成的代码可直接运行。`,
  model: getChatModel(),
  tools: { saveCode, explainCode } as ToolSet,
  stopWhen: stepCountIs(10),
});

/** 图像生成 SubAgent */
export const imageAgent = new ToolLoopAgent({
  id: "image-agent",
  instructions: `你是一个专业的 AI 图像生成助手（Image Agent）。
能力：使用 generateImage 根据文字描述生成高质量图片。
工作原则：先优化提示词再调用工具，将优化后的英文提示词告知用户，给出 URL 并描述结果。`,
  model: getChatModel(),
  tools: { generateImage } as ToolSet,
  stopWhen: stepCountIs(5),
});

/** AI Comics 平台操作 SubAgent */
export const comicsAgent = new ToolLoopAgent({
  id: "comics-agent",
  instructions: `你是 AI Comics 平台操作助手（Comics Agent）。
能力：查看项目列表和详情、浏览片段、创建片段、触发分镜图生成、查看素材库。
工作原则：操作前确认项目 ID，结果以结构化摘要返回，不执行破坏性操作。`,
  model: getChatModel(),
  tools: {
    listProjects,
    getProjectDetail,
    listFragments,
    createFragment,
    triggerFragmentImage,
    listMaterials,
  } as ToolSet,
  stopWhen: stepCountIs(15),
});

// ── SubAgent 注册表 ──────────────────────────────────────────

/** SubAgent 名称到实例的映射 */
const subAgents: Record<string, ToolLoopAgent> = {
  "web-agent": webAgent,
  "code-agent": codeAgent,
  "image-agent": imageAgent,
  "comics-agent": comicsAgent,
};

// ── 委派工具（给 Orchestrator 使用） ─────────────────────────

/** Orchestrator 的核心工具：将任务委派给专业 SubAgent 执行 */
const delegateToSubAgent = tool({
  description: `将任务委派给专业 SubAgent 完成。可用的 SubAgent：
- web-agent: 网络搜索、网页抓取与摘要
- code-agent: 代码编写、分析、安全审计
- image-agent: 根据文字描述生成图片
- comics-agent: AI Comics 平台操作（项目、片段、素材）

选择最适合当前子任务的 SubAgent，并给出清晰的任务描述。`,
  inputSchema: z.object({
    agentId: z
      .enum(["web-agent", "code-agent", "image-agent", "comics-agent"])
      .describe("目标 SubAgent 的 ID"),
    task: z.string().describe("交给 SubAgent 的具体任务描述，需包含完成任务所需的所有上下文"),
  }),
  execute: async ({ agentId, task }) => {
    const agent = subAgents[agentId];
    if (!agent) {
      console.warn(`[Orchestrator] 未知的 SubAgent: ${agentId}`);
      return { error: `未知的 SubAgent: ${agentId}` };
    }
    console.log(`[Orchestrator] → 委派任务给 ${agentId}: ${task.slice(0, 120)}...`);
    try {
      const result = await agent.generate({
        prompt: task,
        onStepFinish: (step) => {
          const tools = (step.toolCalls ?? []).map((tc) => tc.toolName);
          console.log(`  [${agentId}] step#${step.stepNumber} ${step.finishReason} | 工具: ${tools.length ? tools.join(", ") : "无"} | 文本: ${(step.text ?? "").slice(0, 80)}`);
        },
      });
      const toolCount = result.steps.flatMap((s) => s.toolCalls ?? []).length;
      console.log(`[Orchestrator] ← ${agentId} 完成 | ${result.steps.length} 步 | ${toolCount} 次工具调用 | 文本: ${result.text.slice(0, 100)}`);
      return {
        agentId,
        text: result.text,
        steps: result.steps.length,
        toolCalls: toolCount,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Orchestrator] ✗ ${agentId} 失败: ${msg}`);
      return { agentId, error: msg };
    }
  },
});

// ── Orchestrator（主调度 Agent） ─────────────────────────────

const ORCHESTRATOR_INSTRUCTIONS = `你是 Kit Orchestrator，一个智能任务调度器。

## 架构
你管理以下专业 SubAgent，通过 delegateToSubAgent 工具分发子任务：
- **web-agent**: 网络搜索、网页抓取
- **code-agent**: 代码编写、分析、审计
- **image-agent**: 图像生成
- **comics-agent**: AI Comics 平台操作

## 工作流程
1. 分析用户需求，判断需要调用哪个/哪些 SubAgent
2. 将子任务通过 delegateToSubAgent 分发给合适的 SubAgent
3. 整合各 SubAgent 返回的结果，给出完整的中文回答
4. 对于简单问答，直接回答即可，无需委派

## 原则
- 多步复杂任务拆分为多次 SubAgent 调用
- 每次 delegateToSubAgent 的 task 参数要包含足够上下文
- 不要一次性委派所有子任务——先委派一个，等结果返回后再决定下一步
- 简单对话（闲聊、问好）直接回复，不要调用 SubAgent
- 默认用简体中文交流

## 当前时间
${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
`;

/**
 * 创建 Orchestrator Agent 实例。
 * 接受可选的 instructions 覆盖和步数配置。
 */
export function createOrchestrator(opts?: {
  instructions?: string;
  maxSteps?: number;
}): ToolLoopAgent {
  return new ToolLoopAgent({
    id: "orchestrator",
    instructions: opts?.instructions ?? ORCHESTRATOR_INSTRUCTIONS,
    model: getChatModel(),
    tools: { delegateToSubAgent } as ToolSet,
    stopWhen: stepCountIs(opts?.maxSteps ?? 30),
  });
}

/** 重新导出类型 */
export type { ModelMessage };
