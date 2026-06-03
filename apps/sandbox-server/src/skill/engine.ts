/**
 * skill/engine.ts — Skill 执行引擎（沙箱内置）
 *
 * 在沙箱容器内运行，负责：
 * 1. 扫描 /skills 目录，提取 SKILL.md 的 name + description（轻量路由）
 * 2. 按需返回完整 SKILL.md 内容供 LLM 阅读（LLM 自行决定依赖安装和使用方式）
 * 3. 执行 Skill 附带的脚本文件
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { executeCode } from "../executor/runner.js";

/** Skills 挂载目录（容器内只读挂载） */
const SKILLS_DIR = "/skills";

/** Skill 运行时副本目录（容器内可写） */
const SKILL_RUNTIME_ROOT = "/home/sandbox/.skills";

// ── Skill 类型 ──────────────────────────────────────────────

/** SKILL.md 解析后的元数据 */
interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  /** SKILL.md 完整内容（供 LLM 阅读） */
  body: string;
  dirPath: string;
  files: string[];
}

/** Skill 摘要（仅 name + description，供 LLM 路由选择） */
interface SkillSummary {
  name: string;
  description: string;
}

/** Skill 详情（LLM 选中后按需读取） */
interface SkillDetail {
  name: string;
  description: string;
  version?: string;
  /** SKILL.md 完整 Markdown 内容 */
  body: string;
  /** 附带的脚本文件列表 */
  files: string[];
}

/** 已加载的 Skill 缓存 */
const skillCache = new Map<string, SkillMeta>();

// ── SKILL.md 解析 ───────────────────────────────────────────

/**
 * 解析 SKILL.md 的 YAML frontmatter，仅提取 name、description、version。
 * body 部分保留完整 Markdown，供 LLM 按需阅读。
 */
