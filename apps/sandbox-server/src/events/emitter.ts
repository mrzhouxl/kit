/**
 * events/emitter.ts — 全局事件发射器
 *
 * 沙箱内各模块（浏览器、代码执行、终端）通过此发射器推送事件，
 * WebSocket 服务监听并转发给 Agent API。
 */
import { EventEmitter } from "node:events";
import type { SandboxEvent } from "../types.js";

/** 沙箱全局事件总线，所有模块共用 */
class SandboxEventBus extends EventEmitter {
  /** 发送一个沙箱事件，WebSocket 服务会自动转发 */
  emitSandboxEvent(data: SandboxEvent): boolean {
    return super.emit("sandbox-event", data);
  }

  onSandboxEvent(listener: (data: SandboxEvent) => void): this {
    return super.on("sandbox-event", listener);
  }
}

export const eventBus = new SandboxEventBus();
