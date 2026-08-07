const IdempotencyRecord = require("../models/idempotencyRecord.model");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const { hashRequestPayload } = require("../utils/requestHash");

const assertClientRequestId = (clientRequestId) => {
  const id = clientRequestId?.trim();
  if (!id) {
    throw new ApiError(400, "clientRequestId is required.");
  }
  if (id.length > 128) {
    throw new ApiError(400, "clientRequestId is too long.");
  }
  return id;
};

const checkIdempotencyReplay = async ({ clientRequestId, operationType, requestPayload, session }) => {
  const normalizedId = assertClientRequestId(clientRequestId);
  const requestHash = hashRequestPayload(requestPayload);

  const existing = await IdempotencyRecord.findOne({
    clientRequestId: normalizedId,
    operationType,
  }).session(session || null);

  if (!existing) {
    return { replay: false, requestHash, clientRequestId: normalizedId };
  }

  if (existing.requestHash !== requestHash) {
    throw new ApiError(409, "clientRequestId was reused with different request data.", [], {
      code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      retryable: false,
    });
  }

  if (existing.responsePayload != null) {
    return { replay: true, requestHash, clientRequestId: normalizedId, response: existing.responsePayload };
  }

  throw new ApiError(409, "Duplicate operation detected.", [], {
    code: ERROR_CODES.TRANSACTION_RETRY_REQUIRED,
    retryable: true,
  });
};

const saveIdempotencyResult = async ({
  clientRequestId,
  operationType,
  requestHash,
  responsePayload,
  actor,
  resourceType,
  resourceId,
  session,
}) => {
  try {
    await IdempotencyRecord.create(
      [
        {
          clientRequestId,
          operationType,
          requestHash,
          status: "COMPLETED",
          responsePayload,
          actor: actor?._id,
          resourceType,
          resourceId,
        },
      ],
      { session }
    );
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await IdempotencyRecord.findOne({ clientRequestId, operationType }).session(session);
      if (raced?.requestHash === requestHash && raced.responsePayload != null) {
        return raced.responsePayload;
      }
      throw new ApiError(409, "Duplicate operation detected.", [], {
        code: ERROR_CODES.TRANSACTION_RETRY_REQUIRED,
        retryable: true,
      });
    }
    throw error;
  }
  return responsePayload;
};

module.exports = {
  assertClientRequestId,
  checkIdempotencyReplay,
  saveIdempotencyResult,
  hashRequestPayload,
};
