import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REQUEST_MODEL_CALLS,
  MAX_REQUEST_RECURSION_LIMIT,
  MAX_REQUEST_TOTAL_TOKENS,
  buildRequestModelCallLimitMessage,
  buildRequestTokenLimitMessage,
  isRequestModelCallLimitExceeded,
  isRequestTokenBudgetExceeded,
  resolveRequestRecursionLimit,
} from "./request-guard.js";

test("resolveRequestRecursionLimit should use safe default and clamp oversized values", () => {
  assert.equal(resolveRequestRecursionLimit(), MAX_REQUEST_RECURSION_LIMIT);
  assert.equal(resolveRequestRecursionLimit(12), 12);
  assert.equal(resolveRequestRecursionLimit(999), MAX_REQUEST_RECURSION_LIMIT);
  assert.equal(resolveRequestRecursionLimit(-3), MAX_REQUEST_RECURSION_LIMIT);
});

test("isRequestTokenBudgetExceeded should cut off runaway requests at limit", () => {
  assert.equal(isRequestTokenBudgetExceeded(MAX_REQUEST_TOTAL_TOKENS - 1), false);
  assert.equal(isRequestTokenBudgetExceeded(MAX_REQUEST_TOTAL_TOKENS), true);
  assert.equal(isRequestTokenBudgetExceeded(MAX_REQUEST_TOTAL_TOKENS + 5000), true);
});

test("isRequestModelCallLimitExceeded should cut off repeated model calls at limit", () => {
  assert.equal(isRequestModelCallLimitExceeded(MAX_REQUEST_MODEL_CALLS - 1), false);
  assert.equal(isRequestModelCallLimitExceeded(MAX_REQUEST_MODEL_CALLS), true);
  assert.equal(isRequestModelCallLimitExceeded(MAX_REQUEST_MODEL_CALLS + 1), true);
});

test("buildRequestTokenLimitMessage should explain automatic stop", () => {
  const message = buildRequestTokenLimitMessage(100_321);

  assert.match(message, /100,321/);
  assert.match(message, /200,000/);
  assert.match(message, /自动停止/);
  assert.match(message, /重复执行持续消耗/);
});

test("buildRequestModelCallLimitMessage should explain repeated execution stop", () => {
  const message = buildRequestModelCallLimitMessage(25);

  assert.match(message, /25/);
  assert.match(message, /24/);
  assert.match(message, /重复执行/);
  assert.match(message, /自动停止/);
});