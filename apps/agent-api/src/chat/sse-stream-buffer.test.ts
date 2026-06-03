import test from "node:test";
import assert from "node:assert/strict";
import {
  appendModelChunk,
  createSseStreamBufferState,
  discardSupervisorText,
  endModelTurn,
  endWorkerTurn,
  startModelTurn,
  startWorkerTurn,
} from "./sse-stream-buffer.js";

test("worker stream only emits final text once at worker end", () => {
  const state = createSseStreamBufferState();

  startWorkerTurn(state, "comics_agent");
  startModelTurn(state, false);
  appendModelChunk(state, false, "好的，我来查一下");
  appendModelChunk(state, false, "当前创作空间中所有项目的图片生成情况。");

  assert.equal(endModelTurn(state, false), "");
  assert.equal(endWorkerTurn(state, "comics_agent"), "好的，我来查一下当前创作空间中所有项目的图片生成情况。");
  assert.equal(endWorkerTurn(state, "comics_agent"), "");
});

test("supervisor text is discarded once routing begins", () => {
  const state = createSseStreamBufferState();

  startModelTurn(state, true);
  appendModelChunk(state, true, "我先帮你分析一下任务。\n");
  discardSupervisorText(state);

  assert.equal(endModelTurn(state, true), "");
});

test("supervisor text is suppressed after worker has produced output", () => {
  const state = createSseStreamBufferState();

  startWorkerTurn(state, "comics_agent");
  startModelTurn(state, false);
  appendModelChunk(state, false, "最终统计结果如下");
  endModelTurn(state, false);
  assert.equal(endWorkerTurn(state, "comics_agent"), "最终统计结果如下");

  startModelTurn(state, true);
  appendModelChunk(state, true, "我再补充说明一下");

  assert.equal(endModelTurn(state, true), "");
});