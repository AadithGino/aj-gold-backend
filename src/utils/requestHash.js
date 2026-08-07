const crypto = require("crypto");

const stableStringify = (value) => {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
};

const hashRequestPayload = (payload) =>
  crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");

module.exports = {
  stableStringify,
  hashRequestPayload,
};
