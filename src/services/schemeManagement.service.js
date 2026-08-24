const Scheme = require("../models/scheme.model");
const StaffProfile = require("../models/staffProfile.model");
const {
  SCHEME_STATUS,
  USER_ROLES,
  AUDIT_ACTIONS,
  IDEMPOTENCY_OPERATIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const { withTransaction } = require("../utils/transaction");
const { logAudit } = require("./audit.service");
const { enrichScheme } = require("./customer.service");
const {
  calculateSchemeDates,
  appendStatusHistory,
  createEnrollmentNumber,
} = require("./scheme.service");
const { getCustomerOrThrow, assertCustomerActiveForOperations } = require("./customer.service");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");
const { buildSchemeCreateIntent } = require("../utils/idempotencyPayload");
const { completeSettlement } = require("./settlement.service");

const getSchemeOrThrow = async (schemeId, session = null) => {
  const scheme = await Scheme.findById(schemeId).session(session || null);
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }
  return scheme;
};

const createScheme = async ({ customerId, schemeName, startDate, clientRequestId }, actor) => {
  if (!clientRequestId?.trim()) {
    throw new ApiError(400, "clientRequestId is required.");
  }

  const idempotencyPayload = buildSchemeCreateIntent({ customerId, schemeName, startDate });

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.SCHEME_CREATE,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    const customer = await getCustomerOrThrow(customerId);
    await assertCustomerActiveForOperations(customer);
    const activeScheme = await Scheme.findOne({
      customer: customer._id,
      status: SCHEME_STATUS.ACTIVE,
    }).session(session);
    if (activeScheme) {
      throw new ApiError(
        409,
        "Customer already has an active scheme. Close or complete the current scheme before creating another active scheme.",
        [],
        {
          code: ERROR_CODES.DUPLICATE_ACTIVE_SCHEME,
          retryable: false,
        }
      );
    }

    const dates = calculateSchemeDates(startDate || new Date());
    const enrollmentNumber = await createEnrollmentNumber(dates.startDate);

    let scheme;
    try {
      [scheme] = await Scheme.create(
        [
          {
            customer: customer._id,
            enrollmentNumber,
            schemeName: schemeName?.trim() || "Gold Savings Scheme",
            startDate: dates.startDate,
            sixMonthDate: dates.sixMonthDate,
            maturityDate: dates.maturityDate,
            status: SCHEME_STATUS.ACTIVE,
            statusHistory: [
              {
                status: SCHEME_STATUS.ACTIVE,
                changedBy: actor._id,
                changedByRole: actor.role,
                changedAt: new Date(),
                notes: "Scheme created",
              },
            ],
            createdBy: actor._id,
            updatedBy: actor._id,
          },
        ],
        { session }
      );
    } catch (error) {
      if (error?.code === 11000) {
        throw new ApiError(409, "Customer already has an active scheme.", [], {
          code: ERROR_CODES.DUPLICATE_ACTIVE_SCHEME,
          retryable: false,
        });
      }
      throw error;
    }

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SCHEME_CREATED,
      targetType: "Scheme",
      targetId: scheme._id,
      newValue: {
        customerId: customer._id,
        enrollmentNumber: scheme.enrollmentNumber,
        passbookNumber: customer.passbookNumber,
        clientRequestId,
      },
      notes: "Scheme enrollment created",
      session,
    });

    const response = { schemeId: scheme._id };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.SCHEME_CREATE,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "Scheme",
      resourceId: scheme._id,
      session,
    });

    return { replay: false, schemeId: scheme._id };
  });

  const schemeId = txnResult.replay ? txnResult.response.schemeId : txnResult.schemeId;
  const scheme = await getSchemeOrThrow(schemeId);
  return enrichScheme(scheme);
};

const updateSchemeStatus = async (schemeId, payload, actor) =>
  completeSettlement(schemeId, payload, actor);

const getSchemeDetail = async (schemeId) => {
  const scheme = await getSchemeOrThrow(schemeId);
  return enrichScheme(scheme);
};

module.exports = {
  createScheme,
  updateSchemeStatus,
  getSchemeDetail,
  getSchemeOrThrow,
};
