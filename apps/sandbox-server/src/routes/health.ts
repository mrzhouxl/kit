/**
 * routes/health.ts — 健康检查路由
 *
 * GET /health — 返回容器状态，Agent API 用此判断容器是否就绪。
 */
import type { FastifyInstance } from "fastify";

export async function registerHealthRoute(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
      uptime: process.uptime(),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  });
}
