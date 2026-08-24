const { increment, observeLatency } = require("../ops/metrics");
const { log } = require("../utils/logger");

const sanitizePath = (url = "") => {
  const [pathOnly, query = ""] = String(url).split("?");
  if (!query) return pathOnly;
  return `${pathOnly}?[REDACTED]`;
};

const requestLogMiddleware = (req, res, next) => {
  if (req.path.startsWith("/api/health/live")) {
    return next();
  }

  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    increment("httpRequests");
    observeLatency(durationMs);
    if (res.statusCode >= 500) {
      increment("httpErrors");
    }

    log("info", "http_request", {
      requestId: req.requestId,
      method: req.method,
      path: sanitizePath(req.originalUrl),
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      actorId: req.user?._id?.toString?.(),
      actorRole: req.user?.role,
    });
  });

  next();
};

module.exports = requestLogMiddleware;
