const mongoose = require("mongoose");
const Payment = require("../models/payment.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const StaffProfile = require("../models/staffProfile.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { parseDateRange } = require("../utils/date");
const { logAudit } = require("./audit.service");
const { generateReceiptNumber } = require("./receipt.service");
const { willNewPaymentExceedLimit, getSchemeLimitSummary } = require("./paymentLimit.service");
const { getReceiptDisplayData } = require("./cash.service");
const { notifyPaymentReceived, notifyPaymentReversed } = require("./notification.service");
const { hasStaffPermission } = require("../constants/staffPermissions");

const MAX_LIST_LIMIT = 200;

const assertCollectorAllowed = async (actor) => {
  if (actor.role === USER_ROLES.ADMIN) {
    return;
  }

  if (actor.role !== USER_ROLES.STAFF) {
    throw new ApiError(403, "Only admin or staff can collect payments.");
  }

  const staffProfile = await StaffProfile.findOne({ user: actor._id });
  if (!hasStaffPermission(staffProfile, "canCollectPayment")) {
    throw new ApiError(403, "Staff does not have payment collection permission.");
  }
};

const getCustomerOrThrow = async (customerId) => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError(404, "Customer not found.");
  }
  return customer;
};

const getSchemeOrThrow = async (schemeId) => {
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }
  return scheme;
};

const mapPayment = (payment) => ({
  _id: payment._id,
  customer: payment.customer && payment.customer._id
    ? {
        _id: payment.customer._id,
        name: payment.customer.name,
        phone: payment.customer.phone,
        passbookNumber: payment.customer.passbookNumber,
      }
    : payment.customer,
  scheme: payment.scheme && payment.scheme._id
    ? {
        _id: payment.scheme._id,
        enrollmentNumber: payment.scheme.enrollmentNumber,
        status: payment.scheme.status,
      }
    : payment.scheme,
  collectedBy: payment.collectedBy && payment.collectedBy._id
    ? {
        _id: payment.collectedBy._id,
        name: payment.collectedBy.name,
        role: payment.collectedBy.role,
      }
    : payment.collectedBy,
  collectedByRole: payment.collectedByRole,
  amount: payment.amount,
  paymentMethod: payment.paymentMethod,
  transactionReference: payment.transactionReference || "",
  paymentDate: payment.paymentDate,
  receiptNumber: payment.receiptNumber,
  status: payment.status,
  isLimitOverride: Boolean(payment.isLimitOverride),
  overrideReason: payment.overrideReason || "",
  overrideBy: payment.overrideBy,
  notes: payment.notes || "",
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
});

const getPaymentByIdOrThrow = async (paymentId) => {
  if (!mongoose.Types.ObjectId.isValid(paymentId)) {
    throw new ApiError(400, "Invalid payment id.");
  }

  const payment = await Payment.findById(paymentId)
    .populate("customer", "name phone passbookNumber")
    .populate("scheme", "enrollmentNumber status")
    .populate("collectedBy", "name role");

  if (!payment) {
    throw new ApiError(404, "Payment not found.");
  }

  return payment;
};

const collectPayment = async (payload, actor) => {
  await assertCollectorAllowed(actor);

  const paymentDate = payload.paymentDate ? new Date(payload.paymentDate) : new Date();
  if (Number.isNaN(paymentDate.getTime())) {
    throw new ApiError(400, "Invalid payment date.");
  }

  if (!payload.amount || payload.amount <= 0) {
    throw new ApiError(400, "Amount must be greater than zero.");
  }

  const [customer, scheme] = await Promise.all([
    getCustomerOrThrow(payload.customer),
    getSchemeOrThrow(payload.scheme),
  ]);

  if (scheme.customer.toString() !== customer._id.toString()) {
    throw new ApiError(400, "Scheme does not belong to the selected customer.");
  }

  if (scheme.status !== SCHEME_STATUS.ACTIVE) {
    throw new ApiError(409, "Payment can only be collected for ACTIVE schemes.");
  }

  const limitCheck = await willNewPaymentExceedLimit(scheme._id, payload.amount, paymentDate);
  const overrideReason = payload.overrideReason?.trim() || "";
  let isLimitOverride = false;

  if (limitCheck.exceedsLimit) {
    if (actor.role === USER_ROLES.STAFF) {
      throw new ApiError(403, "Payment exceeds allowed limit. Staff cannot override.");
    }

    if (!overrideReason) {
      throw new ApiError(400, "Override reason is required when payment exceeds allowed limit.");
    }

    isLimitOverride = true;
  }

  const payment = await Payment.create({
    customer: customer._id,
    scheme: scheme._id,
    collectedBy: actor._id,
    collectedByRole: actor.role,
    amount: payload.amount,
    paymentMethod: payload.paymentMethod,
    transactionReference: payload.transactionReference?.trim() || "",
    paymentDate,
    receiptNumber: await generateReceiptNumber(paymentDate),
    status: PAYMENT_STATUS.SUCCESS,
    isLimitOverride,
    overrideReason: isLimitOverride ? overrideReason : "",
    overrideBy: isLimitOverride ? actor._id : undefined,
    notes: payload.notes?.trim() || "",
  });

  if (isLimitOverride) {
    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.ADMIN_OVERRIDE_USED,
      targetType: "Payment",
      targetId: payment._id,
      newValue: {
        paymentId: payment._id,
        amount: payment.amount,
        overrideReason,
      },
      notes: `Admin override used for over-limit payment on scheme ${scheme.enrollmentNumber}`,
    });
  }

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PAYMENT_COLLECTED,
    targetType: "Payment",
    targetId: payment._id,
    newValue: {
      customerId: customer._id,
      schemeId: scheme._id,
      amount: payment.amount,
      paymentMethod: payment.paymentMethod,
      receiptNumber: payment.receiptNumber,
      isLimitOverride,
    },
    notes: "Payment collected",
  });

  const [savedPayment, schemeSummary, receipt] = await Promise.all([
    getPaymentByIdOrThrow(payment._id),
    getSchemeLimitSummary(scheme._id),
    getReceiptDisplayData(payment._id),
  ]);

  // Fire notification for the customer (non-blocking)
  notifyPaymentReceived({
    customer,
    payment: { _id: payment._id, amount: payment.amount, paymentMethod: payment.paymentMethod, receiptNumber: payment.receiptNumber },
    collectedByName: actor.name || actor.role,
    collectedByRole: actor.role,
  });

  return {
    payment: mapPayment(savedPayment),
    schemeSummary,
    receipt,
    limitCheck,
  };
};

