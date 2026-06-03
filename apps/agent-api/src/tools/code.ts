/**
 * tools/code.ts — 代码与 UI 生成辅助工具
 *
 * saveCode  : 将生成的代码片段保存为临时文件并返回内容（前端展示用）。
 * formatCode: 对给定代码做简单格式化检查并返回注释（实际格式化由 LLM 完成）。
 *
 * 注意：此 Agent 不提供代码执行沙箱，代码运行需用户本地操作。
 */
import { tool } from "ai";
import { z } from "zod";

/** 支持的语言列表（用于语法高亮提示） */
const SUPPORTED_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "css",
  "html",
  "vue",
  "react",
  "bash",
  "sql",
  "json",
  "yaml",
  "markdown",
  "other",
] as const;

export const saveCode = tool({
  description:
    "保存一段代码片段到当前会话的临时存储，供前端展示代码块。返回代码内容及元信息。",
  inputSchema: z.object({
    filename: z.string().describe("文件名，如 Button.vue、util.ts、handler.py"),
    language: z
      .enum(SUPPORTED_LANGUAGES)
      .describe("编程语言，用于语法高亮"),
    code: z.string().describe("完整的代码内容"),
    description: z
      .string()
      .optional()
      .describe("可选：对这段代码的功能描述，方便前端展示"),
  }),
  execute: async ({ filename, language, code, description }) => {
    return {
      type: "code_artifact",
      filename,
      language,
      code,
      description: description ?? "",
      lines: code.split("\n").length,
      chars: code.length,
    };
  },
});

export const explainCode = tool({
  description:
    "对一段代码进行结构化分析：返回代码摘要、主要函数/类列表、潜在问题等，辅助用户理解代码。",
  inputSchema: z.object({
    code: z.string().describe("需要分析的源代码"),
    language: z.enum(SUPPORTED_LANGUAGES).optional().describe("编程语言（可省略，自动检测）"),
    focus: z
      .enum(["overview", "security", "performance", "bugs"])
      .default("overview")
      .describe("分析侧重点：概览 / 安全 / 性能 / Bug"),
  }),
  execute: async ({ code, language, focus }) => {
    // 此工具本身不调用 LLM，返回基础统计，真正的分析由主模型在上下文中生成
    const lines = code.split("\n");
    const nonEmpty = lines.filter((l: string) => l.trim().length > 0).length;
    const detectedLang =
      language ??
      (code.includes("func ") && code.includes(":=")
        ? "go"
        : code.includes("def ") && code.includes("self")
        ? "python"
        : code.includes("export const") || code.includes("interface ")
        ? "typescript"
        : "other");

    return {
      type: "code_analysis_request",
      language: detectedLang,
      focus,
      stats: {
        totalLines: lines.length,
        nonEmptyLines: nonEmpty,
        chars: code.length,
      },
      codeSnippet: code.slice(0, 200) + (code.length > 200 ? "..." : ""),
    };
  },
});
