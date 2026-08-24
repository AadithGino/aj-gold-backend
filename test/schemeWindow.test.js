const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { calculateSchemeDates } = require("../src/services/scheme.service");
const {
  PAYMENT_PERIODS,
  deriveSchemeWindow,
  classifyEffectivePayment,
  isInFirstPeriod,
  isInLaterPeriod,
  buildPeriodPaymentMatch,
  computeRemainingLaterCapacity,
  willProposedLaterPaymentExceedCap,
} = require("../src/utils/schemeWindow");

const schemeFromStart = (startDate = "2025-01-01") => {
  const dates = calculateSchemeDates(startDate);
  return {
    startDate: dates.startDate,
    sixMonthDate: dates.sixMonthDate,
    maturityDate: dates.maturityDate,
  };
};

describe("scheme window policy", () => {
  it("classifies half-open boundaries for Asia/Kolkata scheme start", () => {
    const scheme = schemeFromStart("2025-01-01");
    const { startDate, laterPeriodStart, maturityDate } = deriveSchemeWindow(scheme);

    assert.equal(classifyEffectivePayment(scheme, startDate), PAYMENT_PERIODS.FIRST);
    assert.equal(
      classifyEffectivePayment(scheme, new Date(startDate.getTime() - 1)),
      PAYMENT_PERIODS.BEFORE_START
    );
    assert.equal(
      classifyEffectivePayment(scheme, new Date(laterPeriodStart.getTime() - 1)),
      PAYMENT_PERIODS.FIRST
    );
    assert.equal(classifyEffectivePayment(scheme, laterPeriodStart), PAYMENT_PERIODS.LATER);
    assert.equal(
      classifyEffectivePayment(scheme, new Date(laterPeriodStart.getTime() + 60 * 60 * 1000)),
      PAYMENT_PERIODS.LATER
    );
    assert.equal(
      classifyEffectivePayment(scheme, new Date(maturityDate.getTime() - 1)),
      PAYMENT_PERIODS.LATER
    );
    assert.equal(classifyEffectivePayment(scheme, maturityDate), PAYMENT_PERIODS.AFTER_MATURITY);
    assert.equal(isInFirstPeriod(scheme, startDate), true);
    assert.equal(isInLaterPeriod(scheme, laterPeriodStart), true);
  });

  it("builds identical aggregation windows for first and later periods", () => {
    const scheme = schemeFromStart("2025-01-01");
    const { startDate, laterPeriodStart, maturityDate } = deriveSchemeWindow(scheme);

    assert.deepEqual(buildPeriodPaymentMatch(scheme, PAYMENT_PERIODS.FIRST), {
      paymentDate: { $gte: startDate, $lt: laterPeriodStart },
    });
    assert.deepEqual(buildPeriodPaymentMatch(scheme, PAYMENT_PERIODS.LATER), {
      paymentDate: { $gte: laterPeriodStart, $lt: maturityDate },
    });
  });

  it("computes later-period capacity from combined totals", () => {
    assert.equal(computeRemainingLaterCapacity(30000, 10000), 20000);
    assert.equal(computeRemainingLaterCapacity(0, 0), 0);
    assert.equal(willProposedLaterPaymentExceedCap(30000, 20000, 10000), false);
    assert.equal(willProposedLaterPaymentExceedCap(30000, 20000, 10001), true);
    assert.equal(willProposedLaterPaymentExceedCap(0, 0, 1), true);
  });

  it("treats IST midnight boundary relative to UTC", () => {
    const scheme = schemeFromStart("2025-01-01");
    const { startDate } = deriveSchemeWindow(scheme);
    assert.equal(startDate.toISOString(), "2024-12-31T18:30:00.000Z");
    assert.equal(
      classifyEffectivePayment(scheme, new Date("2024-12-31T18:29:59.999Z")),
      PAYMENT_PERIODS.BEFORE_START
    );
    assert.equal(
      classifyEffectivePayment(scheme, new Date("2024-12-31T18:30:00.000Z")),
      PAYMENT_PERIODS.FIRST
    );
  });
});
