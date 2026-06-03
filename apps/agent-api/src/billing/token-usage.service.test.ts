import test from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_TOKEN_LIMIT,
  DAILY_VIDEO_GENERATION_LIMIT,
  buildChinaDayRange,
  buildDailyVideoGenerationLimitMessage,
  buildDailyTokenLimitMessage,
  isDailyVideoGenerationAllowed,
  isDailyTokenUsageAllowed,
} from "./token-usage.service.js";

test("buildChinaDayRange should align to China natural day window", () => {
  const { start, end, day } = buildChinaDayRange(new Date("2026-05-22T17:30:00.000Z"));

  assert.equal(day, "2026-05-23");
  assert.equal(start.toISOString(), "2026-05-22T16:00:00.000Z");
  assert.equal(end.toISOString(), "2026-05-23T16:00:00.000Z");
});

test("isDailyTokenUsageAllowed should reject once limit is reached", () => {
  assert.equal(isDailyTokenUsageAllowed(DAILY_TOKEN_LIMIT - 1), true);
  assert.equal(isDailyTokenUsageAllowed(DAILY_TOKEN_LIMIT), false);
  assert.equal(isDailyTokenUsageAllowed(DAILY_TOKEN_LIMIT + 1), false);
});

test("buildDailyTokenLimitMessage should include usage and limit", () => {
  const message = buildDailyTokenLimitMessage(1_234_567);

  assert.match(message, /1,234,567/);
  assert.match(message, /1,000,000/);
  assert.match(message, /明天再试/);
});

test("isDailyVideoGenerationAllowed should reject once limit is reached", () => {
  assert.equal(isDailyVideoGenerationAllowed(DAILY_VIDEO_GENERATION_LIMIT - 1), true);
  assert.equal(isDailyVideoGenerationAllowed(DAILY_VIDEO_GENERATION_LIMIT), false);
  assert.equal(isDailyVideoGenerationAllowed(DAILY_VIDEO_GENERATION_LIMIT + 1), false);
});

test("buildDailyVideoGenerationLimitMessage should include count and limit", () => {
  const message = buildDailyVideoGenerationLimitMessage(3);

  assert.match(message, /3/);
  assert.match(message, /明天再试/);
});