const listPayments = async (
  { customerId, schemeId, staffId, from, to, method, limit } = {},
  actor = null
) => {
  const customRange = parseDateRange(from, to);
  if (customRange.error) {
    throw new ApiError(400, customRange.error);
  }

  const query = { status: PAYMENT_STATUS.SUCCESS };

  if (actor?.role === USER_ROLES.STAFF) {
    query.collectedBy = actor._id;
  } else if (staffId) {
    query.collectedBy = staffId;
  }
  if (customerId) {
    query.customer = customerId;
  }
  if (schemeId) {
    query.scheme = schemeId;
  }
  if (method) {
    if (!Object.values(PAYMENT_METHODS).includes(method)) {
      throw new ApiError(400, "Invalid payment method filter.");
    }
    query.paymentMethod = method;
  }
  if (customRange.from || customRange.to) {
    query.paymentDate = {};
    if (customRange.from) {
      query.paymentDate.$gte = customRange.from;
    }
    if (customRange.to) {
      query.paymentDate.$lte = customRange.to;
    }
  }

  const resolvedLimit = Math.min(limit || MAX_LIST_LIMIT, MAX_LIST_LIMIT);

  const items = await Payment.find(query)
    .populate("customer", "name phone passbookNumber")
    .populate("scheme", "enrollmentNumber status")
    .populate("collectedBy", "name role")
    .sort({ paymentDate: -1, createdAt: -1 })
    .limit(resolvedLimit);

  return items.map(mapPayment);
};

const getPaymentDetail = async (paymentId) => {
  const payment = await getPaymentByIdOrThrow(paymentId);
  return mapPayment(payment);
};

const getPaymentReceipt = async (paymentId) => {
  const payment = await getPaymentByIdOrThrow(paymentId);
  const receipt = await getReceiptDisplayData(paymentId);
  if (!receipt) {
    throw new ApiError(404, "Receipt not found.");
  }

  return {
    payment: mapPayment(payment),
    receipt: {
      businessName: "AJ Gold Kambil",
      ...receipt,
    },
  };
};

const reversePayment = async (paymentId, payload, actor) => {
  if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can reverse payments.");
  }

  const payment = await getPaymentByIdOrThrow(paymentId);

  if (payment.status === PAYMENT_STATUS.REVERSED) {
    throw new ApiError(409, "Payment is already reversed.");
  }

  const reason = payload.reason.trim();
  payment.status = PAYMENT_STATUS.REVERSED;
  payment.notes = payload.notes?.trim() || reason;
  await payment.save();

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PAYMENT_REVERSED,
    targetType: "Payment",
    targetId: payment._id,
    previousValue: { status: PAYMENT_STATUS.SUCCESS },
    newValue: { status: PAYMENT_STATUS.REVERSED, reason, notes: payment.notes },
    notes: `Payment reversed: ${reason}`,
  });

  const [updatedPayment, schemeSummary] = await Promise.all([
    getPaymentByIdOrThrow(payment._id),
    getSchemeLimitSummary(payment.scheme._id || payment.scheme),
  ]);

  // Fire reversal notification (non-blocking)
  if (payment.customer) {
    const customer = await Customer.findById(payment.customer._id || payment.customer).lean();
    if (customer) {
      notifyPaymentReversed({
        customer,
        payment: { _id: payment._id, amount: payment.amount, receiptNumber: payment.receiptNumber },
      });
    }
  }

  return {
    payment: mapPayment(updatedPayment),
    schemeSummary,
  };
};

module.exports = {
  collectPayment,
  listPayments,
  getPaymentDetail,
  getPaymentReceipt,
  reversePayment,
  mapPayment,
  getPaymentByIdOrThrow,
  assertCollectorAllowed,
};
