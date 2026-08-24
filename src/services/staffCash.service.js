const mongoose = require("mongoose");
const Payment = require("../models/payment.model");
const PaymentCorrection = require("../models/paymentCorrection.model");
const CashSubmission = require("../models/cashSubmission.model");
const StaffProfile = require("../models/staffProfile.model");
const {
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  USER_ROLES,
  CORRECTION_STATUS,
  CASH_SUBMISSION_STATUS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const {
  getLatestApprovedCorrectionsByPayment,
  getEffectiveLedgerFields,
} = require("../utils/paymentLedger");
const { getStaffCustodyBalance } = require("./financialJournal.service");

const toObjectId = (id, label = "id") => {
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return new mongoose.Types.ObjectId(id);
};

const getStaffEffectiveCashCollected = async (staffId, session = null) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const payments = await Payment.find({
    collectedBy: staffObjectId,
    collectedByRole: USER_ROLES.STAFF,
  })
    .session(session || null)
    .lean();

  if (!payments.length) return 0;

  const paymentIds = payments.map((payment) => payment._id);
  const corrections = await PaymentCorrection.find({
    payment: { $in: paymentIds },
    status: CORRECTION_STATUS.APPROVED,
  })
    .session(session || null)
    .lean();

  const latestByPayment = getLatestApprovedCorrectionsByPayment(corrections);
  let total = 0;

  for (const payment of payments) {
    const ledger = getEffectiveLedgerFields(
      payment,
      latestByPayment.get(String(payment._id)) || null
    );
    if (ledger && ledger.paymentMethod === PAYMENT_METHODS.CASH && ledger.status !== PAYMENT_STATUS.REVERSED) {
      total += ledger.amount;
    }
  }

  return total;
};

const getStaffCashCollected = async (staffId, session = null) =>
  getStaffEffectiveCashCollected(staffId, session);

const getStaffActiveCashSubmitted = async (staffId, session = null) => {
  const staffObjectId = toObjectId(staffId, "staff id");
  const rows = await CashSubmission.aggregate([
    {
      $match: {
        staff: staffObjectId,
        status: CASH_SUBMISSION_STATUS.ACTIVE,
      },
    },
    { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
  ]).session(session || null);

  return rows[0]?.total || 0;
};

const getStaffCashSubmitted = async (staffId, session = null) =>
  getStaffActiveCashSubmitted(staffId, session);

const getStaffCashInHand = async (staffId, session = null) => {
  const [cashCollected, cashSubmitted, journalCustodyBalance] = await Promise.all([
    getStaffEffectiveCashCollected(staffId, session),
    getStaffActiveCashSubmitted(staffId, session),
    getStaffCustodyBalance(staffId, session),
  ]);

  return {
    staffId,
    cashCollected,
    cashSubmitted,
    cashInHand: journalCustodyBalance,
    aggregateCashInHand: cashCollected - cashSubmitted,
    journalCustodyBalance,
  };
};

const lockStaffCashProfile = async (staffUserId, session) => {
  const profile = await StaffProfile.findOneAndUpdate(
    { user: staffUserId },
    { $inc: { cashVersion: 1 } },
    { new: true, session }
  );
  if (!profile) {
    throw new ApiError(404, "Staff profile not found.");
  }
  return profile;
};

const assertStaffCashInHandSufficient = async (staffId, requiredAmount, session = null) => {
  const summary = await getStaffCashInHand(staffId, session);
  if (requiredAmount > summary.cashInHand) {
    throw new ApiError(
      409,
      `Insufficient cash in hand. Available ${summary.cashInHand}, requested ${requiredAmount}.`,
      [],
      { code: ERROR_CODES.INSUFFICIENT_STAFF_CASH, retryable: false }
    );
  }
  if (summary.cashInHand < 0) {
    throw new ApiError(409, "Staff cash in hand cannot be negative.", [], {
      code: ERROR_CODES.CASH_BALANCE_CONFLICT,
      retryable: false,
    });
  }
  return summary;
};

const assertStaffUser = async (staffUserId, session = null) => {
  const User = require("../models/user.model");
  const user = await User.findById(staffUserId).session(session || null);
  if (!user || user.role !== USER_ROLES.STAFF) {
    throw new ApiError(404, "Staff member not found.");
  }
  return user;
};

const assertNoNegativeCashAfterPaymentChange = async ({
  staffId,
  previousAmount,
  previousMethod,
  nextAmount,
  nextMethod,
  session = null,
}) => {
  if (!staffId) return;

  const summary = await getStaffCashInHand(staffId, session);
  let adjusted = summary.cashInHand;

  if (previousMethod === PAYMENT_METHODS.CASH) {
    adjusted -= previousAmount;
  }
  if (nextMethod === PAYMENT_METHODS.CASH) {
    adjusted += nextAmount;
  }

  if (adjusted < 0) {
    throw new ApiError(
      409,
      "This change would make staff cash in hand negative. Resolve cash submissions first.",
      [],
      {
        code: ERROR_CODES.CASH_BALANCE_CONFLICT,
        retryable: false,
      }
    );
  }
};

module.exports = {
  getStaffEffectiveCashCollected,
  getStaffCashCollected,
  getStaffActiveCashSubmitted,
  getStaffCashSubmitted,
  getStaffCashInHand,
  lockStaffCashProfile,
  assertStaffCashInHandSufficient,
  assertStaffUser,
  assertNoNegativeCashAfterPaymentChange,
};
