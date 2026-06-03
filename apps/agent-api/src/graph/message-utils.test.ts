import test from "node:test";
import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { trimMessagesForContext, trimMessagesForContextWithModel } from "./message-utils.js";

test("trimMessagesForContext isolates the latest turn when the user switches from video generation to news lookup", () => {
  const messages = [
    new HumanMessage("帮我生成一个新闻播报风格的视频"),
    new HumanMessage({
      content: "我已经生成好了一个新闻播报风格的视频链接。",
      name: "image_agent",
    }),
    new HumanMessage("看看新闻"),
  ];

  const trimmed = trimMessagesForContext(messages);

  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0] instanceof HumanMessage, true);
  assert.equal(trimmed[0]?.content, "看看新闻");
});

test("trimMessagesForContext keeps history for explicit follow-up requests", () => {
  const messages = [
    new HumanMessage("帮我生成一个新闻播报风格的视频"),
    new HumanMessage({
      content: "我已经生成好了一个新闻播报风格的视频链接。",
      name: "image_agent",
    }),
    new HumanMessage("基于上一个视频，再生成一个更正式的版本"),
  ];

  const trimmed = trimMessagesForContext(messages);

  assert.equal(trimmed.length, messages.length);
});

test("trimMessagesForContextWithModel isolates the latest turn when classifier marks a new task", async () => {
  const messages = [
    new HumanMessage("帮我生成一个新闻播报风格的视频"),
    new HumanMessage({
      content: "我已经生成好了一个新闻播报风格的视频链接。",
      name: "image_agent",
    }),
    new HumanMessage("看看新闻"),
  ];

  const trimmed = await trimMessagesForContextWithModel(messages, 3, 4, {
    classifyTaskContinuity: async () => false,
  });

  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0]?.content, "看看新闻");
});

test("trimMessagesForContextWithModel keeps history when classifier marks the previous task as relevant", async () => {
  const messages = [
    new HumanMessage("帮我生成一个新闻播报风格的视频"),
    new HumanMessage({
      content: "我已经生成好了一个新闻播报风格的视频链接。",
      name: "image_agent",
    }),
    new HumanMessage("把上一个视频变得更正式一点"),
  ];

  const trimmed = await trimMessagesForContextWithModel(messages, 3, 4, {
    classifyTaskContinuity: async () => true,
  });

  assert.equal(trimmed.length, messages.length);
});