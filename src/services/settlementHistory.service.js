const mongoose = require("mongoose");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const { USER_ROLES, SCHEME_STATUS } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { parseDateRange } = require("../utils/date");
const { parseCursorPagination, buildCursorPage } = require("../utils/pagination");

const TERMINAL_STATUSES = [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED];

const toObjectId = (value, label) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return new mongoose.Types.ObjectId(String(value));
};

const buildScopeToken = ({ customerId, settledBy, from, to }) =>
  JSON.stringify({
    customerId: customerId ? String(customerId) : null,
    settledBy: settledBy ? String(settledBy) : null,
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
  });

const assertSettlementCursor = (decodedCursor, scopeToken) => {
  if (!decodedCursor) return null;
  if (
    typeof decodedCursor !== "object" ||
    decodedCursor.settledAt == null ||
    !decodedCursor._id ||
    typeof decodedCursor.scope !== "string"
  ) {
    throw new ApiError(400, "Invalid cursor.");
  }
  if (decodedCursor.scope !== scopeToken) {
    throw new ApiError(400, "Cursor does not match the current scope.");
  }
  const settledAt = new Date(decodedCursor.settledAt);
  if (Number.isNaN(settledAt.getTime()) || !mongoose.Types.ObjectId.isValid(decodedCursor._id)) {
    throw new ApiError(400, "Invalid cursor.");
  }
  return {
    settledAt,
    _id: new mongoose.Types.ObjectId(String(decodedCursor._id)),
    scope: decodedCursor.scope,
  };
};

const mapSettlementItem = (scheme, { includeCustomer }) => {
  const settlement = scheme.settlement || {};
  const settledAt = settlement.settledAt;
  const item = {
    _id: String(scheme._id),
    schemeId: scheme._id,
    schemeName: scheme.schemeName,
    enrollmentNumber: scheme.enrollmentNumber,
    status: scheme.status,
    settlementCategory: settlement.settlementCategory || "",
    amount: settlement.amount,
    settledAt,
    changedAt: settledAt,
    payoutMethod: settlement.payoutMethod || "",
    settlementReceiptId: settlement.settlementReceiptId || "",
  };

  const payoutReference = String(settlement.payoutReference || "").trim();
  if (payoutReference) item.payoutReference = payoutReference;

  const notes = String(settlement.notes || "").trim();
  if (notes) item.notes = notes;

  if (includeCustomer) {
    const customer = scheme.customer && typeof scheme.customer === "object" ? scheme.customer : null;
    item.customer = customer
      ? {
          _id: customer._id,
          name: customer.name || "",
          passbookNumber: customer.passbookNumber || "",
        }
      : null;
  }

  return item;
};

const listSettlementHistory = async ({
  customerId,
  settledBy,
  from,
  to,
  cursor,
  limit,
  includeCustomer = false,
} = {}) => {
  const customRange = parseDateRange(from, to);
  if (customRange.error) {
    throw new ApiError(400, customRange.error);
  }

  const { limit: resolvedLimit, cursor: decodedCursor } = parseCursorPagination(
    { cursor, limit },
    { maxLimit: 100, defaultLimit: 30 }
  );

  const match = {
    status: { $in: TERMINAL_STATUSES },
    "settlement.settledAt": { $exists: true, $ne: null },
  };

  if (customerId) {
    match.customer = toObjectId(customerId, "customer id");
  }
  if (settledBy) {
    match["settlement.settledBy"] = toObjectId(settledBy, "staff id");
  }
  if (customRange.from || customRange.to) {
    const settledAt = {
      $exists: true,
      $ne: null,
    };
    if (customRange.from) settledAt.$gte = customRange.from;
    if (customRange.to) settledAt.$lte = customRange.to;
    match["settlement.settledAt"] = settledAt;
  }

  const scopeToken = buildScopeToken({
    customerId: match.customer || null,
    settledBy: match["settlement.settledBy"] || null,
    from: customRange.from,
    to: customRange.to,
  });
  const cursorState = assertSettlementCursor(decodedCursor, scopeToken);

  const listQuery = { ...match };
  if (cursorState) {
    listQuery.$or = [
      { "settlement.settledAt": { $lt: cursorState.settledAt } },
      { "settlement.settledAt": cursorState.settledAt, _id: { $lt: cursorState._id } },
    ];
  }

  const [rows, summaryRows] = await Promise.all([
    Scheme.find(listQuery)
      .populate("customer", "name passbookNumber")
      .sort({ "settlement.settledAt": -1, _id: -1 })
      .limit(resolvedLimit + 1)
      .lean(),
    Scheme.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalAmount: { $sum: "$settlement.amount" },
        },
      },
    ]),
  ]);

  const mapped = rows.map((scheme) => mapSettlementItem(scheme, { includeCustomer }));
  const page = buildCursorPage(mapped, {
    limit: resolvedLimit,
    getCursorValue: (row) => ({
      settledAt: row.settledAt,
      _id: row._id,
      scope: scopeToken,
    }),
  });

  const summaryRow = summaryRows[0] || { count: 0, totalAmount: 0 };

  return {
    items: page.items,
    pageInfo: page.pageInfo,
    summary: {
      count: summaryRow.count || 0,
      totalAmount: summaryRow.totalAmount || 0,
    },
    range: {
      from: customRange.from || null,
      to: customRange.to || null,
    },
  };
};

const getCustomerRedemptionHistory = async (customerId, filters = {}, { includeCustomer = true } = {}) => {
  const customer = await Customer.findById(customerId).lean();
  if (!customer) {
    throw new ApiError(404, "Customer profile not found.");
  }
  return listSettlementHistory({
    ...filters,
    customerId: customer._id,
    includeCustomer,
  });
};

const getOwnCustomerRedemptionHistory = async (user, filters = {}) => {
  if (user.role !== USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Customer only.");
  }
  const customer = await Customer.findOne({ user: user._id }).lean();
  if (!customer) {
    throw new ApiError(404, "Customer profile not found.");
  }
  return getCustomerRedemptionHistory(customer._id, filters, { includeCustomer: false });
};

const getStaffRedemptionHistory = async (user, filters = {}) => {
  if (![USER_ROLES.ADMIN, USER_ROLES.STAFF].includes(user.role)) {
    throw new ApiError(403, "Staff/Admin only.");
  }
  return listSettlementHistory({
    ...filters,
    settledBy: user._id,
    includeCustomer: true,
  });
};

module.exports = {
  TERMINAL_STATUSES,
  listSettlementHistory,
  getCustomerRedemptionHistory,
  getOwnCustomerRedemptionHistory,
  getStaffRedemptionHistory,
};
