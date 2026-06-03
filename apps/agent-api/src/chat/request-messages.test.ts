import test from "node:test";
import assert from "node:assert/strict";
import { selectGraphInputMessages, type VercelMessage } from "./request-messages.js";

test("selectGraphInputMessages should keep full history for new threads", () => {
  const messages: VercelMessage[] = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ];

  assert.deepEqual(selectGraphInputMessages(messages, false), messages);
});

test("selectGraphInputMessages should only append latest user message for persisted threads", () => {
  const messages: VercelMessage[] = [
    { role: "user", content: "现在总共生成了多少张图片了" },
    { role: "assistant", content: "我来统计一下" },
    { role: "user", content: "测试风格的内容" },
  ];

  assert.deepEqual(selectGraphInputMessages(messages, true), [messages[2]]);
});

test("selectGraphInputMessages should fall back to the last message when no user message exists", () => {
  const messages: VercelMessage[] = [
    { role: "assistant", content: "系统欢迎语" },
  ];

  assert.deepEqual(selectGraphInputMessages(messages, true), [messages[0]]);
});

test("selectGraphInputMessages should keep only the latest question in the image-summary regression scenario", () => {
  const messages: VercelMessage[] = [
    { role: "user", content: "帮我查看测试风格项目的内容" },
    { role: "assistant", content: "好的，我来查看测试风格项目的详细信息。" },
    { role: "assistant", content: "以下是测试风格项目的完整内容概览。" },
    { role: "user", content: "现在总共生成了多少张图片了" },
  ];

  assert.deepEqual(selectGraphInputMessages(messages, true), [
    { role: "user", content: "现在总共生成了多少张图片了" },
  ]);
});

test("selectGraphInputMessages should ignore long assistant payloads from the previous task", () => {
  const messages: VercelMessage[] = [
    { role: "user", content: "帮我查看测试风格项目的内容" },
    {
      role: "assistant",
      content: "好的，以下是测试风格项目的完整内容概览：分镜片段共 8 个，全部待生成。",
    },
    {
      role: "assistant",
      content: "片段 1：废墟寻音；片段 2：遗言惊现；片段 3：档案馆遇袭。",
    },
    { role: "user", content: "现在总共生成了多少张图片了" },
  ];

  const selected = selectGraphInputMessages(messages, true);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.role, "user");
  assert.equal(selected[0]?.content, "现在总共生成了多少张图片了");
});