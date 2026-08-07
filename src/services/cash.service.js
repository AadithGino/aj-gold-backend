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
const {
  getStaffCashInHand,
  lockStaffCashProfile,
  assertStaffCashInHandSufficient,
  assertStaffUser,
} = require("./staffCash.service");

const toObjectId = (id, label = "id") => {
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return new mongoose.Types.ObjectId(id);
};

const getStaffCashCollected = async (staffId) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const result = await Payment.aggregate([
    {
      $match: {
        collectedBy: staffObjectId,
        paymentMethod: PAYMENT_METHODS.CASH,
        status: PAYMENT_STATUS.SUCCESS,
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result[0]?.total || 0;
};

const getStaffCashSubmitted = async (staffId) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const result = await CashSubmission.aggregate([
    { $match: { staff: staffObjectId } },
    { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
  ]);

  return result[0]?.total || 0;
};

const getAdminCashCollected = async () => {
  const result = await Payment.aggregate([
    {
      $match: {
        collectedByRole: USER_ROLES.ADMIN,
        paymentMethod: PAYMENT_METHODS.CASH,
        status: PAYMENT_STATUS.SUCCESS,
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result[0]?.total || 0;
};

const getPaymentMethodBreakdown = async (filter = {}) => {
  const match = { status: PAYMENT_STATUS.SUCCESS, ...filter };
  if (match.collectedBy) {
    match.collectedBy = toObjectId(match.collectedBy, "staff id");
  }

  const breakdown = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$paymentMethod",
        total: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return breakdown.map((row) => ({
    paymentMethod: row._id,
    total: row.total,
    count: row.count,
  }));
};

const getTotalPaidTillNow = async (payment, session = null) => {
  const schemeId = payment.scheme._id || payment.scheme;
  const payments = await Payment.find({
    scheme: schemeId,
    status: PAYMENT_STATUS.SUCCESS,
  })
    .select("amount paymentDate createdAt _id")
    .sort({ paymentDate: 1, createdAt: 1, _id: 1 })
    .session(session || null)
    .lean();

  const currentId = String(payment._id);
  let total = 0;
  for (const row of payments) {
    total += row.amount;
    if (String(row._id) === currentId) {
      break;
    }
  }
  return total;
};

const getReceiptDisplayData = async (paymentId, session = null) => {
  const payment = await Payment.findById(paymentId)
    .populate("customer", "name passbookNumber")
    .populate("scheme", "enrollmentNumber status")
    .populate("collectedBy", "name")
    .session(session || null);

  if (!payment) {
    return null;
  }

  const totalPaidTillNow = await getTotalPaidTillNow(payment, session);

  return {
    customerName: payment.customer.name,
    passbookNumber: payment.customer.passbookNumber,
    enrollmentNumber: payment.scheme.enrollmentNumber,
    receiptNumber: payment.receiptNumber,
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    collectedBy: payment.collectedBy.name,
    paymentDate: payment.paymentDate,
    totalPaidTillNow,
    schemeStatus: payment.scheme.status,
  };
};

const getStaffCollectionTotal = async (staffId, from, to) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const match = {
    collectedBy: staffObjectId,
    status: PAYMENT_STATUS.SUCCESS,
  };

  if (from || to) {
    match.paymentDate = {};
    if (from) {
      match.paymentDate.$gte = from;
    }
    if (to) {
      match.paymentDate.$lte = to;
    }
  }

  const result = await Payment.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result[0]?.total || 0;
};

const getStaffPaymentHistory = async (staffId, { from, to, limit = 50, paymentMethod } = {}) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const query = {
    collectedBy: staffObjectId,
    status: PAYMENT_STATUS.SUCCESS,
  };

  if (from || to) {
    query.paymentDate = {};
    if (from) {
      query.paymentDate.$gte = from;
    }
    if (to) {
      query.paymentDate.$lte = to;
    }
  }
  if (paymentMethod) {
    query.paymentMethod = paymentMethod;
  }

  return Payment.find(query)
    .populate("customer", "name passbookNumber")
    .populate("scheme", "enrollmentNumber status")
    .sort({ paymentDate: -1 })
    .limit(limit)
    .select("-__v");
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

  const idempotencyPayload = {
    staff: payload.staff,
    submittedAmount,
    submissionDate: submissionDate.toISOString(),
    notes: payload.notes?.trim() || "",
  };

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
          notes: payload.notes?.trim() || "",
          createdBy: actor._id,
        },
      ],
      { session }
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
  listCashSubmissions,
};
