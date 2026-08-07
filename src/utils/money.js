const ApiError = require("./ApiError");

const MAX_SAFE_RUPEE = Number.MAX_SAFE_INTEGER;

const parsePositiveRupeeInteger = (value, label = "amount") => {
  if (value === null || value === undefined || value === "") {
    throw new ApiError(400, `${label} is required.`);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new ApiError(400, `${label} must be a whole rupee amount.`);
    }
    value = Number(trimmed);
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, `${label} must be a valid number.`);
  }

  if (!Number.isInteger(value)) {
    throw new ApiError(400, `${label} must be a whole rupee amount without decimals.`);
  }

  if (value <= 0) {
    throw new ApiError(400, `${label} must be greater than zero.`);
  }

  if (value > MAX_SAFE_RUPEE) {
    throw new ApiError(400, `${label} exceeds the maximum allowed value.`);
  }

  return value;
};

const roundMoney = (value) => Math.round((value || 0) * 100) / 100;

module.exports = {
  parsePositiveRupeeInteger,
  roundMoney,
  MAX_SAFE_RUPEE,
};
