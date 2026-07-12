const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ApiError = require("../src/utils/ApiError");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const { errorHandler } = require("../src/middleware/error.middleware");
const loginRateLimitMiddleware = require("../src/middleware/loginRateLimit.middleware");

const invokeErrorHandler = (err, requestId = "req-test") => {
  const req = { requestId, originalUrl: "/api/test" };
  let statusCode;
  let body;

  errorHandler(err, req, {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  }, () => {});

  return { statusCode, body };
};

describe("API error contract", () => {
  it("includes code and retryable in error responses", () => {
    const err = new ApiError(409, "Operation conflict. Please retry.", [], {
      code: ERROR_CODES.TRANSACTION_RETRY_REQUIRED,
      retryable: true,
    });
    const { statusCode, body } = invokeErrorHandler(err);

    assert.equal(statusCode, 409);
    assert.equal(body.code, ERROR_CODES.TRANSACTION_RETRY_REQUIRED);
    assert.equal(body.retryable, true);
    assert.equal(body.message, "Operation conflict. Please retry.");
    assert.equal(body.requestId, "req-test");
    assert.equal(body.success, false);
  });

  it("defaults validation errors to VALIDATION_ERROR", () => {
    const { body } = invokeErrorHandler(new ApiError(400, "Amount is required."));
    assert.equal(body.code, ERROR_CODES.VALIDATION_ERROR);
    assert.equal(body.retryable, false);
  });

  it("defaults authentication errors to UNAUTHORIZED", () => {
    const { body } = invokeErrorHandler(new ApiError(401, "Invalid phone or password."));
    assert.equal(body.code, ERROR_CODES.UNAUTHORIZED);
    assert.equal(body.retryable, false);
  });

  it("does not expose stack traces in production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const err = new Error("boom");
      err.statusCode = 500;
      const { body } = invokeErrorHandler(err);
      assert.equal(body.message, "Internal Server Error");
      assert.equal(body.code, ERROR_CODES.INTERNAL_ERROR);
      assert.equal(body.stack, undefined);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("rate limiting returns RATE_LIMITED", () => {
    const req = { ip: "127.0.0.1", headers: {} };
    const next = (err) => {
      assert.equal(err.statusCode, 429);
      assert.equal(err.code, ERROR_CODES.RATE_LIMITED);
      assert.equal(err.retryable, false);
    };

    for (let i = 0; i < 20; i += 1) {
      loginRateLimitMiddleware(req, {}, () => {});
    }
    loginRateLimitMiddleware(req, {}, next);
  });
});

module.exports = { invokeErrorHandler };
