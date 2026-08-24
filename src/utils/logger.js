const { NODE_ENV } = require("../config/env");

const REDACT_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "authorization",
  "jwt",
  "secret",
  "recoverycode",
  "recoverycodes",
  "otp",
  "code",
  "newpassword",
  "currentpassword",
]);

const REDACT_PATTERN = /(password|token|secret|authorization|bearer\s+\S+|otp|recoverycode|reference)/gi;

const redactValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.replace(REDACT_PATTERN, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object") {
    return redactObject(value);
  }
  return value;
};

const redactObject = (input) => {
  if (!input || typeof input !== "object") return input;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (REDACT_KEYS.has(String(key).toLowerCase())) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactValue(value);
    }
  }
  return output;
};

const log = (level, message, fields = {}) => {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    env: NODE_ENV,
    ...redactObject(fields),
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
  return entry;
};

module.exports = {
  log,
  redactObject,
  redactValue,
};
