/**
 * tools/web.ts — 网页抓取工具
 *
 * fetchWebpage  : 抓取指定 URL 的正文文本，供 Agent 分析内容。
 */
import { tool } from "ai";
import { load } from "cheerio";
import { z } from "zod";
import { sandboxEvents } from "../sandbox/index.js";
import {
  getRequestSessionKey,
  getRequestThreadId,
} from "../context/request-context.js";

/** 最长保留的正文字符数，避免超出 context window */
const MAX_CONTENT_LENGTH = 8000;

// ---------- fetchWebpage ----------

export const fetchWebpage = tool({
  description:
    "抓取指定 URL 的网页内容并提取正文文本，适合分析文章、文档、产品页面等。返回页面标题和正文内容。",
  inputSchema: z.object({
    url: z.string().url().describe("要抓取的完整 URL，必须以 http:// 或 https:// 开头"),
    selector: z
      .string()
      .optional()
      .describe("可选：CSS 选择器，仅提取匹配元素的文本（如 'article', 'main', '.content'）"),
  }),
  execute: async ({ url, selector }) => {
    // 通知前端正在抓取的 URL，同步更新右侧面板显示
    const sessionKey = getRequestSessionKey();
    const threadId = getRequestThreadId();
    if (sessionKey) {
      sandboxEvents.emit("event", {
        sessionKey,
        userId: "",
        threadId: threadId ?? "",
        event: { type: "navigate", url, title: "正在抓取页面..." },
      });
    }

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; AIComicsAgent/1.0; +https://aicomics.app)",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        return { error: `HTTP ${res.status}: ${res.statusText}`, url };
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html") && !contentType.includes("text")) {
        return { error: "不支持的内容类型: " + contentType, url };
      }

      const html = await res.text();
      const $ = load(html);

      // 移除无用标签
      $("script, style, nav, footer, header, aside, [class*='ad'], [id*='ad']").remove();

      const title = $("title").first().text().trim();

      let text: string;
      if (selector) {
        text = $(selector).text();
      } else {
        // 优先取语义化主体区域
        const main =
          $("article, main, [role='main'], .content, .post-content, .article-body").first();
        text = main.length ? main.text() : $("body").text();
      }

      // 规范化空白
      text = text.replace(/\s{3,}/g, "\n\n").trim();
      if (text.length > MAX_CONTENT_LENGTH) {
        text = text.slice(0, MAX_CONTENT_LENGTH) + "\n\n[...内容已截断]";
      }

      // 抓取完成，更新右侧面板标题
      if (sessionKey) {
        sandboxEvents.emit("event", {
          sessionKey,
          userId: "",
          threadId: threadId ?? "",
          event: { type: "navigate", url, title: title || url },
        });
      }

      return { title, url, content: text, length: text.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `抓取失败: ${msg}`, url };
    }
  },
});


