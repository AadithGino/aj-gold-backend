const express = require("express");
const mongoose = require("mongoose");
const { getRuntimeState } = require("../ops/runtimeState");
const { snapshot } = require("../ops/metrics");
const { withTimeout } = require("../ops/preflight");
const { runStartupPreflight } = require("../ops/preflight");
const { getOutboxHealthMetrics } = require("../services/outbox.service");
const authMiddleware = require("../middleware/auth.middleware");
const { adminOnlyMiddleware } = require("../middleware/staffPermission.middleware");

const router = express.Router();

router.get("/live", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    success: true,
    alive: true,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

router.get("/ready", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const runtime = getRuntimeState();
  if (runtime.shuttingDown) {
    return res.status(503).json({
      success: false,
      ready: false,
      reason: "shutting_down",
    });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      ready: false,
      reason: "database_disconnected",
    });
  }

  try {
    await withTimeout(runStartupPreflight({ requireMigrations: true }), "Readiness preflight");
    return res.status(200).json({
      success: true,
      ready: true,
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      ready: false,
      reason: error.message,
    });
  }
});

router.get("/metrics", authMiddleware, adminOnlyMiddleware, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: snapshot() });
});

router.get("/diagnostics", authMiddleware, adminOnlyMiddleware, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const runtime = getRuntimeState();
  let preflight = runtime.preflight;
  if (!runtime.ready) {
    preflight = await withTimeout(runStartupPreflight({ requireMigrations: true }), "Diagnostics preflight");
  }
  const outbox = await getOutboxHealthMetrics();

  return res.status(200).json({
    success: true,
    data: {
      preflight,
      outbox: {
        running: runtime.outboxWorkerRunning,
        lastSuccessAt: runtime.outboxLastSuccessAt,
        lastErrorAt: runtime.outboxLastErrorAt,
        ...outbox,
      },
    },
  });
});

router.get("/", (req, res) => {
  res.redirect(307, "/api/health/live");
});

module.exports = router;
