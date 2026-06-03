export interface SseStreamBufferState {
  supervisorBuffer: string;
  supervisorEmittedLength: number;
  hasPendingSupervisorText: boolean;
  discardSupervisorBuffer: boolean;
  workerModelBuffer: string;
  workerEmittedLength: number;
  lastWorkerModelText: string;
  activeWorkerAgent: string;
  hasWorkerOutput: boolean;
}

export interface WorkerTurnResult {
  finalText: string;
  pendingText: string;
}

export interface SupervisorTurnResult {
  finalText: string;
  pendingText: string;
}

export function createSseStreamBufferState(): SseStreamBufferState {
  return {
    supervisorBuffer: "",
    supervisorEmittedLength: 0,
    hasPendingSupervisorText: false,
    discardSupervisorBuffer: false,
    workerModelBuffer: "",
    workerEmittedLength: 0,
    lastWorkerModelText: "",
    activeWorkerAgent: "",
    hasWorkerOutput: false,
  };
}

export function startWorkerTurn(state: SseStreamBufferState, agentName: string) {
  state.activeWorkerAgent = agentName;
  state.workerModelBuffer = "";
  state.workerEmittedLength = 0;
  state.lastWorkerModelText = "";
}

export function consumeWorkerStreamDelta(state: SseStreamBufferState): string {
  if (!state.activeWorkerAgent) {
    return "";
  }

  if (state.workerModelBuffer.length <= state.workerEmittedLength) {
    return "";
  }

  const delta = state.workerModelBuffer.slice(state.workerEmittedLength);
  state.workerEmittedLength = state.workerModelBuffer.length;
  return delta;
}

export function endWorkerTurn(state: SseStreamBufferState, agentName: string): WorkerTurnResult {
  if (agentName !== state.activeWorkerAgent) {
    return {
      finalText: "",
      pendingText: "",
    };
  }

  const finalText = state.lastWorkerModelText.trim() ? state.lastWorkerModelText : "";
  const pendingText = state.lastWorkerModelText.length > state.workerEmittedLength
    ? state.lastWorkerModelText.slice(state.workerEmittedLength)
    : "";
  if (finalText) {
    state.hasWorkerOutput = true;
  }

  state.workerModelBuffer = "";
  state.workerEmittedLength = 0;
  state.lastWorkerModelText = "";
  state.activeWorkerAgent = "";
  return {
    finalText,
    pendingText,
  };
}

export function startModelTurn(state: SseStreamBufferState, isSupervisor: boolean) {
  if (isSupervisor) {
    state.supervisorBuffer = "";
    state.supervisorEmittedLength = 0;
    state.hasPendingSupervisorText = false;
    state.discardSupervisorBuffer = false;
    return;
  }

  if (state.activeWorkerAgent) {
    state.workerModelBuffer = "";
    state.workerEmittedLength = 0;
  }
}

export function appendModelChunk(
  state: SseStreamBufferState,
  isSupervisor: boolean,
  content: string,
) {
  if (!content) {
    return;
  }

  if (isSupervisor) {
    if (!state.hasWorkerOutput) {
      state.supervisorBuffer += content;
      state.hasPendingSupervisorText = true;
    }
    return;
  }

  if (state.activeWorkerAgent) {
    state.workerModelBuffer += content;
  }
}

export function consumeSupervisorStreamDelta(state: SseStreamBufferState): string {
  if (state.discardSupervisorBuffer || !state.hasPendingSupervisorText) {
    return "";
  }

  if (state.supervisorBuffer.length <= state.supervisorEmittedLength) {
    return "";
  }

  const delta = state.supervisorBuffer.slice(state.supervisorEmittedLength);
  state.supervisorEmittedLength = state.supervisorBuffer.length;
  return delta;
}

export function endModelTurn(
  state: SseStreamBufferState,
  isSupervisor: true,
): SupervisorTurnResult;
export function endModelTurn(
  state: SseStreamBufferState,
  isSupervisor: false,
): string;
export function endModelTurn(
  state: SseStreamBufferState,
  isSupervisor: boolean,
): SupervisorTurnResult | string {
  if (isSupervisor) {
    const finalText = state.hasPendingSupervisorText
      && state.supervisorBuffer.length > 0
      && !state.discardSupervisorBuffer
      ? state.supervisorBuffer
      : "";
    const pendingText = finalText.length > state.supervisorEmittedLength
      ? finalText.slice(state.supervisorEmittedLength)
      : "";

    state.supervisorBuffer = "";
    state.supervisorEmittedLength = 0;
    state.hasPendingSupervisorText = false;
    state.discardSupervisorBuffer = false;
    return {
      finalText,
      pendingText,
    };
  }

  if (state.activeWorkerAgent) {
    state.lastWorkerModelText = state.workerModelBuffer;
    state.workerModelBuffer = "";
  }

  return "";
}

export function discardSupervisorText(state: SseStreamBufferState) {
  state.discardSupervisorBuffer = true;
  state.supervisorBuffer = "";
  state.supervisorEmittedLength = 0;
  state.hasPendingSupervisorText = false;
}