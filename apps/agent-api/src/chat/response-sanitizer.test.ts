import test from "node:test";
import assert from "node:assert/strict";
import {
  getInternalResponseFallback,
  isInternalPromptLeak,
  sanitizeAssistantOutput,
} from "./response-sanitizer.js";

test("detects supervisor prompt dumps", () => {
  const leaked = `你是 Kit 的 Supervisor（智能任务调度器）

<decision_flow>
Step 1. 先判断当前请求是否需要执行能力。
</decision_flow>`;

  assert.equal(isInternalPromptLeak(leaked), true);
  assert.equal(sanitizeAssistantOutput(leaked), getInternalResponseFallback());
});

test("detects default system prompt sections", () => {
  const leaked = `你是 Kit，一个由 AI Comics 平台驱动的多功能智能助手。
## 你的能力
### 代码能力
### 网络能力
## 工作原则
## 当前时间`;

  assert.equal(isInternalPromptLeak(leaked), true);
});

test("keeps normal user-facing answers untouched", () => {
  const safe = "我已经帮你生成好了图片，下载地址如下。";

  assert.equal(isInternalPromptLeak(safe), false);
  assert.equal(sanitizeAssistantOutput(safe), safe);
});