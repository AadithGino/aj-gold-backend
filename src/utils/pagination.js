const ApiError = require("./ApiError");

const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const parseBoundedLimit = (value, maxLimit = DEFAULT_MAX_LIMIT) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), maxLimit);
};

const parseCursorPagination = (
  { cursor, limit, direction = "next" } = {},
  { maxLimit = DEFAULT_MAX_LIMIT, defaultLimit = DEFAULT_LIMIT } = {}
) => {
  const resolvedLimit = limit !== undefined ? parseBoundedLimit(limit, maxLimit) : defaultLimit;
  const normalizedDirection = direction === "prev" ? "prev" : "next";

  let decodedCursor = null;
  if (cursor) {
    try {
      decodedCursor = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    } catch {
      throw new ApiError(400, "Invalid cursor.");
    }
  }

  return {
    limit: resolvedLimit,
    direction: normalizedDirection,
    cursor: decodedCursor,
  };
};

const encodeCursor = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url");

const buildCursorPage = (items, { limit, getCursorValue }) => {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  const nextCursor =
    hasMore && pageItems.length > 0
      ? encodeCursor(getCursorValue(pageItems[pageItems.length - 1]))
      : null;

  return {
    items: pageItems,
    pageInfo: {
      limit,
      hasMore,
      nextCursor,
    },
  };
};

module.exports = {
  DEFAULT_MAX_LIMIT,
  DEFAULT_LIMIT,
  parseBoundedLimit,
  parseCursorPagination,
  encodeCursor,
  buildCursorPage,
};
