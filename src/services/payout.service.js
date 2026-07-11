const CustomerPayout = require("../models/customerPayout.model");
const Scheme = require("../models/scheme.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYOUT_TYPES,
  PAYOUT_STATUS,
  SCHEME_STATUS,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { parseDateRange } = require("../utils/date");
const { logAudit } = require("./audit.service");
const { getCustomerOrThrow } = require("./customer.service");
const { generatePayoutNumber } = require("./receipt.service");
const { appendStatusHistory } = require("./scheme.service");

const ALLOWED_SCHEME_STATUS = [
  SCHEME_STATUS.REDEEMED,
  SCHEME_STATUS.WITHDRAWN,
  SCHEME_STATUS.CLOSED,
];

const auditActionForStatus = {
  [SCHEME_STATUS.REDEEMED]: AUDIT_ACTIONS.SCHEME_REDEEMED,
  [SCHEME_STATUS.CLOSED]: AUDIT_ACTIONS.SCHEME_CLOSED,
  [SCHEME_STATUS.WITHDRAWN]: AUDIT_ACTIONS.SCHEME_WITHDRAWN,
};

const mapPayout = (doc) => ({
  _id: doc._id,
  customer: doc.customer,
  scheme: doc.scheme,
  payoutNumber: doc.payoutNumber,
  payoutType: doc.payoutType,
  payoutMethod: doc.payoutMethod,
  amount: doc.amount,
  payoutDate: doc.payoutDate,
  paidBy: doc.paidBy,
  paidByRole: doc.paidByRole,
  referenceNumber: doc.referenceNumber || "",
  notes: doc.notes || "",
  status: doc.status,
  reversedBy: doc.reversedBy,
  reversedAt: doc.reversedAt,
  reversalReason: doc.reversalReason || "",
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const assertAdminOnly = (actor) => {
  if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can manage payouts in this phase.");
  }
};

const assertAdminOrStaff = (actor) => {
  if (![USER_ROLES.ADMIN, USER_ROLES.STAFF].includes(actor.role)) {
    throw new ApiError(403, "Only admin or staff can create payouts.");
  }
};

const createPayout = async (payload, actor) => {
  assertAdminOrStaff(actor);

  const amount = Number(payload.amount);
  if (!amount || amount <= 0) throw new ApiError(400, "Amount must be greater than zero.");

  if (!Object.values(PAYOUT_TYPES).includes(payload.payoutType)) {
    throw new ApiError(400, "Invalid payout type.");
  }
  if (!Object.values(PAYMENT_METHODS).includes(payload.payoutMethod)) {
    throw new ApiError(400, "Invalid payout method.");
  }

  const customer = await getCustomerOrThrow(payload.customerId || payload.customer);
  const scheme = await Scheme.findById(payload.schemeId || payload.scheme);
  if (!scheme) throw new ApiError(404, "Scheme not found.");
  if (String(scheme.customer) !== String(customer._id)) {
    throw new ApiError(400, "Scheme does not belong to the selected customer.");
  }

  const payoutDate = payload.payoutDate ? new Date(payload.payoutDate) : new Date();
  if (Number.isNaN(payoutDate.getTime())) throw new ApiError(400, "Invalid payout date.");

  const payout = await CustomerPayout.create({
    customer: customer._id,
    scheme: scheme._id,
    payoutNumber: await generatePayoutNumber(payoutDate),
    payoutType: payload.payoutType,
    payoutMethod: payload.payoutMethod,
    amount,
    payoutDate,
    paidBy: actor._id,
    paidByRole: actor.role,
    referenceNumber: payload.referenceNumber?.trim() || "",
    notes: payload.notes?.trim() || "",
    status: PAYOUT_STATUS.SUCCESS,
  });

  if (payload.applySchemeStatus) {
    if (!ALLOWED_SCHEME_STATUS.includes(payload.applySchemeStatus)) {
      throw new ApiError(400, "Invalid applySchemeStatus.");
    }
    appendStatusHistory(scheme, {
      status: payload.applySchemeStatus,
      changedBy: actor._id,
      changedByRole: actor.role,
      notes: payload.notes?.trim() || `Payout ${payout.payoutNumber}`,
    });
    await scheme.save();

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: auditActionForStatus[payload.applySchemeStatus],
      targetType: "Scheme",
      targetId: scheme._id,
      newValue: { status: payload.applySchemeStatus, payoutId: payout._id },
      notes: payload.notes?.trim() || "",
    });
  }

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PAYOUT_CREATED,
    targetType: "CustomerPayout",
    targetId: payout._id,
    newValue: {
      payoutNumber: payout.payoutNumber,
      amount: payout.amount,
      payoutMethod: payout.payoutMethod,
      payoutType: payout.payoutType,
    },
    notes: payload.notes?.trim() || "Customer payout recorded",
  });

  const populated = await CustomerPayout.findById(payout._id)
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status")
    .populate("paidBy", "name role");

  return mapPayout(populated);
};

