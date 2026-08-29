/**
 * Transaction reference is optional for every payment method.
 * Kept as a named helper so call sites stay stable.
 */
const assertNonCashReference = (_paymentMethod, _transactionReference) => {};

module.exports = {
  assertNonCashReference,
};
