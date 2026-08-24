const { PAYMENT_METHODS } = require("../constants/enums");
const ApiError = require("./ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const assertNonCashReference = (paymentMethod, transactionReference) => {
  if (paymentMethod === PAYMENT_METHODS.CASH) {
    return;
  }

  const reference = transactionReference?.trim();
  if (!reference) {
    throw new ApiError(400, "transactionReference is required for non-cash payment methods.", [], {
      code: ERROR_CODES.NON_CASH_REFERENCE_REQUIRED,
      retryable: false,
    });
  }
};

module.exports = {
  assertNonCashReference,
};
