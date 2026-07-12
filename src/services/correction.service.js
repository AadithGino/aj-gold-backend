const PaymentCorrection = require("../models/paymentCorrection.model");
const Payment = require("../models/payment.model");
const Scheme = require("../models/scheme.model");
const Customer = require("../models/customer.model");
const {
  USER_ROLES,
  CORRECTION_TYPES,
  CORRECTION_STATUS,
  PAYMENT_STATUS,
  PAYMENT_METHODS,
  AUDIT_ACTIONS,
  IDEMPOTENCY_OPERATIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const { parsePositiveRupeeInteger } = require("../utils/money");
const { withTransaction } = require("../utils/transaction");
const { isSchemeSettled } = require("../utils/scheme");
const { parseDateRange } = require("../utils/date");
const { logAudit } = require("./audit.service");
const { getPaymentByIdOrThrow } = require("./payment.service");
const { getSchemeLimitSummary } = require("./paymentLimit.service");
const { notifyPaymentReversed } = require("./notification.service");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");
const {
  lockStaffCashProfile,
  assertNoNegativeCashAfterPaymentChange,
} = require("./staffCash.service");

const buildPaymentSnapshot = (payment) => ({
  amount: payment.amount,
  paymentMethod: payment.paymentMethod,
  paymentDate: payment.paymentDate,
  transactionReference: payment.transactionReference || "",
  notes: payment.notes || "",
  status: payment.status,
  receiptNumber: payment.receiptNumber,
});

const mapCorrection = (doc) => ({
  _id: doc._id,
  payment: doc.payment,
  customer: doc.customer,
  scheme: doc.scheme,
  requestedBy: doc.requestedBy,
  requestedByRole: doc.requestedByRole,
  correctionType: doc.correctionType,
  originalSnapshot: doc.originalSnapshot,
  appliedSnapshot: doc.appliedSnapshot,
  requestedValue: doc.requestedValue,
  reason: doc.reason,
  status: doc.status,
  reviewedBy: doc.reviewedBy,
  reviewedAt: doc.reviewedAt,
  reviewNotes: doc.reviewNotes || "",
  notes: doc.notes || "",
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const assertCanRequestCorrection = async (payment, actor, session = null) => {
  if (actor.role === USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Customers cannot request payment corrections.");
  }

  if (actor.role === USER_ROLES.STAFF) {
    const collectorId = String(payment.collectedBy?._id || payment.collectedBy);
    if (collectorId !== String(actor._id)) {
      throw new ApiError(403, "Staff can only request corrections for payments they collected.");
    }
  }

  const scheme = await Scheme.findById(payment.scheme._id || payment.scheme).session(session || null);
  if (scheme && isSchemeSettled(scheme)) {
    throw new ApiError(409, "Scheme is already settled.", [], {
      code: ERROR_CODES.SCHEME_ALREADY_SETTLED,
      retryable: false,
    });
  }

  const pending = await PaymentCorrection.findOne({
    payment: payment._id,
    status: CORRECTION_STATUS.PENDING,
  }).session(session || null);
  if (pending) {
    throw new ApiError(409, "A pending correction already exists for this payment.", [], {
      code: ERROR_CODES.PENDING_CORRECTION_EXISTS,
      retryable: false,
    });
  }
};

const validateRequestedValue = (correctionType, requestedValue) => {
  if (correctionType === CORRECTION_TYPES.REVERSE_PAYMENT) {
    return requestedValue || null;
  }
  if (requestedValue == null || requestedValue === "") {
    throw new ApiError(400, "requestedValue is required for this correction type.");
  }

  switch (correctionType) {
    case CORRECTION_TYPES.EDIT_AMOUNT:
      return parsePositiveRupeeInteger(requestedValue, "amount");
    case CORRECTION_TYPES.EDIT_METHOD: {
      if (!Object.values(PAYMENT_METHODS).includes(requestedValue)) {
        throw new ApiError(400, "Invalid payment method.");
      }
      return requestedValue;
    }
    case CORRECTION_TYPES.EDIT_DATE: {
      const date = new Date(requestedValue);
      if (Number.isNaN(date.getTime())) throw new ApiError(400, "Invalid payment date.");
      return date;
    }
    case CORRECTION_TYPES.EDIT_REFERENCE:
    case CORRECTION_TYPES.EDIT_NOTES:
      return String(requestedValue).trim();
    default:
      return requestedValue;
  }
};

const createCorrectionRequest = async (paymentId, payload, actor) => {
  const payment = await getPaymentByIdOrThrow(paymentId);

  if (payment.status !== PAYMENT_STATUS.SUCCESS) {
    throw new ApiError(409, "Only SUCCESS payments can be corrected.");
  }

  await assertCanRequestCorrection(payment, actor);

  const reason = payload.reason?.trim();
  if (!reason) throw new ApiError(400, "Reason is required.");

  if (!Object.values(CORRECTION_TYPES).includes(payload.correctionType)) {
    throw new ApiError(400, "Invalid correction type.");
  }

  const requestedValue = validateRequestedValue(payload.correctionType, payload.requestedValue);

  const correction = await PaymentCorrection.create({
    payment: payment._id,
    customer: payment.customer._id || payment.customer,
    scheme: payment.scheme._id || payment.scheme,
    requestedBy: actor._id,
    requestedByRole: actor.role,
    correctionType: payload.correctionType,
    originalSnapshot: buildPaymentSnapshot(payment),
    requestedValue,
    reason,
    status: CORRECTION_STATUS.PENDING,
    notes: payload.notes?.trim() || "",
  });

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CORRECTION_REQUESTED,
    targetType: "PaymentCorrection",
    targetId: correction._id,
    newValue: {
      paymentId: payment._id,
      correctionType: correction.correctionType,
      requestedValue,
    },
    notes: reason,
  });

  return mapCorrection(
    await PaymentCorrection.findById(correction._id)
      .populate("requestedBy", "name role")
      .populate("payment", "receiptNumber amount paymentMethod")
  );
};

const resolveApprovedValues = (payment, correction, approvedValue) => {
  const value = approvedValue != null ? approvedValue : correction.requestedValue;
  const { correctionType } = correction;

  if (correctionType === CORRECTION_TYPES.REVERSE_PAYMENT) {
    return {
      amount: payment.amount,
      paymentMethod: payment.paymentMethod,
      paymentDate: payment.paymentDate,
      transactionReference: payment.transactionReference || "",
      notes: correction.reason,
      status: PAYMENT_STATUS.REVERSED,
    };
  }

  const next = {
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    paymentDate: payment.paymentDate,
    transactionReference: payment.transactionReference || "",
    notes: payment.notes || "",
    status: payment.status,
  };

  switch (correctionType) {
    case CORRECTION_TYPES.EDIT_AMOUNT:
      next.amount = parsePositiveRupeeInteger(value, "amount");
      break;
    case CORRECTION_TYPES.EDIT_METHOD:
      if (!Object.values(PAYMENT_METHODS).includes(value)) {
        throw new ApiError(400, "Invalid payment method.");
      }
      next.paymentMethod = value;
      break;
    case CORRECTION_TYPES.EDIT_DATE: {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new ApiError(400, "Invalid payment date.");
      next.paymentDate = date;
      break;
    }
    case CORRECTION_TYPES.EDIT_REFERENCE:
      next.transactionReference = String(value);
      break;
    case CORRECTION_TYPES.EDIT_NOTES:
      next.notes = String(value);
      break;
    default:
      throw new ApiError(400, "Unsupported correction type.");
  }

  return next;
};

const applyCashCorrectionGuards = async (payment, nextValues, session) => {
  const staffCollector =
    payment.collectedByRole === USER_ROLES.STAFF ? payment.collectedBy : null;
  if (!staffCollector) return;

  const affectsCash =
    payment.paymentMethod === PAYMENT_METHODS.CASH ||
    nextValues.paymentMethod === PAYMENT_METHODS.CASH;

  if (!affectsCash) return;

  await lockStaffCashProfile(staffCollector, session);
  await assertNoNegativeCashAfterPaymentChange({
    staffId: staffCollector,
    previousAmount: payment.amount,
    previousMethod: payment.paymentMethod,
    nextAmount: nextValues.amount,
    nextMethod: nextValues.paymentMethod,
    session,
  });
};

const applyApprovedCorrection = async (payment, correction, approvedValue, session) => {
  const nextValues = resolveApprovedValues(payment, correction, approvedValue);

  if (
    nextValues.status === PAYMENT_STATUS.REVERSED ||
    correction.correctionType === CORRECTION_TYPES.REVERSE_PAYMENT
  ) {
    await applyCashCorrectionGuards(payment, nextValues, session);
    payment.status = PAYMENT_STATUS.REVERSED;
    payment.notes = nextValues.notes;
    await payment.save({ session });
    return buildPaymentSnapshot(payment);
  }

  await applyCashCorrectionGuards(payment, nextValues, session);

  payment.amount = nextValues.amount;
  payment.paymentMethod = nextValues.paymentMethod;
  payment.paymentDate = nextValues.paymentDate;
  payment.transactionReference = nextValues.transactionReference;
  payment.notes = nextValues.notes;
  await payment.save({ session });

  return buildPaymentSnapshot(payment);
};

const assertSettlementAllowsCorrection = (scheme, payload) => {
  if (!isSchemeSettled(scheme)) return;

  const allowOverride = Boolean(payload.settlementAdjustmentOverride);
  const overrideReason = payload.settlementAdjustmentReason?.trim() || "";
  if (!allowOverride || !overrideReason) {
    throw new ApiError(
      409,
      "Scheme is settled. Provide settlementAdjustmentOverride and settlementAdjustmentReason."
    );
  }
};

const approveCorrection = async (correctionId, payload, actor) => {
  if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can approve corrections.");
  }

  const idempotencyPayload = {
    correctionId,
    approvedValue: payload.approvedValue ?? null,
    reviewNotes: payload.reviewNotes?.trim() || "",
    settlementAdjustmentOverride: Boolean(payload.settlementAdjustmentOverride),
    settlementAdjustmentReason: payload.settlementAdjustmentReason?.trim() || "",
  };

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId: payload.reviewClientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CORRECTION_APPROVE,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    const correction = await PaymentCorrection.findOneAndUpdate(
      { _id: correctionId, status: CORRECTION_STATUS.PENDING },
      {
        $set: {
          status: CORRECTION_STATUS.APPROVED,
          reviewedBy: actor._id,
          reviewedAt: new Date(),
          reviewNotes: payload.reviewNotes?.trim() || "",
          reviewClientRequestId: payload.reviewClientRequestId,
        },
      },
      { new: false, session }
    );

    if (!correction) {
      const existing = await PaymentCorrection.findById(correctionId).session(session);
      if (!existing) throw new ApiError(404, "Correction request not found.");
      throw new ApiError(409, "Correction is not pending.", [], {
        code: ERROR_CODES.CORRECTION_ALREADY_REVIEWED,
        retryable: false,
      });
    }

    const payment = await Payment.findById(correction.payment).session(session);
    if (!payment) throw new ApiError(404, "Linked payment not found.");
    if (payment.status !== PAYMENT_STATUS.SUCCESS && correction.correctionType !== CORRECTION_TYPES.REVERSE_PAYMENT) {
      throw new ApiError(409, "Only SUCCESS payments can be corrected.");
    }

    const scheme = await Scheme.findById(correction.scheme).session(session);
    if (!scheme) throw new ApiError(404, "Scheme not found.");
    assertSettlementAllowsCorrection(scheme, payload);

    const approvedValue =
      payload.approvedValue != null
        ? validateRequestedValue(correction.correctionType, payload.approvedValue)
        : correction.requestedValue;

    const appliedSnapshot = await applyApprovedCorrection(
      payment,
      correction,
      approvedValue,
      session
    );

    await PaymentCorrection.updateOne(
      { _id: correction._id },
      {
        $set: {
          appliedSnapshot,
          requestedValue: payload.approvedValue != null ? approvedValue : correction.requestedValue,
        },
      },
      { session }
    );

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.CORRECTION_APPROVED,
      targetType: "PaymentCorrection",
      targetId: correction._id,
      previousValue: correction.originalSnapshot,
      newValue: {
        paymentId: payment._id,
        correctionType: correction.correctionType,
        approvedValue,
        appliedSnapshot,
        reviewClientRequestId: payload.reviewClientRequestId,
        settlementAdjustmentOverride: Boolean(payload.settlementAdjustmentOverride),
        settlementAdjustmentReason: payload.settlementAdjustmentReason?.trim() || "",
      },
      notes: payload.reviewNotes?.trim() || payload.reason || "Correction approved",
      session,
    });

    const response = {
      correctionId: correction._id,
      paymentId: payment._id,
      schemeId: payment.scheme,
      notifyReverse: correction.correctionType === CORRECTION_TYPES.REVERSE_PAYMENT,
    };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CORRECTION_APPROVE,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "PaymentCorrection",
      resourceId: correction._id,
      session,
    });

    return { replay: false, response };
  });

  const correctionRef = txnResult.replay
    ? txnResult.response.correctionId
    : txnResult.response.correctionId;

  if (!txnResult.replay && txnResult.response.notifyReverse) {
    const payment = await Payment.findById(txnResult.response.paymentId);
    const customer = await Customer.findById(payment.customer).lean();
    if (customer && payment) {
      notifyPaymentReversed({
        customer,
        payment: {
          _id: payment._id,
          amount: payment.amount,
          receiptNumber: payment.receiptNumber,
        },
      });
    }
  }

  const schemeSummary = await getSchemeLimitSummary(
    txnResult.replay ? txnResult.response.schemeId : txnResult.response.schemeId
  );
  const populated = await PaymentCorrection.findById(correctionRef)
    .populate("requestedBy", "name role")
    .populate("reviewedBy", "name role")
    .populate("payment", "receiptNumber amount paymentMethod status");

  return { correction: mapCorrection(populated), schemeSummary };
};

