/**
 * index.ts — 沙箱控制服务启动入口
 *
 * 使用 Fastify 提供 HTTP + WebSocket 服务：
 *   GET  /health   → 健康检查
 *   POST /browse   → Playwright 浏览器操作
 *   POST /exec     → 代码执行（Python / Node.js / Bash）
 *   WS   /events   → 实时事件推送（screencast 帧、stdout、状态等）
 */
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { registerHealthRoute } from "./routes/health.js";
import { registerExecRoute } from "./routes/exec.js";
import { registerBrowseRoute } from "./routes/browse.js";
import { registerFilesRoute } from "./routes/files.js";
import { registerSkillRoute } from "./routes/skill.js";
import { registerWsRoute } from "./events/ws-server.js";
import { closeBrowser } from "./browser/pool.js";

const PORT = parseInt(process.env.SANDBOX_PORT ?? "3100", 10);

async function main() {
  const app = Fastify({ logger: false });

  // 注册 WebSocket 插件
  await app.register(fastifyWebsocket);

  // 注册路由
  await registerHealthRoute(app);
  await registerExecRoute(app);
  await registerBrowseRoute(app);
  await registerFilesRoute(app);
  await registerSkillRoute(app);
  await registerWsRoute(app);

  // 优雅关闭：清理浏览器资源
  const shutdown = async () => {
    console.log("[Sandbox] 正在关闭...");
    await closeBrowser();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // 启动服务
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[Sandbox] 控制服务已启动 → http://0.0.0.0:${PORT}`);
  console.log(`[Sandbox] 健康检查: GET /health`);
  console.log(`[Sandbox] 浏览器操作: POST /browse`);
  console.log(`[Sandbox] 代码执行: POST /exec`);
  console.log(`[Sandbox] Skill 执行: POST /skill`);
  console.log(`[Sandbox] Skill 列表: GET /skill/list`);
  console.log(`[Sandbox] 事件推送: WS /events`);
}

main().catch((err) => {
  console.error("[Sandbox] 启动失败:", err);
  process.exit(1);
});
