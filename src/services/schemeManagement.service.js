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
const { hasStaffPermission } = require("../constants/staffPermissions");
const { parsePositiveRupeeInteger } = require("../utils/money");
const { withTransaction } = require("../utils/transaction");
const { isSchemeSettled } = require("../utils/scheme");
const { logAudit } = require("./audit.service");
const { enrichScheme } = require("./customer.service");
const {
  calculateSchemeDates,
  assertCustomerCanCreateActiveScheme,
  appendStatusHistory,
  createEnrollmentNumber,
} = require("./scheme.service");
const { getCustomerOrThrow } = require("./customer.service");
const { getTotalPaidForScheme } = require("./paymentLimit.service");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");

const auditActionForStatus = {
  [SCHEME_STATUS.REDEEMED]: AUDIT_ACTIONS.SCHEME_REDEEMED,
  [SCHEME_STATUS.CLOSED]: AUDIT_ACTIONS.SCHEME_CLOSED,
};

const getSchemeOrThrow = async (schemeId, session = null) => {
  const scheme = await Scheme.findById(schemeId).session(session || null);
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }
  return scheme;
};

const createScheme = async ({ customerId, schemeName, startDate }, actor) => {
  const customer = await getCustomerOrThrow(customerId);
  await assertCustomerCanCreateActiveScheme(customerId);

  const dates = calculateSchemeDates(startDate || new Date());
  const enrollmentNumber = await createEnrollmentNumber(dates.startDate);

  const scheme = await Scheme.create({
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
  });

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
    },
    notes: "Scheme enrollment created",
  });

  return enrichScheme(scheme);
};

const updateSchemeStatus = async (schemeId, payload, actor) => {
  const { status, notes } = payload;

  if (actor.role === USER_ROLES.STAFF) {
    const profile = await StaffProfile.findOne({ user: actor._id });
    if (status === SCHEME_STATUS.REDEEMED && !hasStaffPermission(profile, "canMarkRedeemed")) {
      throw new ApiError(403, "Staff does not have redeem permission.");
    }
    if (status === SCHEME_STATUS.CLOSED && !hasStaffPermission(profile, "canMarkClosed")) {
      throw new ApiError(403, "Staff does not have early closure permission.");
    }
  } else if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin or authorized staff can settle schemes.");
  }

  if (![SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED].includes(status)) {
    throw new ApiError(
      400,
      "Only REDEEMED (after maturity) or CLOSED (before maturity) are allowed."
    );
  }

  const settlementAmount = parsePositiveRupeeInteger(payload.settlementAmount, "settlementAmount");
  const trimmedNotes = notes?.trim();
  if (!trimmedNotes) {
    throw new ApiError(400, "Notes are required for this status change.");
  }

  const idempotencyPayload = {
    schemeId,
    status,
    settlementAmount,
    notes: trimmedNotes,
    overrideReason: payload.overrideReason?.trim() || "",
  };

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId: payload.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.SCHEME_SETTLEMENT,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    const scheme = await Scheme.findOne({
      _id: schemeId,
      status: SCHEME_STATUS.ACTIVE,
    }).session(session);

    if (!scheme) {
      const existing = await Scheme.findById(schemeId).session(session);
      if (existing && isSchemeSettled(existing)) {
        throw new ApiError(409, "Scheme is already settled.", [], {
          code: ERROR_CODES.SCHEME_ALREADY_SETTLED,
          retryable: false,
        });
      }
      throw new ApiError(409, "Scheme must be ACTIVE to settle.");
    }

    if (status === SCHEME_STATUS.REDEEMED && new Date() < new Date(scheme.maturityDate)) {
      throw new ApiError(400, "Scheme can be redeemed only after maturity date.");
    }

    if (status === SCHEME_STATUS.CLOSED && new Date() >= new Date(scheme.maturityDate)) {
      throw new ApiError(400, "After maturity date use REDEEMED status.");
    }

    const totalPaidAtSettlement = await getTotalPaidForScheme(scheme._id, session);
    const overrideReason = payload.overrideReason?.trim() || "";

    if (settlementAmount > totalPaidAtSettlement) {
      if (!overrideReason) {
        throw new ApiError(
          400,
          "overrideReason is required when settlementAmount exceeds total successful payments."
        );
      }
    }

    const previousStatus = scheme.status;
    appendStatusHistory(scheme, {
      status,
      changedBy: actor._id,
      changedByRole: actor.role,
      notes: trimmedNotes,
    });

    scheme.status = status;
    scheme.settlement = {
      amount: settlementAmount,
      settledAt: new Date(),
      settledBy: actor._id,
      notes: trimmedNotes,
      clientRequestId: payload.clientRequestId,
      overrideReason,
      totalPaidAtSettlement,
    };
    scheme.updatedBy = actor._id;
    scheme.financialVersion = (scheme.financialVersion || 0) + 1;
    await scheme.save({ session });

    const auditAction = auditActionForStatus[status] || AUDIT_ACTIONS.CUSTOMER_UPDATED;

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: auditAction,
      targetType: "Scheme",
      targetId: scheme._id,
      previousValue: { status: previousStatus },
      newValue: {
        status,
        notes: trimmedNotes,
        settlementAmount,
        totalPaidAtSettlement,
        overrideReason,
        clientRequestId: payload.clientRequestId,
      },
      notes: `Scheme status changed to ${status}`,
      session,
    });

    const response = { schemeId: scheme._id };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.SCHEME_SETTLEMENT,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "Scheme",
      resourceId: scheme._id,
      session,
    });

    return { replay: false, schemeId: scheme._id };
  });

  const resolvedSchemeId = txnResult.replay ? txnResult.response.schemeId : txnResult.schemeId;
  const scheme = await getSchemeOrThrow(resolvedSchemeId);
  return enrichScheme(scheme);
};

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
