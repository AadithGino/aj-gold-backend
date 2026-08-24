const { PORT, SHUTDOWN_TIMEOUT_MS, NODE_ENV } = require("./src/config/env");
const connectDB = require("./src/config/db");
const app = require("./src/app");
const mongoose = require("mongoose");
const { startOutboxWorker, stopOutboxWorker } = require("./src/workers/outboxWorker");
const { runStartupPreflight } = require("./src/ops/preflight");
const { markReady, markNotReady, markShuttingDown } = require("./src/ops/runtimeState");
const { log } = require("./src/utils/logger");

let server;
let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  markShuttingDown();

  log("info", "shutdown_started", { signal });

  const forceTimer = setTimeout(() => {
    log("error", "shutdown_timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (typeof forceTimer.unref === "function") {
    forceTimer.unref();
  }

  stopOutboxWorker();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await mongoose.connection.close(false);
  clearTimeout(forceTimer);
  log("info", "shutdown_complete", { signal });
  process.exit(0);
};

const start = async () => {
  await connectDB();

  if (NODE_ENV === "production") {
    const preflight = await runStartupPreflight({ requireMigrations: true });
    markReady(preflight);
    log("info", "startup_preflight_passed", preflight);
  } else {
    try {
      const preflight = await runStartupPreflight({ requireMigrations: false });
      markReady(preflight);
    } catch (error) {
      markNotReady(error);
      log("warn", "startup_preflight_degraded", { error: error.message });
    }
  }

  server = app.listen(PORT, () => {
    log("info", "server_started", { port: PORT, nodeEnv: NODE_ENV });
  });
  startOutboxWorker();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  markNotReady(error);
  log("error", "startup_failed", { error: error.message });
  process.exit(1);
});
