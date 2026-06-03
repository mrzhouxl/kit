/**
 * tools/file.ts — 文件处理工具
 *
 * processFile : 在 Docker 沙箱中解析 Office / PDF 等文件，
 * 提取文本内容供 Agent 后续分析。
 *
 * 支持的格式：
 *   - Excel (.xlsx / .xls)
 *   - Word (.docx)
 *   - PowerPoint (.pptx)
 *   - PDF (.pdf)
 *   - CSV (.csv)
 *   - 纯文本 (.txt / .md / .json / .xml 等)
 *
 * 处理流程：
 *   1. 在沙箱内通过 Python 下载文件
 *   2. 根据扩展名选择对应解析库（openpyxl / python-docx / python-pptx / pdfplumber）
 *   3. 提取全部文本内容，实时输出进度到前端终端面板
 *   4. 返回提取结果给 Agent 继续处理
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
  sandboxExec,
  sandboxEvents,
} from "../sandbox/index.js";
import {
  getRequestSessionKey,
  getRequestThreadId,
  getRequestUserKey,
} from "../context/request-context.js";

/** 内容截断上限（避免超出 LLM 上下文窗口） */
const MAX_CONTENT_LENGTH = 50_000;

/** 支持的文件扩展名集合 */
const SUPPORTED_EXTENSIONS = new Set([
  ".xlsx", ".xls", ".docx", ".pptx", ".pdf", ".csv",
  ".txt", ".md", ".json", ".xml", ".log", ".yaml", ".yml",
]);

/** 发送文件处理进度到 SSE，右侧终端面板可实时展示。 */
function emitFileProgress(message: string, operation: string, stream: "stdout" | "stderr" = "stdout") {
  const sessionKey = getRequestSessionKey() ?? "";
  const threadId = getRequestThreadId() ?? "";

  sandboxEvents.emit("event", {
    sessionKey,
    userId: "",
    threadId,
    event: {
      type: "status",
      state: "busy",
      operation,
    },
  });

  sandboxEvents.emit("event", {
    sessionKey,
    userId: "",
    threadId,
    event: {
      type: "stdout",
      data: `[文件处理] ${message}\n`,
      stream,
    },
  });
}

/**
 * 生成沙箱内执行的 Python 文件处理脚本。
 *
 * 脚本执行流程：
 *   1. 下载文件到沙箱本地
 *   2. 根据扩展名分发到对应解析逻辑
 *   3. 通过 stdout 输出进度信息（实时推送到前端终端）
 *   4. 最终以 JSON 格式输出提取结果
 *
 * @param fileUrl  - 文件下载 URL
 * @param fileName - 原始文件名（含扩展名）
 */
