/**
 * tools/notify.ts — 用户通知工具
 *
 * message_notify_user : Agent 主动向用户发送状态通知
 *
 * 通过 sandboxEvents 发射 notify 事件，SSE 控制器监听后
 * 将消息推送到前端，渲染为步骤胶囊。
 *
 * 这使得步骤描述由 LLM 动态生成，而非固定模板。
 */
import { tool } from "ai";
import { z } from "zod";
import { sandboxEvents } from "../sandbox/index.js";
import {
  getRequestSessionKey,
  getRequestThreadId,
} from "../context/request-context.js";

export const messageNotifyUser = tool({
  description:
    "向用户发送一句话状态通知，告知当前正在做什么或已经完成了什么。" +
    "在调用其他工具之前必须先调用此工具，说明你接下来要做什么。" +
    "工具执行完成后也应调用此工具，说明执行结果。",
  inputSchema: z.object({
    message: z.string().describe("一句话通知内容，使用用户的语言"),
  }),
  execute: async ({ message }) => {
    const sessionKey = getRequestSessionKey();
    const threadId = getRequestThreadId();

    // 通过事件总线发射通知，SSE 控制器会监听并转发
    sandboxEvents.emit("event", {
      sessionKey: sessionKey ?? "",
      userId: "",
      threadId: threadId ?? "",
      event: {
        type: "notify",
        message,
      },
    });

    return { success: true, message };
  },
});
