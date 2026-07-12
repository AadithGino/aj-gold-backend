const Payment = require("../models/payment.model");
const Scheme = require("../models/scheme.model");
const { PAYMENT_STATUS } = require("../constants/enums");
const { isSameOrBefore } = require("../utils/date");
const ApiError = require("../utils/ApiError");

const successMatch = { status: PAYMENT_STATUS.SUCCESS };

const aggregateWithSession = (pipeline, session) => {
  let query = Payment.aggregate(pipeline);
  if (session) query = query.session(session);
  return query;
};

const getSchemeOrThrow = async (schemeId, session = null) => {
  const scheme = await Scheme.findById(schemeId).session(session || null);
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }
  return scheme;
};

const getPaymentsForScheme = async (schemeId, extraFilter = {}, session = null) => {
  return Payment.find({ scheme: schemeId, ...successMatch, ...extraFilter }).session(session || null);
};

const getTotalPaidForScheme = async (schemeId, session = null) => {
  const result = await aggregateWithSession(
    [
      { $match: { scheme: schemeId, status: PAYMENT_STATUS.SUCCESS } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ],
    session
  );

  return result[0]?.total || 0;
};

const getFirstSixMonthsPaid = async (schemeId, sixMonthDate, session = null) => {
  const result = await aggregateWithSession(
    [
      {
        $match: {
          scheme: schemeId,
          status: PAYMENT_STATUS.SUCCESS,
          paymentDate: { $lte: sixMonthDate },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ],
    session
  );

  return result[0]?.total || 0;
};

const getAfterSixMonthsPaid = async (schemeId, sixMonthDate, session = null) => {
  const result = await aggregateWithSession(
    [
      {
        $match: {
          scheme: schemeId,
          status: PAYMENT_STATUS.SUCCESS,
          paymentDate: { $gt: sixMonthDate },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ],
    session
  );

  return result[0]?.total || 0;
};

const getSchemeLimitSummary = async (schemeId, session = null) => {
  const scheme = await getSchemeOrThrow(schemeId, session);

  const firstSixMonthsPaid = await getFirstSixMonthsPaid(schemeId, scheme.sixMonthDate, session);
  const afterSixMonthsPaid = await getAfterSixMonthsPaid(schemeId, scheme.sixMonthDate, session);
  const totalPaid = await getTotalPaidForScheme(schemeId, session);
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

const willNewPaymentExceedLimit = async (schemeId, amount, paymentDate = new Date(), session = null) => {
  const scheme = await getSchemeOrThrow(schemeId, session);
  const paymentAt = paymentDate instanceof Date ? paymentDate : new Date(paymentDate);

  if (isSameOrBefore(paymentAt, scheme.sixMonthDate)) {
    return {
      exceedsLimit: false,
      reason: "Within first six months — after-six-month cap does not apply.",
      ...(await getSchemeLimitSummary(schemeId, session)),
    };
  }

  const summary = await getSchemeLimitSummary(schemeId, session);
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
