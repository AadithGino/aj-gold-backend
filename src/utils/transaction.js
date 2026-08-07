const mongoose = require("mongoose");
const ApiError = require("./ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const TXN_OPTIONS = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
};

const isTransientTransactionError = (error) =>
  error?.errorLabels?.includes("TransientTransactionError") ||
  error?.errorLabels?.includes("UnknownTransactionCommitResult") ||
  error?.code === 24;

const transactionConflictError = (message = "Operation conflict. Please retry.") =>
  new ApiError(409, message, [], {
    code: ERROR_CODES.TRANSACTION_RETRY_REQUIRED,
    retryable: true,
  });

const withTransaction = async (work, { maxRetries = 3 } = {}) => {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work(session);
      }, TXN_OPTIONS);
      return result;
    } catch (error) {
      lastError = error;
      if (isTransientTransactionError(error) && attempt < maxRetries - 1) {
        continue;
      }
      if (error instanceof ApiError) {
        throw error;
      }
      if (error?.code === 11000) {
        throw new ApiError(409, "Duplicate operation detected.", [], {
          code: ERROR_CODES.TRANSACTION_RETRY_REQUIRED,
          retryable: true,
        });
      }
      throw error;
    } finally {
      session.endSession();
    }
  }

  if (lastError instanceof ApiError) {
    throw lastError;
  }
  if (lastError?.code === 11000) {
    throw transactionConflictError("Duplicate operation detected.");
  }
  if (isTransientTransactionError(lastError)) {
    throw transactionConflictError();
  }
  throw lastError;
};

module.exports = {
  withTransaction,
  TXN_OPTIONS,
  transactionConflictError,
};
