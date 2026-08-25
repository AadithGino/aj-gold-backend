const Payment = require("../models/payment.model");
const CashSubmission = require("../models/cashSubmission.model");
const User = require("../models/user.model");
const mongoose = require("mongoose");
const {
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  USER_ROLES,
  AUDIT_ACTIONS,
  IDEMPOTENCY_OPERATIONS,
  CASH_SUBMISSION_STATUS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const { parsePositiveRupeeInteger } = require("../utils/money");
const { withTransaction } = require("../utils/transaction");
const { logAudit } = require("./audit.service");
const { parseDateRange } = require("../utils/date");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");
const { buildCashSubmissionIntent } = require("../utils/idempotencyPayload");
const { recordStaffCashSubmitted, recordCashSubmissionReversal } = require("../utils/journalRecording");
const { NOTIFICATION_TYPES } = require("../models/notification.model");
const { enqueueOutboxEvent } = require("./outbox.service");
const { OUTBOX_TOPICS } = require("../models/outboxEvent.model");
const {
  getStaffCashInHand,
  lockStaffCashProfile,
  assertStaffCashInHandSufficient,
  assertStaffUser,
} = require("./staffCash.service");
const {
  aggregateEffectiveBreakdown,
  aggregateEffectiveTotal,
  getEffectiveTotalPaidTillNow,
  getEffectiveReceiptFields,
  enrichPaymentsWithEffectiveView,
  applyEffectivePaymentRow,
} = require("../utils/effectiveReadModel");
const { getLatestApprovedCorrection } = require("../utils/effectivePayment");

const toObjectId = (id, label = "id") => {
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return new mongoose.Types.ObjectId(id);
};

const getStaffCashCollected = async (staffId) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  return aggregateEffectiveTotal(
    { collectedBy: staffObjectId },
    { paymentMethod: PAYMENT_METHODS.CASH }
  );
};

const getStaffCashSubmitted = async (staffId) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const result = await CashSubmission.aggregate([
    { $match: { staff: staffObjectId, status: CASH_SUBMISSION_STATUS.ACTIVE } },
    { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
  ]);

  return result[0]?.total || 0;
};

const getAdminCashCollected = async () =>
  aggregateEffectiveTotal(
    { collectedByRole: USER_ROLES.ADMIN },
    { paymentMethod: PAYMENT_METHODS.CASH }
  );

const getPaymentMethodBreakdown = async (filter = {}) => {
  const match = { ...filter };
  const effectiveFilters = {};

  if (match.collectedBy) {
    match.collectedBy = toObjectId(match.collectedBy, "staff id");
  }
  if (match.paymentMethod) {
    effectiveFilters.paymentMethod = match.paymentMethod;
    delete match.paymentMethod;
  }
  if (match.paymentDate) {
    effectiveFilters.paymentDate = match.paymentDate;
    delete match.paymentDate;
  }
  delete match.status;

  return aggregateEffectiveBreakdown(match, effectiveFilters);
};

const getTotalPaidTillNow = async (payment, session = null) =>
  getEffectiveTotalPaidTillNow(payment, session);

const getReceiptDisplayData = async (paymentId, session = null) => {
  const payment = await Payment.findById(paymentId)
    .populate("customer", "name passbookNumber")
    .populate("scheme", "enrollmentNumber status")
    .populate("collectedBy", "name")
    .session(session || null);

  if (!payment) {
    return null;
  }

  const latestCorrection = await getLatestApprovedCorrection(payment._id, session);
  const effectiveFields = getEffectiveReceiptFields(payment, latestCorrection);
  const totalPaidTillNow = await getTotalPaidTillNow(payment, session);

  return {
    customerName: payment.customer.name,
    passbookNumber: payment.customer.passbookNumber,
    enrollmentNumber: payment.scheme.enrollmentNumber,
    receiptNumber: payment.receiptNumber,
    amount: effectiveFields?.amount ?? payment.amount,
    paymentMethod: effectiveFields?.paymentMethod ?? payment.paymentMethod,
    collectedBy: payment.collectedBy.name,
    paymentDate: effectiveFields?.paymentDate ?? payment.paymentDate,
    totalPaidTillNow,
    schemeStatus: payment.scheme.status,
    sourceAmount: payment.amount,
    sourcePaymentMethod: payment.paymentMethod,
  };
};

const getStaffCollectionTotal = async (staffId, from, to) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const filters = {};
  if (from || to) {
    filters.paymentDate = {};
    if (from) {
      filters.paymentDate.$gte = from;
    }
    if (to) {
      filters.paymentDate.$lte = to;
    }
  }

  return aggregateEffectiveTotal({ collectedBy: staffObjectId }, filters);
};

