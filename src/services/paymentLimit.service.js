const Payment = require("../models/payment.model");
const Scheme = require("../models/scheme.model");
const { PAYMENT_STATUS } = require("../constants/enums");
const { isSameOrBefore } = require("../utils/date");
const ApiError = require("../utils/ApiError");

const successMatch = { status: PAYMENT_STATUS.SUCCESS };

const getSchemeOrThrow = async (schemeId) => {
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }
  return scheme;
};

const getPaymentsForScheme = async (schemeId, extraFilter = {}) => {
  return Payment.find({ scheme: schemeId, ...successMatch, ...extraFilter });
};

const getTotalPaidForScheme = async (schemeId) => {
  const result = await Payment.aggregate([
    { $match: { scheme: schemeId, status: PAYMENT_STATUS.SUCCESS } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result[0]?.total || 0;
};

const getFirstSixMonthsPaid = async (schemeId, sixMonthDate) => {
  const result = await Payment.aggregate([
    {
      $match: {
        scheme: schemeId,
        status: PAYMENT_STATUS.SUCCESS,
        paymentDate: { $lte: sixMonthDate },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result[0]?.total || 0;
};

const getAfterSixMonthsPaid = async (schemeId, sixMonthDate) => {
  const result = await Payment.aggregate([
    {
      $match: {
        scheme: schemeId,
        status: PAYMENT_STATUS.SUCCESS,
        paymentDate: { $gt: sixMonthDate },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result[0]?.total || 0;
};

const getSchemeLimitSummary = async (schemeId) => {
  const scheme = await getSchemeOrThrow(schemeId);

  const firstSixMonthsPaid = await getFirstSixMonthsPaid(schemeId, scheme.sixMonthDate);
  const afterSixMonthsPaid = await getAfterSixMonthsPaid(schemeId, scheme.sixMonthDate);
  const totalPaid = await getTotalPaidForScheme(schemeId);
  const remainingAllowedPayment = Math.max(firstSixMonthsPaid - afterSixMonthsPaid, 0);

  return {
    schemeId,
    enrollmentNumber: scheme.enrollmentNumber,
    sixMonthDate: scheme.sixMonthDate,
    firstSixMonthsPaid,
    afterSixMonthsPaid,
    totalPaid,
    remainingAllowedPayment,
  };
};

const willNewPaymentExceedLimit = async (schemeId, amount, paymentDate = new Date()) => {
  const scheme = await getSchemeOrThrow(schemeId);
  const paymentAt = paymentDate instanceof Date ? paymentDate : new Date(paymentDate);

  if (isSameOrBefore(paymentAt, scheme.sixMonthDate)) {
    return {
      exceedsLimit: false,
      reason: "Within first six months — after-six-month cap does not apply.",
      ...await getSchemeLimitSummary(schemeId),
    };
  }

  const summary = await getSchemeLimitSummary(schemeId);
  const exceedsLimit = amount > summary.remainingAllowedPayment;

  return {
    exceedsLimit,
    reason: exceedsLimit
      ? "Payment exceeds remaining allowed amount for the post-six-month period."
      : "Payment is within remaining allowed amount.",
    proposedAmount: amount,
    ...summary,
  };
};

module.exports = {
  getSchemeOrThrow,
  getPaymentsForScheme,
  getTotalPaidForScheme,
  getFirstSixMonthsPaid,
  getAfterSixMonthsPaid,
  getSchemeLimitSummary,
  willNewPaymentExceedLimit,
};
