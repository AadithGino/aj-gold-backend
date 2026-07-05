const Payment = require("../models/payment.model");
const CashSubmission = require("../models/cashSubmission.model");
const User = require("../models/user.model");
const mongoose = require("mongoose");
const { PAYMENT_METHODS, PAYMENT_STATUS, USER_ROLES, AUDIT_ACTIONS } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { logAudit } = require("./audit.service");
const { parseDateRange } = require("../utils/date");

/** Mongo aggregate $match does not cast strings to ObjectId — normalize staff/user ids. */
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

const getStaffCashInHand = async (staffId) => {
  const [cashCollected, cashSubmitted] = await Promise.all([
    getStaffCashCollected(staffId),
    getStaffCashSubmitted(staffId),
  ]);

  return {
    staffId,
    cashCollected,
    cashSubmitted,
    cashInHand: cashCollected - cashSubmitted,
  };
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

const getReceiptDisplayData = async (paymentId) => {
  const payment = await Payment.findById(paymentId)
    .populate("customer", "name passbookNumber")
    .populate("scheme", "enrollmentNumber status")
    .populate("collectedBy", "name");

  if (!payment) {
    return null;
  }

  const totalPaidTillNow = await Payment.aggregate([
    {
      $match: {
        scheme: payment.scheme._id,
        status: PAYMENT_STATUS.SUCCESS,
        paymentDate: { $lte: payment.paymentDate },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return {
    customerName: payment.customer.name,
    passbookNumber: payment.customer.passbookNumber,
    enrollmentNumber: payment.scheme.enrollmentNumber,
    receiptNumber: payment.receiptNumber,
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    collectedBy: payment.collectedBy.name,
    paymentDate: payment.paymentDate,
    totalPaidTillNow: totalPaidTillNow[0]?.total || payment.amount,
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

const getStaffPaymentHistory = async (staffId, { from, to, limit = 50 } = {}) => {
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

const createCashSubmission = async (
  { staff, submittedAmount, submissionDate, receivedBy, notes },
  actor
) => {
  if (!submittedAmount || submittedAmount <= 0) {
    throw new ApiError(400, "Submitted amount must be greater than zero.");
  }

  const staffUser = await User.findById(staff);
  if (!staffUser || staffUser.role !== USER_ROLES.STAFF) {
    throw new ApiError(404, "Staff member not found.");
  }

  const submission = await CashSubmission.create({
    staff,
    submittedAmount,
    submissionDate: submissionDate || new Date(),
    receivedBy: receivedBy.trim(),
    notes: notes?.trim() || "",
    createdBy: actor._id,
  });

  const cashSummary = await getStaffCashInHand(staff);

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CASH_SUBMITTED,
    targetType: "CashSubmission",
    targetId: submission._id,
    newValue: {
      staff,
      submittedAmount,
      submissionDate: submission.submissionDate,
      receivedBy: submission.receivedBy,
    },
    notes: notes || "Cash submission recorded",
  });

  return { submission, cashSummary };
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
  getStaffCashInHand,
  getPaymentMethodBreakdown,
  getReceiptDisplayData,
  getStaffCollectionTotal,
  getStaffPaymentHistory,
  getStaffCashSubmissionHistory,
  createCashSubmission,
  listCashSubmissions,
};