const getStaffPaymentHistory = async (staffId, { from, to, limit = 50, paymentMethod } = {}) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const batchSize = Math.max(safeLimit + 1, safeLimit * 2);
  const items = [];
  let hasMore = true;
  let cursor = null;
  let safety = 0;

  const inRange = (date) => {
    const timestamp = new Date(date).getTime();
    if (Number.isNaN(timestamp)) return false;
    if (from && timestamp < from.getTime()) return false;
    if (to && timestamp > to.getTime()) return false;
    return true;
  };

  while (hasMore && items.length < safeLimit && safety < 30) {
    safety += 1;
    const query = { collectedBy: staffObjectId };
    if (cursor) {
      query.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
      ];
    }

    const rows = await Payment.find(query)
      .populate("customer", "name passbookNumber")
      .populate("scheme", "enrollmentNumber status")
      .sort({ createdAt: -1, _id: -1 })
      .limit(batchSize)
      .select("-__v")
      .lean();

    if (!rows.length) {
      hasMore = false;
      break;
    }

    const enriched = await enrichPaymentsWithEffectiveView(rows);
    for (const { payment, view, latest } of enriched) {
      if (!view.effectiveLedger) {
        continue;
      }
      if (paymentMethod && view.paymentMethod !== paymentMethod) {
        continue;
      }
      if (!inRange(view.paymentDate)) {
        continue;
      }
      const effective = applyEffectivePaymentRow(payment, latest);
      items.push({
        ...payment,
        amount: effective.displayAmount,
        paymentMethod: effective.displayPaymentMethod,
        paymentDate: effective.displayPaymentDate,
        sourceAmount: payment.amount,
        sourcePaymentMethod: payment.paymentMethod,
        effectiveAmount: effective.effectiveAmount,
        effectivePaymentMethod: effective.effectivePaymentMethod,
      });
      if (items.length >= safeLimit) {
        break;
      }
    }

    const tail = rows[rows.length - 1];
    cursor = { createdAt: new Date(tail.createdAt), _id: tail._id };
    hasMore = rows.length === batchSize;
  }

  return items;
};

const getStaffCashSubmissionHistory = async (staffId, { from, to } = {}) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const query = { staff: staffObjectId };

  if (from || to) {
    query.submissionDate = {};
    if (from) {
      query.submissionDate.$gte = from;
    }
    if (to) {
      query.submissionDate.$lte = to;
    }
  }

  return CashSubmission.find(query).sort({ submissionDate: -1 }).select("-__v");
};

const createCashSubmission = async (payload, actor) => {
  const submittedAmount = parsePositiveRupeeInteger(payload.submittedAmount, "submittedAmount");
  const submissionDate = payload.submissionDate ? new Date(payload.submissionDate) : new Date();
  if (Number.isNaN(submissionDate.getTime())) {
    throw new ApiError(400, "Invalid submission date.");
  }

  const idempotencyPayload = buildCashSubmissionIntent(payload, submittedAmount);

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId: payload.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CASH_SUBMISSION,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    await assertStaffUser(payload.staff, session);
    await lockStaffCashProfile(payload.staff, session);
    await assertStaffCashInHandSufficient(payload.staff, submittedAmount, session);

    const [submission] = await CashSubmission.create(
      [
        {
          staff: payload.staff,
          submittedAmount,
          submissionDate,
          receivedBy: actor?.name || "Admin",
          status: CASH_SUBMISSION_STATUS.ACTIVE,
          notes: payload.notes?.trim() || "",
          createdBy: actor._id,
        },
      ],
      { session }
    );

    await recordStaffCashSubmitted(
      {
        submission,
        actor,
        clientRequestId: payload.clientRequestId,
      },
      session
    );

    const cashSummary = await getStaffCashInHand(payload.staff, session);
    if (cashSummary.cashInHand < 0) {
      throw new ApiError(409, "Cash submission would result in negative cash in hand.", [], {
        code: ERROR_CODES.CASH_BALANCE_CONFLICT,
        retryable: false,
      });
    }

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.CASH_SUBMITTED,
      targetType: "CashSubmission",
      targetId: submission._id,
      newValue: {
        staff: payload.staff,
        submittedAmount,
        submissionDate: submission.submissionDate,
        receivedBy: submission.receivedBy,
        clientRequestId: payload.clientRequestId,
      },
      notes: payload.notes?.trim() || "Cash submission recorded",
      session,
    });

    const response = {
      submissionId: submission._id,
      staffId: payload.staff,
      cashSummary,
    };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CASH_SUBMISSION,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "CashSubmission",
      resourceId: submission._id,
      session,
    });

    await enqueueOutboxEvent(
      {
        topic: OUTBOX_TOPICS.CASH_SUBMITTED,
        dedupeKey: `cash-submitted:${submission._id}`,
        payload: {
          recipient: payload.staff,
          type: NOTIFICATION_TYPES.CASH_SUBMITTED,
          title: "Cash Submitted",
          message: `Cash submission of ₹${submission.submittedAmount} recorded.`,
          data: { submissionId: submission._id, submittedAmount: submission.submittedAmount },
        },
      },
      session
    );

    return { replay: false, submission, cashSummary };
  });

  if (txnResult.replay) {
    const submission = await CashSubmission.findById(txnResult.response.submissionId);
    return {
      submission,
      cashSummary: txnResult.response.cashSummary,
    };
  }

  return {
    submission: txnResult.submission,
    cashSummary: txnResult.cashSummary,
  };
};

