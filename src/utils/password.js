const crypto = require("crypto");
const ApiError = require("./ApiError");

const MIN_PASSWORD_LENGTH = 8;

const assertPasswordStrength = (password) => {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
};

const generateTemporaryPassword = () =>
  crypto.randomBytes(9).toString("base64url").slice(0, 12);

module.exports = {
  MIN_PASSWORD_LENGTH,
  assertPasswordStrength,
  generateTemporaryPassword,
};
