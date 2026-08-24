const ApiError = require("./ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const PAYMENT_PERIODS = {
  BEFORE_START: "before_start",
  FIRST: "first",
  LATER: "later",
  AFTER_MATURITY: "after_maturity",
};

const toInstant = (value) => {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new ApiError(400, "Invalid payment date.");
  }
  return instant;
};

const deriveSchemeWindow = (scheme) => ({
  startDate: toInstant(scheme.startDate),
  laterPeriodStart: toInstant(scheme.sixMonthDate),
  maturityDate: toInstant(scheme.maturityDate),
});

const classifyEffectivePayment = (scheme, effectivePaymentAt) => {
  const at = toInstant(effectivePaymentAt);
  const { startDate, laterPeriodStart, maturityDate } = deriveSchemeWindow(scheme);
  const atMs = at.getTime();

  if (atMs < startDate.getTime()) {
    return PAYMENT_PERIODS.BEFORE_START;
  }
  if (atMs < laterPeriodStart.getTime()) {
    return PAYMENT_PERIODS.FIRST;
  }
  if (atMs < maturityDate.getTime()) {
    return PAYMENT_PERIODS.LATER;
  }
  return PAYMENT_PERIODS.AFTER_MATURITY;
};

const isInFirstPeriod = (scheme, effectivePaymentAt) =>
  classifyEffectivePayment(scheme, effectivePaymentAt) === PAYMENT_PERIODS.FIRST;

const isInLaterPeriod = (scheme, effectivePaymentAt) =>
  classifyEffectivePayment(scheme, effectivePaymentAt) === PAYMENT_PERIODS.LATER;

const computeRemainingLaterCapacity = (firstPeriodPaid, laterPeriodPaid) =>
  Math.max((firstPeriodPaid || 0) - (laterPeriodPaid || 0), 0);

const buildPeriodPaymentMatch = (scheme, period) => {
  const { startDate, laterPeriodStart, maturityDate } = deriveSchemeWindow(scheme);

  if (period === PAYMENT_PERIODS.FIRST) {
    return {
      paymentDate: {
        $gte: startDate,
        $lt: laterPeriodStart,
      },
    };
  }

  if (period === PAYMENT_PERIODS.LATER) {
    return {
      paymentDate: {
        $gte: laterPeriodStart,
        $lt: maturityDate,
      },
    };
  }

  throw new ApiError(500, `Unsupported payment period: ${period}`);
};

const assertCollectPaymentAllowed = (scheme, effectivePaymentAt) => {
  const period = classifyEffectivePayment(scheme, effectivePaymentAt);

  if (period === PAYMENT_PERIODS.BEFORE_START) {
    throw new ApiError(409, "Payment cannot be collected before the scheme start date.", [], {
      code: ERROR_CODES.PAYMENT_BEFORE_SCHEME_START,
      retryable: false,
    });
  }

  if (period === PAYMENT_PERIODS.AFTER_MATURITY) {
    throw new ApiError(409, "Payment cannot be collected on or after scheme maturity.", [], {
      code: ERROR_CODES.PAYMENT_AFTER_MATURITY,
      retryable: false,
    });
  }
};

const assertCallerPaymentDateNotAllowed = (payload) => {
  if (payload.paymentDate !== undefined && payload.paymentDate !== null && payload.paymentDate !== "") {
    throw new ApiError(409, "Caller-supplied paymentDate is not allowed on payment collection.", [], {
      code: ERROR_CODES.PAYMENT_DATE_NOT_ALLOWED,
      retryable: false,
    });
  }
};

const willProposedLaterPaymentExceedCap = (firstPeriodPaid, laterPeriodPaid, amount) => {
  if ((firstPeriodPaid || 0) <= 0) {
    return true;
  }
  return (laterPeriodPaid || 0) + amount > firstPeriodPaid;
};

module.exports = {
  PAYMENT_PERIODS,
  deriveSchemeWindow,
  classifyEffectivePayment,
  isInFirstPeriod,
  isInLaterPeriod,
  computeRemainingLaterCapacity,
  buildPeriodPaymentMatch,
  assertCollectPaymentAllowed,
  assertCallerPaymentDateNotAllowed,
  willProposedLaterPaymentExceedCap,
};
