const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const DUPLICATE_INDEX_CODES = {
  uniq_customer_active_scheme: ERROR_CODES.DUPLICATE_ACTIVE_SCHEME,
  customer_1_enrollmentNumber_1: ERROR_CODES.DUPLICATE_RECORD,
  enrollmentNumber_1: ERROR_CODES.DUPLICATE_RECORD,
  receiptNumber_1: ERROR_CODES.DUPLICATE_RECORD,
  passbookNumber_1: ERROR_CODES.DUPLICATE_RECORD,
  phone_1: ERROR_CODES.DUPLICATE_RECORD,
  clientRequestId_1_operationType_1: ERROR_CODES.TRANSACTION_RETRY_REQUIRED,
};

const inferDuplicateCode = (err) => {
  const keyPattern = err?.keyPattern || {};
  const keyValue = err?.keyValue || {};
  const indexName = err?.message?.match(/index:\s(\S+)/)?.[1]?.replace(/:$/, "");

  if (indexName && DUPLICATE_INDEX_CODES[indexName]) {
    return DUPLICATE_INDEX_CODES[indexName];
  }

  if (keyPattern.customer === 1 && keyPattern.status === 1) {
    return ERROR_CODES.DUPLICATE_ACTIVE_SCHEME;
  }
  if (keyPattern.clientRequestId && keyPattern.operationType) {
    return ERROR_CODES.TRANSACTION_RETRY_REQUIRED;
  }
  if (keyPattern.phone) {
    return ERROR_CODES.DUPLICATE_RECORD;
  }
  if (keyPattern.enrollmentNumber) {
    return ERROR_CODES.DUPLICATE_RECORD;
  }
  if (keyPattern.receiptNumber) {
    return ERROR_CODES.DUPLICATE_RECORD;
  }
  if (keyPattern.passbookNumber) {
    return ERROR_CODES.DUPLICATE_RECORD;
  }
  if (keyValue.customer && keyPattern.status === "ACTIVE") {
    return ERROR_CODES.DUPLICATE_ACTIVE_SCHEME;
  }

  return ERROR_CODES.DUPLICATE_RECORD;
};

const mapMongooseError = (err) => {
  if (err instanceof ApiError) return err;

  if (err?.name === "ValidationError") {
    const message = Object.values(err.errors || {})
      .map((item) => item.message)
      .join("; ");
    return new ApiError(400, message || "Validation failed.");
  }

  if (err?.name === "CastError") {
    return new ApiError(400, "Invalid identifier or value.");
  }

  if (err?.code === 11000) {
    const code = inferDuplicateCode(err);
    const retryable = code === ERROR_CODES.TRANSACTION_RETRY_REQUIRED;
    const message =
      code === ERROR_CODES.DUPLICATE_ACTIVE_SCHEME
        ? "Customer already has an active scheme."
        : "Duplicate record detected.";
    return new ApiError(409, message, [], { code, retryable });
  }

  return null;
};

module.exports = {
  mapMongooseError,
};
