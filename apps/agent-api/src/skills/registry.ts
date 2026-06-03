/**
 * skills/registry.ts — Skill 注册中心（OpenClaw 兼容格式）
 *
 * 启动时扫描 skills/ 目录，加载所有 SKILL.md 并解析 YAML frontmatter。
 * SKILL.md body 作为 Agent 提示词注入，附带的脚本文件供沙箱执行。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillMeta, SkillSummary } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Skill 注册表：name → meta */
const skillMap = new Map<string, SkillMeta>();

/**
 * Skills 根目录。
 * 编译后 __dirname 指向 dist/skills/，但 SKILL.md 和脚本在 src/skills/。
 * 通过将 /dist/ 替换为 /src/ 得到源码目录路径。
 * 若不在 dist 下运行（如 ts-node），则直接使用 __dirname。
 */
const SKILLS_DIR = process.env.SKILLS_DIR || __dirname.replace(/[/\\]dist[/\\]skills/, "/src/skills");

// ── YAML frontmatter 解析 ───────────────────────────────────

/**
 * 解析 SKILL.md 中的 YAML frontmatter 和 body。
 * 使用简单正则提取，避免引入外部 YAML 解析库。
 */
function parseSkillMd(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    // 无 frontmatter，整个文件作为 body
    return { frontmatter: {}, body: content.trim() };
  }

  const rawYaml = match[1];
  const body = match[2].trim();

  // 简易 YAML 解析：提取 key: value 对（支持简单类型和缩进列表）
  const frontmatter = parseSimpleYaml(rawYaml);

  return { frontmatter, body };
}

/**
 * 简易 YAML 解析器。
 * 支持：字符串值、数字、布尔、简单列表（- item）、嵌套对象（缩进层级）。
 * 不支持：复杂 YAML 特性（锚点、流式集合等）。
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // 跳过空行和纯注释
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }

    // 检查是否是 key: value 格式（顶层，无缩进）
    const kvMatch = line.match(/^(\w[\w.-]*):\s*(.*)/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1];
    const inlineValue = kvMatch[2].trim();

    if (inlineValue && !inlineValue.startsWith("#")) {
      // 内联值：尝试 JSON 解析（处理对象/数组），否则作为字符串
      if (inlineValue.startsWith("{") || inlineValue.startsWith("[")) {
        try { result[key] = JSON.parse(inlineValue); } catch { result[key] = inlineValue; }
      } else if (inlineValue === "true") {
        result[key] = true;
      } else if (inlineValue === "false") {
        result[key] = false;
      } else if (/^\d+(\.\d+)?$/.test(inlineValue)) {
        result[key] = Number(inlineValue);
      } else {
        // 去除引号
        result[key] = inlineValue.replace(/^["']|["']$/g, "");
      }
      i++;
    } else {
      // 无内联值 → 检查子内容（列表或嵌套对象）
      i++;
      const subLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].startsWith("\t") || lines[i].trim() === "")) {
        if (lines[i].trim()) {
          subLines.push(lines[i].replace(/^  /, "").replace(/^\t/, ""));
        }
        i++;
      }

      if (subLines.length > 0) {
        // 判断是列表还是嵌套对象
        if (subLines[0].trim().startsWith("- ")) {
          // 简单列表
          result[key] = subLines
            .filter((l) => l.trim().startsWith("- "))
            .map((l) => l.trim().replace(/^- /, "").replace(/^["']|["']$/g, ""));
        } else {
          // 嵌套对象，递归解析
          result[key] = parseSimpleYaml(subLines.join("\n"));
        }
      }
    }
  }

  return result;
}

// ── 文件扫描 ────────────────────────────────────────────────

/**
 * 递归扫描目录下的所有文件（排除 SKILL.md 本身）。
 */
function scanFiles(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanFiles(fullPath, baseDir));
    } else if (entry.name.toLowerCase() !== "skill.md") {
      files.push(relative(baseDir, fullPath).replace(/\\/g, "/"));
    }
  }
  return files;
}

// ── 公开 API ────────────────────────────────────────────────

/**
 * 扫描 skills/ 目录，加载所有包含 SKILL.md 的子目录。
 * 在服务启动时调用一次。
 */
export function loadAllSkills(): void {
  skillMap.clear();

  if (!existsSync(SKILLS_DIR)) {
    console.warn(`[SkillRegistry] skills 目录不存在: ${SKILLS_DIR}`);
    return;
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = resolve(SKILLS_DIR, entry.name);
    // 支持 SKILL.md 和 skill.md 两种命名
    const mdPath = existsSync(resolve(skillDir, "SKILL.md"))
      ? resolve(skillDir, "SKILL.md")
      : existsSync(resolve(skillDir, "skill.md"))
        ? resolve(skillDir, "skill.md")
        : null;

    if (!mdPath) continue;

    try {
      const raw = readFileSync(mdPath, "utf-8");
      const { frontmatter, body } = parseSkillMd(raw);

      const name = (frontmatter.name as string) || entry.name;
      const description = (frontmatter.description as string) || "";
      const version = frontmatter.version as string | undefined;

      // 扫描附带的文件
      const files = scanFiles(skillDir, skillDir);

      const meta: SkillMeta = {
        name,
        description,
        version,
        body,
        dirPath: skillDir,
        files,
      };

      skillMap.set(name, meta);
      const fileCount = files.length;
      console.log(`[SkillRegistry] 已加载: ${name} | ${fileCount} 个附带文件`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SkillRegistry] 加载 SKILL.md 失败: ${mdPath} | ${msg}`);
    }
  }

  console.log(`[SkillRegistry] 共加载 ${skillMap.size} 个 Skill`);
}

/**
 * 获取指定 Skill 的完整元数据。
 */
export function getSkill(name: string): SkillMeta | undefined {
  return skillMap.get(name);
}

/**
 * 获取 Skill 的 body（Markdown 指令内容），用于注入 Agent 提示词。
 */
export function getSkillPrompt(name: string): string | undefined {
  return skillMap.get(name)?.body;
}

/**
 * 获取所有已注册 Skill 的摘要列表（仅 name + description）。
 */
export function listSkills(): SkillSummary[] {
  const result: SkillSummary[] = [];

  for (const skill of skillMap.values()) {
    result.push({
      name: skill.name,
      description: skill.description,
    });
  }

  return result;
}

/**
 * 获取 Skills 根目录的绝对路径。
 * 供 sandbox-manager 使用，作为容器 bind mount 的源路径。
 */
export function getSkillsDir(): string {
  return SKILLS_DIR;
}

// 模块加载时自动扫描
loadAllSkills();
