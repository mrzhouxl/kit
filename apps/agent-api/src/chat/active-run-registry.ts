import { randomUUID } from "node:crypto";

interface ActiveRunEntry {
  runId: string;
  abortController: AbortController;
}

const activeRuns = new Map<string, ActiveRunEntry>();

export function normalizeRunId(runId?: string): string {
  return runId?.trim() || randomUUID();
}

export function beginActiveRun(threadId: string, runId: string): AbortController {
  const previous = activeRuns.get(threadId);
  if (previous && previous.runId !== runId) {
    previous.abortController.abort();
  }

  const abortController = new AbortController();
  activeRuns.set(threadId, { runId, abortController });
  return abortController;
}

export function isActiveRun(threadId: string, runId: string): boolean {
  return activeRuns.get(threadId)?.runId === runId;
}

export function endActiveRun(threadId: string, runId: string): void {
  if (isActiveRun(threadId, runId)) {
    activeRuns.delete(threadId);
  }
}