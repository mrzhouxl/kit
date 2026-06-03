import test from "node:test";
import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import {
  buildTaskStateSummary,
  deriveTaskStateFromMessages,
  getDirectResponsePolicy,
  shouldFinishCurrentTurn,
} from "./supervisor-policy.js";

test("deriveTaskStateFromMessages tracks completed agents and next waiting status", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("帮我先搜一下最近的 AI 漫画平台，再帮我总结一下它们的差异"),
    new HumanMessage({
      content: "我已经找到 3 个平台并整理了关键特性。",
      name: "web_agent",
    }),
  ]);

  assert.equal(taskState.intent, "web_task");
  assert.deepEqual(taskState.completedAgents, ["web_agent"]);
  assert.equal(taskState.currentAgent, "web_agent");
  assert.equal(taskState.status, "worker_completed");
  assert.equal(taskState.nextAgent, "FINISH");
});

test("getDirectResponsePolicy only allows direct reply for non-execution intents", () => {
  assert.equal(getDirectResponsePolicy("knowledge_question"), true);
  assert.equal(getDirectResponsePolicy("coding_task"), false);
  assert.equal(getDirectResponsePolicy("image_task"), false);
});

test("buildTaskStateSummary renders structured supervisor state", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("帮我把这张图片裁成 1:1 并导出 png"),
  ]);

  const summary = buildTaskStateSummary(taskState);

  assert.match(summary, /intent: coding_task/);
  assert.match(summary, /status: awaiting_routing/);
  assert.match(summary, /direct_response_allowed: false/);
});

test("deriveTaskStateFromMessages routes video generation requests to image agent flow", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("请根据这张参考图生成一个 8 秒的短视频，让人物缓慢转头并微笑"),
  ]);

  assert.equal(taskState.intent, "image_task");
  assert.equal(taskState.status, "awaiting_routing");
  assert.equal(taskState.nextAgent, "image_agent");
  assert.equal(taskState.directResponseAllowed, false);
});

test("deriveTaskStateFromMessages treats generic video creation as image agent work", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("制作一个视频"),
  ]);

  assert.equal(taskState.intent, "image_task");
  assert.equal(taskState.status, "awaiting_routing");
  assert.equal(taskState.nextAgent, "image_agent");
  assert.equal(taskState.directResponseAllowed, false);
});

test("deriveTaskStateFromMessages prioritizes video generation over news keyword collisions", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("帮我生成一个新闻播报风格的视频"),
  ]);

  assert.equal(taskState.intent, "image_task");
  assert.equal(taskState.status, "awaiting_routing");
  assert.equal(taskState.nextAgent, "image_agent");
});

test("deriveTaskStateFromMessages resets task state after a new user turn", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("先帮我搜一下近期的 AI 绘图工具"),
    new HumanMessage({
      content: "我已经整理好了 4 个工具。",
      name: "web_agent",
    }),
    new HumanMessage("再帮我解释一下什么是 LangGraph Supervisor"),
  ]);

  assert.equal(taskState.intent, "knowledge_question");
  assert.deepEqual(taskState.completedAgents, []);
  assert.equal(taskState.currentAgent, null);
  assert.equal(taskState.status, "direct_response");
  assert.equal(taskState.nextAgent, null);
});

test("shouldFinishCurrentTurn forces finish after successful worker output", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("帮我搜一下今天的 AI 新闻"),
    new HumanMessage({
      content: "我已经整理好了今天最重要的 3 条 AI 新闻。",
      name: "web_agent",
    }),
  ]);

  assert.equal(shouldFinishCurrentTurn(taskState), true);
});

test("shouldFinishCurrentTurn keeps route open after worker failure", () => {
  const taskState = deriveTaskStateFromMessages([
    new HumanMessage("帮我搜一下今天的 AI 新闻"),
    new HumanMessage({
      content: "[web_agent 执行失败] timeout",
      name: "web_agent",
    }),
  ]);

  assert.equal(shouldFinishCurrentTurn(taskState), false);
});