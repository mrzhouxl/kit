/**
 * skills/types.ts — Skill 类型定义
 *
 * Skill 以 SKILL.md（Markdown + YAML frontmatter）为核心定义文件，
 * 复杂 Skill 可附带脚本文件供沙箱执行。
 *
 * 工作流程：
 * 1. list_skills → 返回 name + description（轻量路由）
 * 2. execute_skill(detail) → 返回完整 SKILL.md 内容供 LLM 阅读
 * 3. LLM 根据文档用 execute_code 安装依赖
 * 4. execute_skill(run) → 执行脚本
 */

// ── SKILL.md frontmatter 元数据 ─────────────────────────────

/** SKILL.md frontmatter 解析后的元数据 */
export interface SkillMeta {
  /** Skill 唯一标识 */
  name: string;
  /** 功能描述 */
  description: string;
  /** 版本号 */
  version?: string;
  /** SKILL.md body（完整 Markdown 内容，供 LLM 阅读） */
  body: string;
  /** Skill 所在目录的绝对路径 */
  dirPath: string;
  /** 附带的脚本文件列表（相对于 skill 目录） */
  files: string[];
}

// ── Skill 运行时类型（Agent 侧）─────────────────────────────

/** Skill 摘要信息（供 list_skills 返回，仅路由选择用） */
export interface SkillSummary {
  name: string;
  description: string;
}

// ── Sandbox Skill 执行协议（Agent ↔ Sandbox Server）────────

/** GET /skill/detail/:name 响应体 */
export interface SkillDetailResponse {
  success: boolean;
  name?: string;
  description?: string;
  version?: string;
  /** SKILL.md 完整 Markdown 内容 */
  body?: string;
  /** 附带的脚本文件列表 */
  files?: string[];
  error?: string;
}

/** POST /skill/run 请求体：执行 Skill 脚本 */
export interface SkillRunRequest {
  /** Skill 名称 */
  skillName: string;
  /** 要执行的脚本文件（相对于 skill 目录，如 scripts/analyze.py） */
  scriptFile: string;
  /** 命令行参数 */
  args?: string;
  /** 执行超时毫秒数（默认 60000） */
  timeout?: number;
}

/** POST /skill/run 响应体 */
export interface SkillRunResponse {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 执行耗时毫秒 */
  duration: number;
}

/** GET /skill/list 响应体 */
export interface SkillListResponse {
  skills: SkillSummary[];
}
