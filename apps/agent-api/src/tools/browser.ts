/**
 * tools/browser.ts — 沙箱浏览器操作工具
 *
 * browseWeb    : 通过 Docker 沙箱内的 Playwright 访问和操作网页
 *
 * 与 web.ts 的 fetchWebpage 不同：
 * - 使用真实浏览器（支持 JS 渲染、SPA、交互）
 * - 实时推送浏览器画面帧（CDP Screencast → SSE）
 * - 支持点击、输入、滚动等交互操作
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
  sandboxBrowse,
} from "../sandbox/index.js";
import {
  getRequestThreadId,
  getRequestUserKey,
} from "../context/request-context.js";

/** 浏览器操作步骤 schema */
const actionSchema = z.object({
  action: z.enum(["click", "type", "scroll", "screenshot", "wait", "content", "inspect"])
    .describe("操作类型：inspect 返回页面可交互元素列表（选择器、文本、类型），在点击/输入前务必先 inspect 获取正确选择器"),
  selector: z.string().optional().describe("CSS 选择器（click/type/wait 需要）"),
  text: z.string().optional().describe("输入文本（type 需要）"),
  direction: z.enum(["up", "down"]).optional().describe("滚动方向（scroll 使用，默认 down）"),
  distance: z.number().optional().describe("滚动距离像素（scroll 使用，默认 500）"),
  timeout: z.number().optional().describe("操作超时毫秒数（click/type/wait 使用，默认 10000）"),
});

export const browseWeb = tool({
  description:
    "使用浏览器访问网页并进行交互操作。支持导航、点击、输入、滚动、截图、提取内容。" +
    "浏览器画面会实时推送给用户。适合需要 JS 渲染的页面、SPA 应用、需要交互的场景。",
  inputSchema: z.object({
    url: z.string().url().describe("要访问的网页 URL"),
    actions: z.array(actionSchema).optional()
      .describe("导航到 URL 后要执行的操作序列（可选）。不填则只访问页面并返回截图。"),
  }),
  execute: async ({ url, actions }) => {
    const userId = getRequestUserKey();
    const threadId = getRequestThreadId() ?? "browse-session";
    const tag = `[BrowseTool]`;

    console.log(`${tag} 开始 | url=${url} | actions=${actions?.length ?? 0}个 | user=${userId} | thread=${threadId}`);
    const t0 = Date.now();

    try {
      // 获取或创建沙箱
      console.log(`${tag} 获取沙箱容器...`);
      const sandboxT0 = Date.now();
      const sandbox = await getOrCreateSandbox(userId, threadId);
      console.log(`${tag} 沙箱就绪 | 耗时=${Date.now() - sandboxT0}ms | container=${sandbox.containerId.slice(0, 12)} | url=${sandbox.baseUrl}`);

      // 先导航到目标 URL
      console.log(`${tag} [goto] 导航到 ${url}`);
      const gotoT0 = Date.now();
      const gotoResult = await sandboxBrowse(sandbox, { action: "goto", url });
      console.log(`${tag} [goto] 完成 | 耗时=${Date.now() - gotoT0}ms | success=${gotoResult.success} | title=${gotoResult.data?.title ?? ''} | url=${gotoResult.data?.url ?? ''}`);
      if (!gotoResult.success) {
        console.error(`${tag} [goto] 失败: ${gotoResult.error}`);
        return { error: gotoResult.error, url };
      }

      const results: Array<{ action: string; success: boolean; data?: unknown; error?: string }> = [];
      results.push({
        action: "goto",
        success: true,
        data: { title: gotoResult.data?.title, url: gotoResult.data?.url },
      });

      // 执行后续操作序列
      if (actions && actions.length > 0) {
        for (let i = 0; i < actions.length; i++) {
          const act = actions[i];
          const actDesc = `${act.action}${act.selector ? ` (${act.selector})` : ''}${act.text ? ` text="${act.text.slice(0, 30)}"` : ''}`;
          console.log(`${tag} [${i + 1}/${actions.length}] ${actDesc}`);
          const actT0 = Date.now();
          const result = await sandboxBrowse(sandbox, act);
          console.log(`${tag} [${i + 1}/${actions.length}] 完成 | 耗时=${Date.now() - actT0}ms | success=${result.success}${result.error ? ` | error=${result.error}` : ''}`);
          results.push({
            action: act.action,
            success: result.success,
            data: result.data ? {
              title: result.data.title,
              url: result.data.url,
              content: result.data.content,
              elements: result.data.elements,
              // 不返回截图 base64（太大），截图通过 SSE screencast 实时推送
            } : undefined,
            error: result.error,
            // 超时时附带可用元素帮助修正选择器
            ...(result.availableElements ? { availableElements: result.availableElements } : {}),
          });
          if (!result.success) {
            console.warn(`${tag} 操作链在步骤 ${i + 1} 失败，中止后续操作`);
            break;
          }
        }
      }

      // 检查 actions 中是否包含显式的 content 操作，
      // 仅在有 content action 或无任何 action 时自动提取页面文本。
      // 这避免了 inspect-only 调用返回搜索页摘要文本，
      // 让 Agent 必须主动 click 进入目标页面后再请求 content。
      const hasExplicitContent = actions?.some((a) => a.action === "content");
      const shouldAutoContent = !actions || actions.length === 0;
      let pageContent = "";

      if (hasExplicitContent || shouldAutoContent) {
        console.log(`${tag} [content] 提取页面文本...`);
        const contentT0 = Date.now();
        const contentResult = await sandboxBrowse(sandbox, { action: "content" });
        pageContent = contentResult.data?.content ?? "";
        console.log(`${tag} [content] 完成 | 耗时=${Date.now() - contentT0}ms | 文本长度=${pageContent.length}`);
      } else {
        console.log(`${tag} [content] 跳过自动提取（actions 不含 content）`);
      }

      console.log(`${tag} 全部完成 | 总耗时=${Date.now() - t0}ms | 操作数=${results.length}`);
      return {
        url: gotoResult.data?.url ?? url,
        title: gotoResult.data?.title ?? "",
        ...(pageContent ? { content: pageContent } : {}),
        operations: results,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 异常 | 耗时=${Date.now() - t0}ms | error=${msg}`);
      return { error: `浏览器操作失败: ${msg}`, url };
    }
  },
});
