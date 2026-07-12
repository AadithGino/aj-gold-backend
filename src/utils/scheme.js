const { SETTLEMENT_STATUSES } = require("../constants/enums");
const ApiError = require("./ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const isSchemeSettled = (scheme) =>
  Boolean(scheme && SETTLEMENT_STATUSES.includes(scheme.status));

const assertSchemeNotSettled = (scheme) => {
  if (isSchemeSettled(scheme)) {
    throw new ApiError(409, "Scheme is already settled.", [], {
      code: ERROR_CODES.SCHEME_ALREADY_SETTLED,
      retryable: false,
    });
  }
};

module.exports = {
  isSchemeSettled,
  assertSchemeNotSettled,
};