const listCashSubmissions = async ({ staffId, from, to } = {}) => {
  const customRange = parseDateRange(from, to);
  if (customRange.error) {
    throw new ApiError(400, customRange.error);
  }

  const query = {};

  if (staffId) {
    query.staff = toObjectId(staffId, "staff id");
  }

  if (customRange.from || customRange.to) {
    query.submissionDate = {};
    if (customRange.from) {
      query.submissionDate.$gte = customRange.from;
    }
    if (customRange.to) {
      query.submissionDate.$lte = customRange.to;
    }
  }

  return CashSubmission.find(query)
    .populate("staff", "name phone")
    .sort({ submissionDate: -1 })
    .select("-__v");
};

const reverseCashSubmission = async (submissionId, payload, actor) => {
  if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can reverse cash submissions.");
  }

  const reason = payload.reason?.trim();
  if (!reason) {
    throw new ApiError(400, "Reason is required.");
  }

  const idempotencyPayload = {
    submissionId,
    reason,
    notes: payload.notes?.trim() || "",
  };

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId: payload.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CASH_SUBMISSION_REVERSE,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    const submission = await CashSubmission.findOneAndUpdate(
      { _id: submissionId, status: CASH_SUBMISSION_STATUS.ACTIVE },
      {
        $set: {
          status: CASH_SUBMISSION_STATUS.REVERSED,
          reversedAt: new Date(),
          reversedBy: actor._id,
          reversalReason: reason,
        },
      },
      { returnDocument: "before", session }
    );

    if (!submission) {
      const existing = await CashSubmission.findById(submissionId).session(session);
      if (!existing) {
        throw new ApiError(404, "Cash submission not found.");
      }
      if (existing.status === CASH_SUBMISSION_STATUS.REVERSED) {
        throw new ApiError(409, "Cash submission is already reversed.", [], {
          code: ERROR_CODES.CASH_SUBMISSION_ALREADY_REVERSED,
          retryable: false,
        });
      }
      throw new ApiError(409, "Cash submission cannot be reversed.", [], {
        code: ERROR_CODES.CASH_SUBMISSION_ALREADY_REVERSED,
        retryable: false,
      });
    }

    await lockStaffCashProfile(submission.staff, session);

    await recordCashSubmissionReversal(
      {
        submission,
        actor,
        clientRequestId: payload.clientRequestId,
      },
      session
    );

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.CASH_SUBMISSION_REVERSED,
      targetType: "CashSubmission",
      targetId: submission._id,
      newValue: {
        reversal: true,
        reason,
        submittedAmount: submission.submittedAmount,
        clientRequestId: payload.clientRequestId,
      },
      notes: payload.notes?.trim() || reason,
      session,
    });

    const cashSummary = await getStaffCashInHand(submission.staff, session);
    const response = { submissionId: submission._id, cashSummary };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.CASH_SUBMISSION_REVERSE,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "CashSubmission",
      resourceId: submission._id,
      session,
    });

    return { replay: false, submission, cashSummary };
  });

  if (txnResult.replay) {
    const submission = await CashSubmission.findById(txnResult.response.submissionId);
    return { submission, cashSummary: txnResult.response.cashSummary };
  }

  return {
    submission: txnResult.submission,
    cashSummary: txnResult.cashSummary,
  };
};

module.exports = {
  getStaffCashCollected,
  getStaffCashSubmitted,
  getAdminCashCollected,
  getPaymentMethodBreakdown,
  getReceiptDisplayData,
  getTotalPaidTillNow,
  getStaffCollectionTotal,
  getStaffPaymentHistory,
  getStaffCashSubmissionHistory,
  createCashSubmission,
  reverseCashSubmission,
  listCashSubmissions,
};