function parseSkillMd(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const rawYaml = match[1];
  const body = match[2].trim();
  const frontmatter: Record<string, string> = {};

  // 提取 name
  const nameMatch = rawYaml.match(/^name:\s*(.+)/m);
  if (nameMatch) frontmatter.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");

  // 提取 description
  const descMatch = rawYaml.match(/^description:\s*(.+)/m);
  if (descMatch) frontmatter.description = descMatch[1].trim().replace(/^["']|["']$/g, "");

  // 提取 version
  const verMatch = rawYaml.match(/^version:\s*(.+)/m);
  if (verMatch) frontmatter.version = verMatch[1].trim().replace(/^["']|["']$/g, "");

  return { frontmatter, body };
}

/**
 * 递归扫描目录下的文件（排除 SKILL.md）。
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

/**
 * 将只读挂载的 Skill 同步到 sandbox 可写目录。
 * 保留已安装的 node_modules，避免每次重复安装。
 */
function prepareSkillRuntimeDir(skill: SkillMeta): string {
  if (!existsSync(SKILL_RUNTIME_ROOT)) {
    mkdirSync(SKILL_RUNTIME_ROOT, { recursive: true });
  }

  const runtimeDir = resolve(SKILL_RUNTIME_ROOT, skill.name);

  if (existsSync(runtimeDir)) {
    // 清理旧文件，但保留 node_modules（npm 依赖缓存）
    const entries = readdirSync(runtimeDir);
    for (const name of entries) {
      if (name === "node_modules") continue;
      rmSync(resolve(runtimeDir, name), { recursive: true, force: true });
    }
    // 逐项拷贝源文件（跳过 node_modules）
    const srcEntries = readdirSync(skill.dirPath);
    for (const name of srcEntries) {
      if (name === "node_modules") continue;
      const src = resolve(skill.dirPath, name);
      const dest = resolve(runtimeDir, name);
      cpSync(src, dest, { recursive: true });
    }
  } else {
    cpSync(skill.dirPath, runtimeDir, { recursive: true });
  }

  return runtimeDir;
}

/**
 * 自动安装标准依赖文件声明的包。
 * 不解析自定义元数据，只处理语言标准约定：
 * - package.json → npm install
 * - requirements.txt → pip install
 */
async function autoInstallDeps(runtimeDir: string): Promise<{ success: boolean; error?: string }> {
  // Node.js: package.json + 无 node_modules → npm install
  const pkgJsonPath = resolve(runtimeDir, "package.json");
  const nodeModulesDir = resolve(runtimeDir, "node_modules");
  if (existsSync(pkgJsonPath) && !existsSync(nodeModulesDir)) {
    console.log(`[SkillEngine] 检测到 package.json，执行 npm install...`);
    const result = await executeCode({
      language: "bash",
      code: `cd "${runtimeDir}" && npm install --prefer-offline 2>&1`,
      timeout: 120_000,
    });
    if (!result.success) {
      return { success: false, error: `npm install 失败: ${result.stderr}` };
    }
  }

  // Python: requirements.txt → pip install
  const reqTxtPath = resolve(runtimeDir, "requirements.txt");
  if (existsSync(reqTxtPath)) {
    console.log(`[SkillEngine] 检测到 requirements.txt，执行 pip install...`);
    const result = await executeCode({
      language: "bash",
      code: `pip3 install --break-system-packages --no-cache-dir --user -r "${reqTxtPath}" 2>&1`,
      timeout: 120_000,
    });
    if (!result.success) {
      return { success: false, error: `pip install 失败: ${result.stderr}` };
    }
  }

  return { success: true };
}

// ── 公开 API ────────────────────────────────────────────────

/**
 * 扫描并加载所有 Skill 定义。
 * 只提取 name + description 用于路由，body 按需读取。
 */
export function loadSkills(): void {
  skillCache.clear();

  if (!existsSync(SKILLS_DIR)) {
    console.log(`[SkillEngine] skills 目录不存在: ${SKILLS_DIR}，跳过加载`);
    return;
  }

  try {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = resolve(SKILLS_DIR, entry.name);
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
        const files = scanFiles(skillDir, skillDir);

        const meta: SkillMeta = {
          name,
          description: (frontmatter.description as string) || "",
          version: frontmatter.version as string | undefined,
          body,
          dirPath: skillDir,
          files,
        };

        skillCache.set(name, meta);
        console.log(`[SkillEngine] 已加载: ${name} | ${files.length} 个文件`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SkillEngine] 加载失败: ${mdPath} | ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SkillEngine] 扫描 skills 目录失败: ${msg}`);
  }

  console.log(`[SkillEngine] 共加载 ${skillCache.size} 个 Skill`);
}

/**
 * 获取所有可用 Skill 的摘要列表（仅 name + description，轻量路由）。
 */
export function getSkillList(): SkillSummary[] {
  const result: SkillSummary[] = [];
  for (const skill of skillCache.values()) {
    result.push({ name: skill.name, description: skill.description });
  }
  return result;
}

/**
 * 获取指定 Skill 的完整详情（SKILL.md 内容 + 文件列表），供 LLM 阅读后自行决策。
 */
export function getSkillDetail(skillName: string): SkillDetail | null {
  const skill = skillCache.get(skillName);
  if (!skill) return null;
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    body: skill.body,
    files: skill.files,
  };
}

/**
 * 执行 Skill 中的脚本文件。
 * 自动根据文件扩展名选择执行方式。
 * 依赖安装由 LLM 通过 execute_code 自行处理，此处只负责执行。
 */
export async function runSkillScript(req: {
  skillName: string;
  scriptFile: string;
  args?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}> {
  const { skillName, scriptFile, args = "", timeout = 60_000 } = req;
  const tag = `[SkillEngine]`;
  const totalStart = Date.now();

  // 查找 Skill
  const skill = skillCache.get(skillName);
  if (!skill) {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `Skill "${skillName}" 不存在。可用: ${[...skillCache.keys()].join(", ")}`,
      duration: 0,
    };
  }

  // 验证脚本文件存在
  if (!skill.files.includes(scriptFile)) {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `脚本 "${scriptFile}" 不在 Skill "${skillName}" 中。可用文件: ${skill.files.join(", ")}`,
      duration: 0,
    };
  }

  // 准备运行时目录并自动安装标准依赖
  const runtimeDir = prepareSkillRuntimeDir(skill);

  const depsResult = await autoInstallDeps(runtimeDir);
  if (!depsResult.success) {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: depsResult.error ?? "依赖安装失败",
      duration: Date.now() - totalStart,
    };
  }

  // 根据扩展名确定执行方式
  const scriptPath = resolve(runtimeDir, scriptFile);
  const ext = extname(scriptFile).toLowerCase();
  let language: "python" | "node" | "bash";
  let code: string;

  switch (ext) {
    case ".py":
      language = "bash";
      code = `cd "${runtimeDir}" && python3 "${scriptPath}" ${args}`;
      break;
    case ".js":
    case ".mjs":
      language = "bash";
      code = `cd "${runtimeDir}" && node "${scriptPath}" ${args}`;
      break;
    case ".sh":
      language = "bash";
      code = `cd "${runtimeDir}" && bash "${scriptPath}" ${args}`;
      break;
    default:
      language = "bash";
      code = `cd "${runtimeDir}" && "${scriptPath}" ${args}`;
      break;
  }

  console.log(`${tag} 执行 ${skillName}/${scriptFile} | ${code.slice(0, 120)}`);

  const execResult = await executeCode({ language, code, timeout });

  return {
    success: execResult.success,
    exitCode: execResult.exitCode,
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    duration: Date.now() - totalStart,
  };
}

// 启动时加载 Skills
loadSkills();
