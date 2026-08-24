const counters = {
  httpRequests: 0,
  httpErrors: 0,
  httpLatencyMsTotal: 0,
  transactionRetries: 0,
  idempotencyConflicts: 0,
  loginLockouts: 0,
  outboxFailures: 0,
  readinessFailures: 0,
};

const increment = (key, amount = 1) => {
  counters[key] = (counters[key] || 0) + amount;
};

const observeLatency = (durationMs) => {
  counters.httpLatencyMsTotal += durationMs;
};

const snapshot = () => ({
  ...counters,
  httpAverageLatencyMs:
    counters.httpRequests > 0
      ? Number((counters.httpLatencyMsTotal / counters.httpRequests).toFixed(2))
      : 0,
  collectedAt: new Date().toISOString(),
});

module.exports = {
  increment,
  observeLatency,
  snapshot,
};
