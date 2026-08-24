const ApiError = require("../utils/ApiError");

const CUSTOMER_PASSWORD_MIN = 4;
const CUSTOMER_PASSWORD_MAX = 32;
const PRIVILEGED_PASSWORD_MIN = 8;

const assertCustomerPassword = (password, { allowEmpty = false } = {}) => {
  if (!password || !String(password).trim()) {
    if (allowEmpty) return;
    throw new ApiError(400, `Password must be at least ${CUSTOMER_PASSWORD_MIN} characters.`);
  }

  const trimmed = String(password).trim();
  if (trimmed.length < CUSTOMER_PASSWORD_MIN || trimmed.length > CUSTOMER_PASSWORD_MAX) {
    throw new ApiError(
      400,
      `Customer password must be ${CUSTOMER_PASSWORD_MIN}-${CUSTOMER_PASSWORD_MAX} characters.`
    );
  }
};

const assertPrivilegedPassword = (password) => {
  if (!password || String(password).length < PRIVILEGED_PASSWORD_MIN) {
    throw new ApiError(
      400,
      `Password must be at least ${PRIVILEGED_PASSWORD_MIN} characters.`
    );
  }
};

module.exports = {
  CUSTOMER_PASSWORD_MIN,
  CUSTOMER_PASSWORD_MAX,
  PRIVILEGED_PASSWORD_MIN,
  assertCustomerPassword,
  assertPrivilegedPassword,
};
