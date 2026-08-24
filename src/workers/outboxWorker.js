const { processOutboxBatch } = require("../services/outbox.service");
const { markOutboxSuccess, markOutboxFailure } = require("../ops/runtimeState");
const { increment } = require("../ops/metrics");

const WORKER_INTERVAL_MS = 5000;

let timer = null;
let running = false;

const tick = async () => {
  if (running) return;
  running = true;
  try {
    await processOutboxBatch({ limit: 25 });
    markOutboxSuccess();
  } catch (error) {
    increment("outboxFailures");
    markOutboxFailure(error);
  } finally {
    running = false;
  }
};

const startOutboxWorker = () => {
  if (timer) return;
  timer = setInterval(tick, WORKER_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
};

const stopOutboxWorker = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

module.exports = {
  startOutboxWorker,
  stopOutboxWorker,
  tick,
};