function buildExtractScript(fileUrl: string, fileName: string): string {
  // 对 URL 和文件名中的特殊字符进行安全转义
  const safeUrl = fileUrl.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const safeName = fileName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  return `# -*- coding: utf-8 -*-
"""沙箱文件处理脚本 — 自动生成，请勿手动编辑"""
import sys
import os
import json
import urllib.request
import ssl

# ── 辅助函数 ──────────────────────────────────────────────────

def progress(msg):
    """输出进度信息（实时推送到前端终端面板）"""
    print(f"[文件处理] {msg}", flush=True)

def safe_str(val):
    """安全转换为字符串"""
    if val is None:
        return ""
    return str(val)

# ── 主流程 ────────────────────────────────────────────────────

file_url = '${safeUrl}'
file_name = '${safeName}'
ext = os.path.splitext(file_name)[1].lower()

# 1. 下载文件
progress(f"正在下载文件: {file_name}")
try:
    # 创建不验证 SSL 的上下文（沙箱内网/CDN 场景）
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    urllib.request.urlretrieve(file_url, file_name, context=ctx)
    file_size = os.path.getsize(file_name)
    if file_size > 100 * 1024 * 1024:
        print(json.dumps({"success": False, "error": "文件超过 100MB 限制"}, ensure_ascii=False))
        sys.exit(0)
    size_str = f"{file_size / 1024:.1f} KB" if file_size < 1024 * 1024 else f"{file_size / (1024*1024):.1f} MB"
    progress(f"下载完成 ({size_str})")
except Exception as e:
    print(json.dumps({"success": False, "error": f"下载失败: {e}"}, ensure_ascii=False))
    sys.exit(0)

# 2. 根据文件类型提取内容
content = ""
metadata = {}

try:
    # ── Excel ─────────────────────────────────────────────
    if ext in ('.xlsx', '.xls'):
        from openpyxl import load_workbook
        wb = load_workbook(file_name, read_only=True, data_only=True)
        sheets = wb.sheetnames
        progress(f"Excel 文件包含 {len(sheets)} 个工作表: {', '.join(sheets)}")

        result_parts = []
        total_rows = 0
        for sheet_name in sheets:
            ws = wb[sheet_name]
            progress(f"正在提取工作表: {sheet_name}")
            rows = []
            for row in ws.iter_rows(values_only=True):
                row_text = '\\t'.join(safe_str(cell) for cell in row)
                rows.append(row_text)
            total_rows += len(rows)
            result_parts.append(f"=== 工作表: {sheet_name} ({len(rows)} 行) ===\\n" + '\\n'.join(rows))

        content = '\\n\\n'.join(result_parts)
        metadata = {"type": "excel", "sheets": sheets, "sheet_count": len(sheets), "total_rows": total_rows}
        wb.close()

    # ── Word ──────────────────────────────────────────────
    elif ext == '.docx':
        from docx import Document
        doc = Document(file_name)
        progress(f"Word 文档包含 {len(doc.paragraphs)} 个段落")

        parts = []
        for para in doc.paragraphs:
            if para.text.strip():
                parts.append(para.text)

        # 提取表格
        if doc.tables:
            progress(f"发现 {len(doc.tables)} 个表格")
            for ti, table in enumerate(doc.tables):
                parts.append(f"\\n=== 表格 {ti + 1} ===")
                for row in table.rows:
                    row_text = '\\t'.join(cell.text for cell in row.cells)
                    parts.append(row_text)

        content = '\\n'.join(parts)
        metadata = {"type": "word", "paragraphs": len(doc.paragraphs), "tables": len(doc.tables)}

    # ── PowerPoint ────────────────────────────────────────
    elif ext == '.pptx':
        from pptx import Presentation
        prs = Presentation(file_name)
        progress(f"PPT 包含 {len(prs.slides)} 张幻灯片")

        parts = []
        for si, slide in enumerate(prs.slides):
            progress(f"正在提取幻灯片 {si + 1}/{len(prs.slides)}")
            slide_parts = [f"=== 幻灯片 {si + 1} ==="]
            for shape in slide.shapes:
                if hasattr(shape, 'text') and shape.text.strip():
                    slide_parts.append(shape.text)
            # 提取备注
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                notes = slide.notes_slide.notes_text_frame.text.strip()
                if notes:
                    slide_parts.append(f"[备注] {notes}")
            parts.append('\\n'.join(slide_parts))

        content = '\\n\\n'.join(parts)
        metadata = {"type": "pptx", "slides": len(prs.slides)}

    # ── PDF ───────────────────────────────────────────────
    elif ext == '.pdf':
        import pdfplumber
        pdf = pdfplumber.open(file_name)
        progress(f"PDF 包含 {len(pdf.pages)} 页")

        parts = []
        for pi, page in enumerate(pdf.pages):
            progress(f"正在提取第 {pi + 1}/{len(pdf.pages)} 页")
            text = page.extract_text()
            if text:
                parts.append(f"=== 第 {pi + 1} 页 ===\\n{text}")

        content = '\\n\\n'.join(parts)
        metadata = {"type": "pdf", "pages": len(pdf.pages)}
        pdf.close()

    # ── CSV ───────────────────────────────────────────────
    elif ext == '.csv':
        import csv
        with open(file_name, 'r', encoding='utf-8', errors='replace') as f:
            reader = csv.reader(f)
            rows = list(reader)
        progress(f"CSV 包含 {len(rows)} 行")
        content = '\\n'.join('\\t'.join(row) for row in rows)
        metadata = {"type": "csv", "rows": len(rows)}

    # ── 纯文本 ────────────────────────────────────────────
    else:
        with open(file_name, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        progress(f"文本文件 ({len(content)} 字符)")
        metadata = {"type": "text", "chars": len(content)}

    progress("提取完成")

    # 3. 截断过长内容
    truncated = False
    original_length = len(content)
    if len(content) > ${MAX_CONTENT_LENGTH}:
        content = content[:${MAX_CONTENT_LENGTH}]
        truncated = True
        progress(f"内容已截断 (原始 {original_length} 字符，保留前 ${MAX_CONTENT_LENGTH} 字符)")

    metadata["truncated"] = truncated
    metadata["content_length"] = min(original_length, ${MAX_CONTENT_LENGTH})
    metadata["original_length"] = original_length

    # 4. 输出结果（JSON 格式，Agent 端解析）
    print("===FILE_RESULT_START===")
    print(json.dumps({"success": True, "content": content, "metadata": metadata, "sandboxPath": os.path.abspath(file_name)}, ensure_ascii=False))
    print("===FILE_RESULT_END===")

except Exception as e:
    import traceback
    progress(f"处理失败: {e}")
    print("===FILE_RESULT_START===")
    print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}, ensure_ascii=False))
    print("===FILE_RESULT_END===")

# 5. 保留文件在沙箱中（不删除），后续修改可直接操作
# 文件保存路径: /home/sandbox/{file_name}
final_path = os.path.abspath(file_name)
progress(f"文件已保留在沙箱: {final_path}")
`;
}

