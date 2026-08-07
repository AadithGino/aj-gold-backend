const { LOGIN_RATE_LIMIT_WINDOW_MS, LOGIN_RATE_LIMIT_MAX } = require("../config/env");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const attempts = new Map();

const pruneAttempts = (now) => {
  for (const [key, entry] of attempts.entries()) {
    if (entry.resetAt <= now) {
      attempts.delete(key);
    }
  }
};

const loginRateLimitMiddleware = (req, res, next) => {
  const now = Date.now();
  pruneAttempts(now);

  const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const entry = attempts.get(key) || { count: 0, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS };

  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + LOGIN_RATE_LIMIT_WINDOW_MS;
  }

  entry.count += 1;
  attempts.set(key, entry);

  if (entry.count > LOGIN_RATE_LIMIT_MAX) {
    return next(new ApiError(429, "Too many login attempts. Please try again later.", [], {
      code: ERROR_CODES.RATE_LIMITED,
      retryable: false,
    }));
  }

  return next();
};

module.exports = loginRateLimitMiddleware;