const listPayouts = async (filters = {}, actor) => {
  assertAdminOnly(actor);

  const query = {};
  const range = parseDateRange(filters.from, filters.to);
  if (range.error) throw new ApiError(400, range.error);

  if (filters.customerId) query.customer = filters.customerId;
  if (filters.schemeId) query.scheme = filters.schemeId;
  if (filters.method) query.payoutMethod = filters.method;
  if (filters.payoutType) query.payoutType = filters.payoutType;
  if (filters.status) query.status = filters.status;
  if (range.from || range.to) {
    query.payoutDate = {};
    if (range.from) query.payoutDate.$gte = range.from;
    if (range.to) query.payoutDate.$lte = range.to;
  }

  const items = await CustomerPayout.find(query)
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status")
    .populate("paidBy", "name role")
    .sort({ payoutDate: -1, createdAt: -1 })
    .limit(Math.min(Number(filters.limit) || 100, 200))
    .lean();

  return items.map(mapPayout);
};

const listPayoutsForCustomer = async (customerId, actor) => {
  if (actor.role === USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Forbidden.");
  }
  await getCustomerOrThrow(customerId);

  const items = await CustomerPayout.find({ customer: customerId })
    .populate("scheme", "enrollmentNumber status")
    .populate("paidBy", "name role")
    .sort({ payoutDate: -1 })
    .lean();

  return items.map(mapPayout);
};

const listPayoutsForScheme = async (schemeId, actor) => {
  if (actor.role === USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Forbidden.");
  }
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) throw new ApiError(404, "Scheme not found.");

  const items = await CustomerPayout.find({ scheme: schemeId })
    .populate("customer", "name passbookNumber phone")
    .populate("paidBy", "name role")
    .sort({ payoutDate: -1 })
    .lean();

  return items.map(mapPayout);
};

const getPayoutDetail = async (payoutId, actor) => {
  assertAdminOnly(actor);
  const payout = await CustomerPayout.findById(payoutId)
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status schemeName")
    .populate("paidBy", "name role")
    .populate("reversedBy", "name role");

  if (!payout) throw new ApiError(404, "Payout not found.");
  return mapPayout(payout);
};

const reversePayout = async (payoutId, payload, actor) => {
  assertAdminOnly(actor);

  const payout = await CustomerPayout.findById(payoutId);
  if (!payout) throw new ApiError(404, "Payout not found.");
  if (payout.status === PAYOUT_STATUS.REVERSED) {
    throw new ApiError(409, "Payout is already reversed.");
  }

  const reason = payload.reason?.trim();
  if (!reason) throw new ApiError(400, "Reversal reason is required.");

  payout.status = PAYOUT_STATUS.REVERSED;
  payout.reversedBy = actor._id;
  payout.reversedAt = new Date();
  payout.reversalReason = reason;
  await payout.save();

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PAYOUT_REVERSED,
    targetType: "CustomerPayout",
    targetId: payout._id,
    previousValue: { status: PAYOUT_STATUS.SUCCESS },
    newValue: { status: PAYOUT_STATUS.REVERSED, reason },
    notes: reason,
  });

  const populated = await CustomerPayout.findById(payout._id)
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status")
    .populate("paidBy", "name role")
    .populate("reversedBy", "name role");

  return mapPayout(populated);
};

module.exports = {
  createPayout,
  listPayouts,
  listPayoutsForCustomer,
  listPayoutsForScheme,
  getPayoutDetail,
  reversePayout,
  mapPayout,
};
