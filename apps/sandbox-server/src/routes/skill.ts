/**
 * routes/skill.ts — Skill 路由
 *
 * GET  /skill/list          — 获取可用 Skill 列表（仅 name + description）
 * GET  /skill/detail/:name  — 获取 Skill 完整详情（SKILL.md 内容 + 文件列表）
 * POST /skill/run           — 执行 Skill 脚本
 *
 * Skills 通过 bind mount 挂载到容器 /skills 目录（只读）。
 */
import type { FastifyInstance } from "fastify";
import { getSkillDetail, runSkillScript, getSkillList } from "../skill/engine.js";

/** POST /skill/run 请求体 */
interface SkillRunBody {
  skillName: string;
  scriptFile: string;
  args?: string;
  timeout?: number;
}

export async function registerSkillRoute(app: FastifyInstance) {
  /** GET /skill/list — 获取可用 Skill 列表（轻量，仅 name + description） */
  app.get("/skill/list", async () => {
    const skills = getSkillList();
    return { skills };
  });

  /** GET /skill/detail/:name — 获取 Skill 完整详情供 LLM 阅读 */
  app.get<{ Params: { name: string } }>("/skill/detail/:name", async (request) => {
    const { name } = request.params;
    const detail = getSkillDetail(name);
    if (!detail) {
      return { success: false, error: `Skill "${name}" 不存在` };
    }
    return { success: true, ...detail };
  });

  /** POST /skill/run — 执行 Skill 脚本 */
  app.post<{ Body: SkillRunBody }>("/skill/run", async (request) => {
    const { skillName, scriptFile, args, timeout } = request.body;
    const tag = `[Skill/run]`;

    if (!skillName || !scriptFile) {
      return {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: "缺少 skillName 或 scriptFile",
        duration: 0,
      };
    }

    console.log(`${tag} 执行请求 | skill=${skillName} | script=${scriptFile} | args=${(args ?? "").slice(0, 200)}`);
    const t0 = Date.now();

    try {
      const result = await runSkillScript({ skillName, scriptFile, args, timeout });
      console.log(`${tag} 完成 | ${Date.now() - t0}ms | exitCode=${result.exitCode}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} 异常 | skill=${skillName} | ${msg}`);
      return { success: false, exitCode: -1, stdout: "", stderr: msg, duration: Date.now() - t0 };
    }
  });
}