const rejectCorrection = async (correctionId, payload, actor) => {
  if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can reject corrections.");
  }

  const idempotencyPayload = {
    correctionId,
    reviewNotes: payload.reviewNotes?.trim() || payload.reason?.trim() || "",
  };

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId: payload.reviewClientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CORRECTION_REJECT,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    const correction = await PaymentCorrection.findOneAndUpdate(
      { _id: correctionId, status: CORRECTION_STATUS.PENDING },
      {
        $set: {
          status: CORRECTION_STATUS.REJECTED,
          reviewedBy: actor._id,
          reviewedAt: new Date(),
          reviewNotes: payload.reviewNotes?.trim() || payload.reason?.trim() || "",
          reviewClientRequestId: payload.reviewClientRequestId,
        },
      },
      { new: true, session }
    );

    if (!correction) {
      const existing = await PaymentCorrection.findById(correctionId).session(session);
      if (!existing) throw new ApiError(404, "Correction request not found.");
      throw new ApiError(409, "Correction is not pending.", [], {
        code: ERROR_CODES.CORRECTION_ALREADY_REVIEWED,
        retryable: false,
      });
    }

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.CORRECTION_REJECTED,
      targetType: "PaymentCorrection",
      targetId: correction._id,
      notes: correction.reviewNotes || "Correction rejected",
      session,
    });

    const response = { correctionId: correction._id };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CORRECTION_REJECT,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "PaymentCorrection",
      resourceId: correction._id,
      session,
    });

    return { replay: false, response };
  });

  const correctionRef = txnResult.replay
    ? txnResult.response.correctionId
    : txnResult.response.correctionId;

  const populated = await PaymentCorrection.findById(correctionRef)
    .populate("requestedBy", "name role")
    .populate("reviewedBy", "name role")
    .populate("payment", "receiptNumber amount paymentMethod status");

  return mapCorrection(populated);
};

