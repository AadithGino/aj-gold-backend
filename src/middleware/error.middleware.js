const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES, resolveErrorMeta } = require("../constants/errorCodes");
const { mapMongooseError } = require("../utils/mongoErrors");

const notFound = (req, res, next) => {
  next(new ApiError(404, `Not found: ${req.originalUrl}`));
};

const errorHandler = (err, req, res, next) => {
  const mapped = mapMongooseError(err) || err;
  const statusCode = mapped.statusCode || 500;
  const isProduction = process.env.NODE_ENV === "production";
  const message = statusCode === 500 && isProduction
    ? "Internal Server Error"
    : mapped.message || "Internal Server Error";
  const { code, retryable } = resolveErrorMeta(mapped);

  if (statusCode >= 500) {
    console.error(JSON.stringify({
      level: "error",
      requestId: req.requestId,
      code,
      message: mapped.message,
      stack: !isProduction ? mapped.stack : undefined,
    }));
  }

  res.status(statusCode).json({
    success: false,
    message,
    code,
    retryable,
    requestId: req.requestId,
    errors: mapped.errors || [],
    ...(!isProduction && statusCode >= 500 && mapped.stack ? { stack: mapped.stack } : {}),
  });
};

module.exports = { notFound, errorHandler };
