const {
  PAYMENT_PERIODS,
  classifyEffectivePayment,
  assertCollectPaymentAllowed,
  computeRemainingLaterCapacity,
  willProposedLaterPaymentExceedCap,
} = require("./schemeWindow");
const ApiError = require("./ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const sumPeriodTotal = (scheme, entries, period) =>
  entries.reduce((total, entry) => {
    if (classifyEffectivePayment(scheme, entry.paymentDate) !== period) {
      return total;
    }
    return total + entry.amount;
  }, 0);

const getLedgerPeriodTotals = (scheme, entries) => ({
  firstPeriodPaid: sumPeriodTotal(scheme, entries, PAYMENT_PERIODS.FIRST),
  laterPeriodPaid: sumPeriodTotal(scheme, entries, PAYMENT_PERIODS.LATER),
});

const assertLedgerEntriesValid = (scheme, entries, { allowZeroFirstPeriodLater = false } = {}) => {
  for (const entry of entries) {
    assertCollectPaymentAllowed(scheme, entry.paymentDate);
  }

  const { firstPeriodPaid, laterPeriodPaid } = getLedgerPeriodTotals(scheme, entries);

  if (!allowZeroFirstPeriodLater && firstPeriodPaid <= 0 && laterPeriodPaid > 0) {
    throw new ApiError(
      409,
      "Later-period ledger total cannot exist without a first-period total.",
      [],
      {
        code: ERROR_CODES.PAYMENT_LIMIT_EXCEEDED,
        retryable: false,
      }
    );
  }

  if (laterPeriodPaid > firstPeriodPaid) {
    throw new ApiError(
      409,
      "Later-period ledger total exceeds first-period total.",
      [],
      {
        code: ERROR_CODES.PAYMENT_LIMIT_EXCEEDED,
        retryable: false,
      }
    );
  }

  return { firstPeriodPaid, laterPeriodPaid };
};

const assertProposedLedgerEntry = (scheme, currentEntries, paymentId, proposedEntry) => {
  const proposedEntries = currentEntries.filter(
    (entry) => String(entry.paymentId) !== String(paymentId)
  );
  if (proposedEntry) {
    proposedEntries.push(proposedEntry);
  }
  return assertLedgerEntriesValid(scheme, proposedEntries);
};

module.exports = {
  sumPeriodTotal,
  getLedgerPeriodTotals,
  assertLedgerEntriesValid,
  assertProposedLedgerEntry,
};
