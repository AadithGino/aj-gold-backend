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
const { isSchemeFinanciallyLocked } = require("../utils/scheme");
const { parseDateRange } = require("../utils/date");
const { logAudit } = require("./audit.service");
const { getPaymentByIdOrThrow } = require("./payment.service");
const { getSchemeLimitSummary } = require("./paymentLimit.service");
const {
  recordEffectiveStateCorrection,
} = require("../utils/journalRecording");
const { enqueueOutboxEvent } = require("./outbox.service");
const { OUTBOX_TOPICS } = require("../models/outboxEvent.model");
const { NOTIFICATION_TYPES } = require("../models/notification.model");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");
const {
  buildSourceSnapshot,
  getEffectiveLedgerFields,
  loadSchemeLedgerContext,
} = require("../utils/paymentLedger");
const {
  buildEffectiveSnapshot,
  getEffectiveSnapshotForPayment,
  assertNonCashCollectionReference,
} = require("../utils/effectivePayment");
const { assertProposedLedgerEntry, assertLedgerEntriesValid } = require("../utils/ledgerValidation");
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

const isDuplicateKeyError = (error) => error?.code === 11000;

const mapCorrection = (doc) => ({
  _id: doc._id,
  payment: doc.payment,
  customer: doc.customer,
  scheme: doc.scheme,
  requestedBy: doc.requestedBy,
  requestedByRole: doc.requestedByRole,
  correctionType: doc.correctionType,
  originalSnapshot: doc.originalSnapshot,
  beforeSnapshot: doc.beforeSnapshot,
  appliedSnapshot: doc.appliedSnapshot,
  afterSnapshot: doc.afterSnapshot || doc.appliedSnapshot,
  version: doc.version,
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

  if (actor.role === USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only the collecting staff member may request a payment correction.");
  }

  if (actor.role === USER_ROLES.STAFF) {
    const collectorId = String(payment.collectedBy?._id || payment.collectedBy);
    if (collectorId !== String(actor._id)) {
      throw new ApiError(403, "Staff can only request corrections for payments they collected.");
    }
  }

  const scheme = await Scheme.findById(payment.scheme._id || payment.scheme).session(session || null);
  if (scheme && isSchemeFinanciallyLocked(scheme)) {
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

  const beforeSnapshot = await getEffectiveSnapshotForPayment(payment._id);
  let correction;
  try {
    correction = await PaymentCorrection.create({
      payment: payment._id,
      customer: payment.customer._id || payment.customer,
      scheme: payment.scheme._id || payment.scheme,
      requestedBy: actor._id,
      requestedByRole: actor.role,
      correctionType: payload.correctionType,
      originalSnapshot: buildPaymentSnapshot(payment),
      beforeSnapshot,
      requestedValue,
      reason,
      status: CORRECTION_STATUS.PENDING,
      notes: payload.notes?.trim() || "",
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError(409, "A pending correction already exists for this payment.", [], {
        code: ERROR_CODES.PENDING_CORRECTION_EXISTS,
        retryable: false,
      });
    }
    throw error;
  }

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

const resolveApprovedValues = (currentEffective, correction, approvedValue) => {
  const value = approvedValue != null ? approvedValue : correction.requestedValue;
  const { correctionType } = correction;

  if (correctionType === CORRECTION_TYPES.REVERSE_PAYMENT) {
    return {
      amount: currentEffective.amount,
      paymentMethod: currentEffective.paymentMethod,
      paymentDate: currentEffective.paymentDate,
      transactionReference: currentEffective.transactionReference || "",
      notes: correction.reason,
      status: PAYMENT_STATUS.REVERSED,
    };
  }

  const next = {
    amount: currentEffective.amount,
    paymentMethod: currentEffective.paymentMethod,
    paymentDate: currentEffective.paymentDate,
    transactionReference: currentEffective.transactionReference || "",
    notes: currentEffective.notes || "",
    status: currentEffective.status,
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
      next.transactionReference = String(value).trim();
      break;
    case CORRECTION_TYPES.EDIT_NOTES:
      next.notes = String(value).trim();
      break;
    default:
      throw new ApiError(400, "Unsupported correction type.");
  }

  return next;
};

const assertApprovedValuesValid = (nextValues) => {
  assertNonCashCollectionReference(nextValues.paymentMethod, nextValues.transactionReference);
};

const applyCashCorrectionGuards = async (payment, previousEffective, nextValues, session) => {
  const staffCollector =
    payment.collectedByRole === USER_ROLES.STAFF ? payment.collectedBy : null;
  if (!staffCollector) return;

  const affectsCash =
    previousEffective.paymentMethod === PAYMENT_METHODS.CASH ||
    nextValues.paymentMethod === PAYMENT_METHODS.CASH;

  if (!affectsCash) return;

  await lockStaffCashProfile(staffCollector, session);
  await assertNoNegativeCashAfterPaymentChange({
    staffId: staffCollector,
    previousAmount: previousEffective.amount,
    previousMethod: previousEffective.paymentMethod,
    nextAmount: nextValues.amount,
    nextMethod: nextValues.paymentMethod,
    session,
  });
};

const applyApprovedCorrection = async (payment, correction, beforeSnapshot, nextValues, session) => {
  if (
    nextValues.status === PAYMENT_STATUS.REVERSED ||
    correction.correctionType === CORRECTION_TYPES.REVERSE_PAYMENT
  ) {
    await applyCashCorrectionGuards(payment, beforeSnapshot, nextValues, session);
    payment.status = PAYMENT_STATUS.REVERSED;
    payment.notes = nextValues.notes;
    await payment.save({ session });
    return {
      ...beforeSnapshot,
      status: PAYMENT_STATUS.REVERSED,
      notes: nextValues.notes,
      receiptNumber: payment.receiptNumber,
      sourceSnapshot: buildSourceSnapshot(payment),
    };
  }

  await applyCashCorrectionGuards(payment, beforeSnapshot, nextValues, session);

  return {
    amount: nextValues.amount,
    paymentMethod: nextValues.paymentMethod,
    paymentDate: nextValues.paymentDate,
    transactionReference: nextValues.transactionReference,
    notes: nextValues.notes,
    status: payment.status,
    receiptNumber: payment.receiptNumber,
    sourceSnapshot: buildSourceSnapshot(payment),
  };
};

const assertSettlementAllowsCorrection = (scheme) => {
  if (isSchemeFinanciallyLocked(scheme)) {
    throw new ApiError(409, "Scheme is already settled.", [], {
      code: ERROR_CODES.SCHEME_ALREADY_SETTLED,
      retryable: false,
    });
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
      { returnDocument: "before", session }
    );

    if (!correction) {
      const existing = await PaymentCorrection.findById(correctionId).session(session);
      if (!existing) throw new ApiError(404, "Correction request not found.");
      throw new ApiError(409, "Correction is not pending.", [], {
        code: ERROR_CODES.CORRECTION_ALREADY_REVIEWED,
        retryable: false,
      });
    }

    if (String(correction.requestedBy) === String(actor._id)) {
      throw new ApiError(403, "Requester cannot approve their own correction request.");
    }

    const payment = await Payment.findById(correction.payment).session(session);
    if (!payment) throw new ApiError(404, "Linked payment not found.");
    if (payment.status !== PAYMENT_STATUS.SUCCESS && correction.correctionType !== CORRECTION_TYPES.REVERSE_PAYMENT) {
      throw new ApiError(409, "Only SUCCESS payments can be corrected.");
    }

    const scheme = await Scheme.findById(correction.scheme).session(session);
    if (!scheme) throw new ApiError(404, "Scheme not found.");
    assertSettlementAllowsCorrection(scheme);

    await Scheme.findByIdAndUpdate(
      scheme._id,
      { $inc: { financialVersion: 1 } },
      { session }
    );

    const approvedValue =
      payload.approvedValue != null
        ? validateRequestedValue(correction.correctionType, payload.approvedValue)
        : correction.requestedValue;

    const { entries, latestByPayment } = await loadSchemeLedgerContext(scheme._id, session);
    const latestCorrection = latestByPayment.get(String(payment._id)) || null;
    const currentLedger = getEffectiveLedgerFields(payment, latestCorrection);
    const beforeSnapshot =
      correction.beforeSnapshot || buildEffectiveSnapshot(currentLedger) || buildPaymentSnapshot(payment);
    const nextValues = resolveApprovedValues(beforeSnapshot, correction, approvedValue);
    assertApprovedValuesValid(nextValues);

    if (
      correction.correctionType === CORRECTION_TYPES.REVERSE_PAYMENT ||
      nextValues.status === PAYMENT_STATUS.REVERSED
    ) {
      const proposedEntries = entries.filter(
        (entry) => String(entry.paymentId) !== String(payment._id)
      );
      assertLedgerEntriesValid(scheme, proposedEntries);
    } else {
      assertProposedLedgerEntry(scheme, entries, payment._id, {
        paymentId: payment._id,
        amount: nextValues.amount,
        paymentMethod: nextValues.paymentMethod,
        paymentDate: nextValues.paymentDate,
        transactionReference: nextValues.transactionReference,
        notes: nextValues.notes,
        status: payment.status,
        sourceSnapshot: currentLedger?.sourceSnapshot || buildSourceSnapshot(payment),
        adjustmentCorrectionId: correction._id,
      });
    }

    const appliedSnapshot = await applyApprovedCorrection(
      payment,
      correction,
      beforeSnapshot,
      nextValues,
      session
    );

    const latestApproved = await PaymentCorrection.findOne({
      payment: correction.payment,
      status: CORRECTION_STATUS.APPROVED,
      _id: { $ne: correction._id },
      version: { $exists: true, $gt: 0 },
    })
      .sort({ version: -1 })
      .session(session);
    const version = (latestApproved?.version || 0) + 1;

    await recordEffectiveStateCorrection(
      {
        correction,
        payment,
        before: beforeSnapshot,
        after: appliedSnapshot,
        actor,
        clientRequestId: payload.reviewClientRequestId,
      },
      session
    );

    await PaymentCorrection.updateOne(
      { _id: correction._id },
      {
        $set: {
          appliedSnapshot,
          afterSnapshot: appliedSnapshot,
          version,
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
        beforeSnapshot,
        appliedSnapshot,
        reviewClientRequestId: payload.reviewClientRequestId,
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

    if (response.notifyReverse) {
      const customer = await Customer.findById(payment.customer).session(session);
      if (customer?.user) {
        await enqueueOutboxEvent(
          {
            topic: OUTBOX_TOPICS.PAYMENT_REVERSED,
            dedupeKey: `correction-reverse:${correction._id}`,
            payload: {
              recipient: customer.user,
              type: NOTIFICATION_TYPES.PAYMENT_REVERSED,
              title: "Payment Reversed",
              message: `Your payment of ₹${payment.amount.toLocaleString("en-IN")} (${payment.receiptNumber}) has been reversed after an approved correction.`,
              data: {
                paymentId: payment._id,
                correctionId: correction._id,
                amount: payment.amount,
                receiptNumber: payment.receiptNumber,
              },
            },
          },
          session
        );
      }
    }

    return { replay: false, response };
  });

  const correctionRef = txnResult.replay
    ? txnResult.response.correctionId
    : txnResult.response.correctionId;

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
      { returnDocument: "after", session }
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