/**
 * 从沙箱执行结果的 stdout 中解析文件处理结果 JSON。
 * 查找 ===FILE_RESULT_START=== 和 ===FILE_RESULT_END=== 之间的内容。
 */
function parseFileResult(stdout: string): {
  success: boolean;
  content?: string;
  metadata?: Record<string, unknown>;
  sandboxPath?: string;
  error?: string;
} {
  const startMarker = "===FILE_RESULT_START===";
  const endMarker = "===FILE_RESULT_END===";

  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { success: false, error: "未找到文件处理结果" };
  }

  const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return { success: false, error: `结果解析失败: ${jsonStr.slice(0, 200)}` };
  }
}

// ── 工具定义 ─────────────────────────────────────────────────

export const processFile = tool({
  description:
    "在安全的 Docker 沙箱中解析文件，提取文本内容。" +
    "支持 Excel (.xlsx)、Word (.docx)、PowerPoint (.pptx)、PDF (.pdf)、CSV 及纯文本。" +
    "处理过程会实时推送进度到用户界面。适用于用户上传附件后需要读取、分析、摘要文件内容的场景。",
  inputSchema: z.object({
    fileUrl: z.string().url()
      .describe("文件的下载 URL 地址（通常来自用户上传附件的 URL）"),
    fileName: z.string()
      .describe("原始文件名（必须含扩展名，如 report.xlsx、合同.docx）"),
  }),
  execute: async ({ fileUrl, fileName }) => {
    const userId = getRequestUserKey();
    const threadId = getRequestThreadId() ?? "file-session";
    const tag = "[FileTool]";
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";

    console.log(`${tag} 开始 | 文件: ${fileName} | 扩展名: ${ext} | user=${userId}`);
    const t0 = Date.now();

    // 校验文件类型
    if (ext && !SUPPORTED_EXTENSIONS.has(ext)) {
      console.warn(`${tag} 不支持的文件类型: ${ext}`);
      emitFileProgress(`不支持的文件类型: ${ext}`, "file:validate", "stderr");
      return {
        success: false,
        error: `不支持的文件类型: ${ext}，支持: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
        content: "",
        metadata: {},
      };
    }

    try {
      // 获取或创建沙箱
      console.log(`${tag} 获取沙箱容器...`);
      emitFileProgress(`准备处理文件 ${fileName}`, "file:prepare");
      const sandbox = await getOrCreateSandbox(userId, threadId);
      console.log(`${tag} 沙箱就绪 | container=${sandbox.containerId.slice(0, 12)}`);
      emitFileProgress("沙箱就绪，开始解析文件", "file:exec");

      // 生成 Python 提取脚本并在沙箱中执行
      const script = buildExtractScript(fileUrl, fileName);
      console.log(`${tag} 执行 Python 提取脚本...`);

      const result = await sandboxExec(sandbox, {
        language: "python",
        code: script,
        timeout: 120_000, // 文件处理允许最多 2 分钟
      });

      console.log(`${tag} 完成 | 总耗时=${Date.now() - t0}ms | exitCode=${result.exitCode}`);

      // 解析结果
      const parsed = parseFileResult(result.stdout);

      if (!parsed.success) {
        emitFileProgress(parsed.error ?? "文件处理失败", "file:failed", "stderr");
        return {
          success: false,
          error: parsed.error ?? "文件处理失败",
          content: "",
          metadata: {},
          stderr: result.stderr,
        };
      }

      const contentLength = typeof parsed.content === "string" ? parsed.content.length : 0;
      emitFileProgress(`解析完成，提取内容 ${contentLength} 字符`, "file:done");

      return {
        success: true,
        content: parsed.content ?? "",
        metadata: parsed.metadata ?? {},
        fileName,
        sandboxPath: (parsed as { sandboxPath?: string }).sandboxPath ?? "",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 异常 | 总耗时=${Date.now() - t0}ms | error=${msg}`);
      emitFileProgress(`文件处理失败: ${msg}`, "file:error", "stderr");
      return {
        success: false,
        error: `文件处理失败: ${msg}`,
        content: "",
        metadata: {},
      };
    }
  },
});
