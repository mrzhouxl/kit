/**
 * events/ws-server.ts — WebSocket 事件推送服务
 *
 * 在 Fastify 上挂载 /events WebSocket 端点，
 * 将沙箱内部事件实时转发给 Agent API。
 */
import type { FastifyInstance } from "fastify";
import { eventBus } from "./emitter.js";
import type { SandboxEvent } from "../types.js";

/** 当前所有连接的 WebSocket 客户端 */
const clients = new Set<import("ws").WebSocket>();

/**
 * 注册 WebSocket 路由 /events
 * Agent API 连接后即可持续接收沙箱内部事件。
 */
export async function registerWsRoute(app: FastifyInstance) {
  app.get("/events", { websocket: true }, (socket) => {
    console.log("[WS] Agent API 已连接");
    clients.add(socket);

    socket.on("close", () => {
      console.log("[WS] Agent API 断开连接");
      clients.delete(socket);
    });

    socket.on("error", (err) => {
      console.error("[WS] 连接错误:", err.message);
      clients.delete(socket);
    });
  });

  // 监听内部事件总线，广播给所有 WS 客户端
  eventBus.onSandboxEvent((event: SandboxEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  });
}

/**
 * 向所有连接的客户端发送事件（供路由直接调用）
 */
export function broadcastEvent(event: SandboxEvent) {
  eventBus.emitSandboxEvent(event);
}