const listCorrections = async (filters = {}, actor) => {
  const query = {};
  const range = parseDateRange(filters.from, filters.to);
  if (range.error) throw new ApiError(400, range.error);

  if (actor.role === USER_ROLES.STAFF) {
    query.requestedBy = actor._id;
  } else if (filters.staffId) {
    query.requestedBy = filters.staffId;
  }

  if (filters.status) query.status = filters.status;
  if (filters.customerId) query.customer = filters.customerId;
  if (filters.schemeId) query.scheme = filters.schemeId;
  if (range.from || range.to) {
    query.createdAt = {};
    if (range.from) query.createdAt.$gte = range.from;
    if (range.to) query.createdAt.$lte = range.to;
  }

  const items = await PaymentCorrection.find(query)
    .populate("requestedBy", "name role")
    .populate("reviewedBy", "name role")
    .populate("payment", "receiptNumber amount paymentMethod status paymentDate")
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status")
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(filters.limit) || 100, 200))
    .lean();

  return items.map(mapCorrection);
};

const getCorrectionDetail = async (correctionId, actor) => {
  const correction = await PaymentCorrection.findById(correctionId)
    .populate("requestedBy", "name role phone")
    .populate("reviewedBy", "name role")
    .populate("payment")
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status schemeName");

  if (!correction) throw new ApiError(404, "Correction request not found.");

  if (
    actor.role === USER_ROLES.STAFF &&
    String(correction.requestedBy._id || correction.requestedBy) !== String(actor._id)
  ) {
    throw new ApiError(403, "Forbidden.");
  }

  return mapCorrection(correction);
};

module.exports = {
  createCorrectionRequest,
  approveCorrection,
  rejectCorrection,
  listCorrections,
  getCorrectionDetail,
  buildPaymentSnapshot,
};
