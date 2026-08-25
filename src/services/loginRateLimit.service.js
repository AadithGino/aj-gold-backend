const LoginAttempt = require("../models/loginAttempt.model");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const {
  LOGIN_RATE_LIMIT_WINDOW_MS,
  LOGIN_RATE_LIMIT_MAX,
  LOGIN_LOCKOUT_MS,
} = require("../config/env");

const buildKey = (dimension, value) => `${dimension}:${String(value || "unknown").trim()}`;

const getExpiresAt = (now) => new Date(now.getTime() + LOGIN_RATE_LIMIT_WINDOW_MS * 2);

const isLocked = (entry, now) => entry?.lockedUntil && entry.lockedUntil > now;

const assertNotLocked = async ({ ip, phone }) => {
  const now = new Date();
  const keys = [buildKey("ip", ip), buildKey("account", phone)].filter(
    (key) => !key.endsWith("unknown")
  );

  const entries = await LoginAttempt.find({ key: { $in: keys } });
  for (const entry of entries) {
    if (isLocked(entry, now)) {
      throw new ApiError(429, "Too many login attempts. Please try again later.", [], {
        code: ERROR_CODES.RATE_LIMITED,
        retryable: false,
      });
    }
  }
};

const upsertFailedAttempt = async (key, now) => {
  const existing = await LoginAttempt.findOne({ key });
  const windowExpired =
    !existing ||
    existing.windowStart < new Date(now.getTime() - LOGIN_RATE_LIMIT_WINDOW_MS);

  if (windowExpired) {
    return LoginAttempt.findOneAndUpdate(
      { key },
      {
        $set: {
          key,
          count: 1,
          windowStart: now,
          lockedUntil: null,
          expiresAt: getExpiresAt(now),
        },
      },
      { upsert: true, returnDocument: "after" }
    );
  }

  const updated = await LoginAttempt.findOneAndUpdate(
    { key },
    {
      $inc: { count: 1 },
      $set: { expiresAt: getExpiresAt(now) },
    },
    { returnDocument: "after" }
  );

  if (updated.count > LOGIN_RATE_LIMIT_MAX) {
    return LoginAttempt.findOneAndUpdate(
      { key },
      { $set: { lockedUntil: new Date(now.getTime() + LOGIN_LOCKOUT_MS) } },
      { returnDocument: "after" }
    );
  }

  return updated;
};

const recordFailedAttempt = async ({ ip, phone }) => {
  const now = new Date();
  const dimensions = [
    { dimension: "ip", value: ip },
    { dimension: "account", value: phone },
  ].filter((item) => item.value);

  for (const { dimension, value } of dimensions) {
    const entry = await upsertFailedAttempt(buildKey(dimension, value), now);
    if (isLocked(entry, now)) {
      throw new ApiError(429, "Too many login attempts. Please try again later.", [], {
        code: ERROR_CODES.RATE_LIMITED,
        retryable: false,
      });
    }
  }
};

const resetAttempts = async ({ ip, phone }) => {
  const keys = [buildKey("ip", ip), buildKey("account", phone)].filter(
    (key) => !key.endsWith("unknown")
  );
  if (!keys.length) return;
  await LoginAttempt.deleteMany({ key: { $in: keys } });
};

module.exports = {
  buildKey,
  assertNotLocked,
  recordFailedAttempt,
  resetAttempts,
};
