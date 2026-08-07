const { resolveErrorMeta } = require("../constants/errorCodes");

class ApiError extends Error {
  constructor(statusCode, message, errors = [], meta = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.message = message;
    this.errors = Array.isArray(errors) ? errors : [];
    this.success = false;

    if (meta && typeof meta === "object") {
      this.code = meta.code;
      this.retryable = meta.retryable;
    }

    const resolved = resolveErrorMeta(this);
    this.code = resolved.code;
    this.retryable = resolved.retryable;
  }
}

module.exports = ApiError;
