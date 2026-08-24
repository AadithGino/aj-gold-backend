const state = {
  ready: false,
  preflight: null,
  preflightError: null,
  outboxWorkerRunning: false,
  outboxLastSuccessAt: null,
  outboxLastErrorAt: null,
  outboxLastError: null,
  shuttingDown: false,
};

const markReady = (preflight) => {
  state.ready = true;
  state.preflight = preflight;
  state.preflightError = null;
};

const markNotReady = (error) => {
  state.ready = false;
  state.preflightError = error?.message || String(error);
};

const markOutboxSuccess = () => {
  state.outboxLastSuccessAt = new Date();
  state.outboxWorkerRunning = true;
};

const markOutboxFailure = (error) => {
  state.outboxLastErrorAt = new Date();
  state.outboxLastError = error?.message || String(error);
  state.outboxWorkerRunning = true;
};

const markShuttingDown = () => {
  state.shuttingDown = true;
  state.ready = false;
};

const getRuntimeState = () => ({ ...state });

module.exports = {
  markReady,
  markNotReady,
  markOutboxSuccess,
  markOutboxFailure,
  markShuttingDown,
  getRuntimeState,
};
