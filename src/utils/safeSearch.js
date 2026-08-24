const ApiError = require("./ApiError");

const MAX_SEARCH_LENGTH = 128;

const escapeRegexLiteral = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseSafeSearchTerm = (value, { label = "search", maxLength = MAX_SEARCH_LENGTH } = {}) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new ApiError(400, `${label} is too long.`);
  }

  return escapeRegexLiteral(trimmed);
};

const buildSafeRegexFilter = (field, value, options = {}) => {
  const term = parseSafeSearchTerm(value, options);
  if (!term) {
    return null;
  }

  return { [field]: { $regex: term, $options: "i" } };
};

module.exports = {
  MAX_SEARCH_LENGTH,
  escapeRegexLiteral,
  parseSafeSearchTerm,
  buildSafeRegexFilter,
};
