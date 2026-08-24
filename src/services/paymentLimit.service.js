const Payment = require("../models/payment.model");
const PaymentCorrection = require("../models/paymentCorrection.model");
const Scheme = require("../models/scheme.model");
const { PAYMENT_STATUS, CORRECTION_STATUS } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const {
  PAYMENT_PERIODS,
  classifyEffectivePayment,
  computeRemainingLaterCapacity,
  willProposedLaterPaymentExceedCap,
} = require("../utils/schemeWindow");
const {
  loadSchemeLedgerContext,
  getLatestApprovedCorrectionsByPayment,
  getEffectiveLedgerFields,
} = require("../utils/paymentLedger");
const { getLedgerPeriodTotals } = require("../utils/ledgerValidation");

const successMatch = { status: PAYMENT_STATUS.SUCCESS };

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

const getSchemeLedgerTotals = async (schemeId, session = null) => {
  const scheme = await getSchemeOrThrow(schemeId, session);
  const { entries } = await loadSchemeLedgerContext(schemeId, session);
  const { firstPeriodPaid, laterPeriodPaid } = getLedgerPeriodTotals(scheme, entries);

  return {
    scheme,
    entries,
    firstPeriodPaid,
    laterPeriodPaid,
    totalPaid: entries.reduce((sum, entry) => sum + entry.amount, 0),
    remainingAllowedPayment: computeRemainingLaterCapacity(firstPeriodPaid, laterPeriodPaid),
  };
};

const getTotalPaidForScheme = async (schemeId, session = null) => {
  const totals = await getSchemeLedgerTotals(schemeId, session);
  return totals.totalPaid;
};

const getFirstSixMonthsPaid = async (schemeId, _sixMonthDate, session = null) => {
  const totals = await getSchemeLedgerTotals(schemeId, session);
  return totals.firstPeriodPaid;
};

const getAfterSixMonthsPaid = async (schemeId, _sixMonthDate, session = null) => {
  const totals = await getSchemeLedgerTotals(schemeId, session);
  return totals.laterPeriodPaid;
};

const getSchemeLimitSummary = async (schemeId, session = null) => {
  const totals = await getSchemeLedgerTotals(schemeId, session);

  return {
    schemeId,
    enrollmentNumber: totals.scheme.enrollmentNumber,
    sixMonthDate: totals.scheme.sixMonthDate,
    firstSixMonthsPaid: totals.firstPeriodPaid,
    afterSixMonthsPaid: totals.laterPeriodPaid,
    totalPaid: totals.totalPaid,
    remainingAllowedPayment: totals.remainingAllowedPayment,
  };
};

const buildSchemeLimitSummary = (scheme, entries) => {
  const { firstPeriodPaid, laterPeriodPaid } = getLedgerPeriodTotals(scheme, entries);
  return {
    schemeId: scheme._id,
    enrollmentNumber: scheme.enrollmentNumber,
    sixMonthDate: scheme.sixMonthDate,
    firstSixMonthsPaid: firstPeriodPaid,
    afterSixMonthsPaid: laterPeriodPaid,
    totalPaid: entries.reduce((sum, entry) => sum + entry.amount, 0),
    remainingAllowedPayment: computeRemainingLaterCapacity(firstPeriodPaid, laterPeriodPaid),
  };
};

const getSchemeLimitSummariesBatch = async (schemeIds, session = null) => {
  const uniqueIds = [...new Set(schemeIds.map((id) => String(id)))];
  if (!uniqueIds.length) {
    return new Map();
  }

  const [schemes, payments, corrections] = await Promise.all([
    Scheme.find({ _id: { $in: uniqueIds } })
      .session(session || null)
      .lean(),
    Payment.find({ scheme: { $in: uniqueIds } })
      .session(session || null)
      .lean(),
    PaymentCorrection.find({
      scheme: { $in: uniqueIds },
      status: CORRECTION_STATUS.APPROVED,
    })
      .session(session || null)
      .lean(),
  ]);

  const schemeMap = new Map(schemes.map((scheme) => [String(scheme._id), scheme]));
  const paymentsByScheme = new Map();
  const correctionsByScheme = new Map();

  for (const payment of payments) {
    const key = String(payment.scheme);
    if (!paymentsByScheme.has(key)) {
      paymentsByScheme.set(key, []);
    }
    paymentsByScheme.get(key).push(payment);
  }

  for (const correction of corrections) {
    const key = String(correction.scheme);
    if (!correctionsByScheme.has(key)) {
      correctionsByScheme.set(key, []);
    }
    correctionsByScheme.get(key).push(correction);
  }

  const summaries = new Map();
  for (const schemeId of uniqueIds) {
    const scheme = schemeMap.get(schemeId);
    if (!scheme) {
      continue;
    }

    const schemePayments = paymentsByScheme.get(schemeId) || [];
    const latestByPayment = getLatestApprovedCorrectionsByPayment(
      correctionsByScheme.get(schemeId) || []
    );
    const entries = [];

    for (const payment of schemePayments) {
      const ledger = getEffectiveLedgerFields(
        payment,
        latestByPayment.get(String(payment._id)) || null
      );
      if (ledger && ledger.status !== PAYMENT_STATUS.REVERSED) {
        entries.push(ledger);
      }
    }

    summaries.set(schemeId, buildSchemeLimitSummary(scheme, entries));
  }

  return summaries;
};

const willNewPaymentExceedLimit = async (schemeId, amount, paymentDate = new Date(), session = null) => {
  const scheme = await getSchemeOrThrow(schemeId, session);
  const paymentAt = paymentDate instanceof Date ? paymentDate : new Date(paymentDate);
  const period = classifyEffectivePayment(scheme, paymentAt);

  if (period === PAYMENT_PERIODS.FIRST) {
    return {
      exceedsLimit: false,
      reason: "Within first six months — after-six-month cap does not apply.",
      ...(await getSchemeLimitSummary(schemeId, session)),
    };
  }

  const summary = await getSchemeLimitSummary(schemeId, session);
  const exceedsLimit = willProposedLaterPaymentExceedCap(
    summary.firstSixMonthsPaid,
    summary.afterSixMonthsPaid,
    amount
  );

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
  getSchemeLimitSummariesBatch,
  willNewPaymentExceedLimit,
  getSchemeLedgerTotals,
};
