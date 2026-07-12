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
  IDEMPOTENCY_OPERATIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const { parseDateRange } = require("../utils/date");
const { parsePositiveRupeeInteger } = require("../utils/money");
const { withTransaction } = require("../utils/transaction");
const { isSchemeSettled } = require("../utils/scheme");
const { logAudit } = require("./audit.service");
const { generateReceiptNumber } = require("./receipt.service");
const { willNewPaymentExceedLimit, getSchemeLimitSummary } = require("./paymentLimit.service");
const { getReceiptDisplayData } = require("./cash.service");
const { notifyPaymentReceived, notifyPaymentReversed } = require("./notification.service");
const { hasStaffPermission } = require("../constants/staffPermissions");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");
const {
  lockStaffCashProfile,
  assertStaffCashInHandSufficient,
} = require("./staffCash.service");

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

const assertPaymentAccess = (payment, actor) => {
  if (!actor) return;
  if (actor.role === USER_ROLES.ADMIN) return;
  if (actor.role === USER_ROLES.STAFF) {
    const collectorId = String(payment.collectedBy?._id || payment.collectedBy);
    if (collectorId !== String(actor._id)) {
      throw new ApiError(403, "Forbidden.");
    }
    return;
  }
  throw new ApiError(403, "Forbidden.");
};

const getCustomerOrThrow = async (customerId, session = null) => {
  const customer = await Customer.findById(customerId).session(session || null);
  if (!customer) {
    throw new ApiError(404, "Customer not found.");
  }
  return customer;
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

const getPaymentByIdOrThrow = async (paymentId, session = null) => {
  if (!mongoose.Types.ObjectId.isValid(paymentId)) {
    throw new ApiError(400, "Invalid payment id.");
  }

  const payment = await Payment.findById(paymentId)
    .populate("customer", "name phone passbookNumber")
    .populate("scheme", "enrollmentNumber status settlement")
    .populate("collectedBy", "name role")
    .session(session || null);

  if (!payment) {
    throw new ApiError(404, "Payment not found.");
  }

  return payment;
};

const buildCollectIdempotencyPayload = (payload, amount, paymentDate) => ({
  customer: payload.customer,
  scheme: payload.scheme,
  amount,
  paymentMethod: payload.paymentMethod,
  paymentDate: paymentDate.toISOString(),
  transactionReference: payload.transactionReference?.trim() || "",
  notes: payload.notes?.trim() || "",
  overrideReason: payload.overrideReason?.trim() || "",
});

const collectPayment = async (payload, actor) => {
  await assertCollectorAllowed(actor);

  const amount = parsePositiveRupeeInteger(payload.amount, "amount");
  const paymentDate = payload.paymentDate ? new Date(payload.paymentDate) : new Date();
  if (Number.isNaN(paymentDate.getTime())) {
    throw new ApiError(400, "Invalid payment date.");
  }

  const idempotencyPayload = buildCollectIdempotencyPayload(payload, amount, paymentDate);

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId: payload.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.PAYMENT_COLLECT,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    const scheme = await Scheme.findOneAndUpdate(
      { _id: payload.scheme, status: SCHEME_STATUS.ACTIVE },
      { $inc: { financialVersion: 1 } },
      { new: true, session }
    );
    if (!scheme) {
      const existing = await Scheme.findById(payload.scheme).session(session);
      if (existing && isSchemeSettled(existing)) {
        throw new ApiError(409, "Scheme is already settled.", [], {
          code: ERROR_CODES.PAYMENT_AFTER_SETTLEMENT,
          retryable: false,
        });
      }
      throw new ApiError(409, "Payment can only be collected for ACTIVE schemes.");
    }

    if (isSchemeSettled(scheme)) {
      throw new ApiError(409, "Scheme is already settled.", [], {
        code: ERROR_CODES.PAYMENT_AFTER_SETTLEMENT,
        retryable: false,
      });
    }

    const customer = await getCustomerOrThrow(payload.customer, session);
    if (scheme.customer.toString() !== customer._id.toString()) {
      throw new ApiError(400, "Scheme does not belong to the selected customer.");
    }

    const limitCheck = await willNewPaymentExceedLimit(scheme._id, amount, paymentDate, session);
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

    if (
      payload.paymentMethod === PAYMENT_METHODS.CASH &&
      actor.role === USER_ROLES.STAFF
    ) {
      await lockStaffCashProfile(actor._id, session);
    }

    const receiptNumber = await generateReceiptNumber(paymentDate, session);

    const [payment] = await Payment.create(
      [
        {
          customer: customer._id,
          scheme: scheme._id,
          collectedBy: actor._id,
          collectedByRole: actor.role,
          amount,
          paymentMethod: payload.paymentMethod,
          transactionReference: payload.transactionReference?.trim() || "",
          paymentDate,
          receiptNumber,
          status: PAYMENT_STATUS.SUCCESS,
          isLimitOverride,
          overrideReason: isLimitOverride ? overrideReason : "",
          overrideBy: isLimitOverride ? actor._id : undefined,
          notes: payload.notes?.trim() || "",
        },
      ],
      { session }
    );

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
        session,
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
        clientRequestId: payload.clientRequestId,
      },
      notes: "Payment collected",
      session,
    });

    const response = {
      paymentId: payment._id,
      customerId: customer._id,
      schemeId: scheme._id,
      limitCheck,
    };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.PAYMENT_COLLECT,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "Payment",
      resourceId: payment._id,
      session,
    });

    return { replay: false, response, customer, paymentId: payment._id };
  });

  if (txnResult.replay) {
    const savedPayment = await getPaymentByIdOrThrow(txnResult.response.paymentId);
    const [schemeSummary, receipt] = await Promise.all([
      getSchemeLimitSummary(savedPayment.scheme._id || savedPayment.scheme),
      getReceiptDisplayData(savedPayment._id),
    ]);
    return {
      payment: mapPayment(savedPayment),
      schemeSummary,
      receipt,
      limitCheck: txnResult.response.limitCheck,
    };
  }

  const { customer, paymentId, response } = txnResult;
  const [savedPayment, schemeSummary, receipt] = await Promise.all([
    getPaymentByIdOrThrow(paymentId),
    getSchemeLimitSummary(response.schemeId),
    getReceiptDisplayData(paymentId),
  ]);

  notifyPaymentReceived({
    customer,
    payment: {
      _id: savedPayment._id,
      amount: savedPayment.amount,
      paymentMethod: savedPayment.paymentMethod,
      receiptNumber: savedPayment.receiptNumber,
    },
    collectedByName: actor.name || actor.role,
    collectedByRole: actor.role,
  });

  return {
    payment: mapPayment(savedPayment),
    schemeSummary,
    receipt,
    limitCheck: response.limitCheck,
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

const getPaymentDetail = async (paymentId, actor = null) => {
  const payment = await getPaymentByIdOrThrow(paymentId);
  assertPaymentAccess(payment, actor);
  return mapPayment(payment);
};

const getPaymentReceipt = async (paymentId, actor = null) => {
  const payment = await getPaymentByIdOrThrow(paymentId);
  assertPaymentAccess(payment, actor);
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

  const reason = payload.reason?.trim();
  if (!reason) {
    throw new ApiError(400, "Reason is required.");
  }

  const idempotencyPayload = {
    paymentId,
    reason,
    notes: payload.notes?.trim() || "",
    settlementAdjustmentOverride: Boolean(payload.settlementAdjustmentOverride),
    settlementAdjustmentReason: payload.settlementAdjustmentReason?.trim() || "",
  };

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId: payload.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.PAYMENT_REVERSE,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    const payment = await Payment.findById(paymentId).session(session);
    if (!payment) {
      throw new ApiError(404, "Payment not found.");
    }

    if (payment.status === PAYMENT_STATUS.REVERSED) {
      throw new ApiError(409, "Payment is already reversed.", [], {
        code: ERROR_CODES.PAYMENT_ALREADY_REVERSED,
        retryable: false,
      });
    }
    if (payment.status !== PAYMENT_STATUS.SUCCESS) {
      throw new ApiError(409, "Only SUCCESS payments can be reversed.");
    }

    const scheme = await Scheme.findById(payment.scheme).session(session);
    if (!scheme) {
      throw new ApiError(404, "Scheme not found.");
    }

    if (isSchemeSettled(scheme)) {
      const allowOverride = Boolean(payload.settlementAdjustmentOverride);
      const overrideReason = payload.settlementAdjustmentReason?.trim() || "";
      if (!allowOverride || !overrideReason) {
        throw new ApiError(
          409,
          "Scheme is settled. Provide settlementAdjustmentOverride and settlementAdjustmentReason to reverse."
        );
      }
    }

    if (
      payment.paymentMethod === PAYMENT_METHODS.CASH &&
      payment.collectedByRole === USER_ROLES.STAFF
    ) {
      await lockStaffCashProfile(payment.collectedBy, session);
      await assertStaffCashInHandSufficient(payment.collectedBy, payment.amount, session);
    }

    const previousStatus = payment.status;
    payment.status = PAYMENT_STATUS.REVERSED;
    payment.notes = payload.notes?.trim() || reason;
    await payment.save({ session });

    await logAudit({
      actor: actor._id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.PAYMENT_REVERSED,
      targetType: "Payment",
      targetId: payment._id,
      previousValue: { status: previousStatus },
      newValue: {
        status: PAYMENT_STATUS.REVERSED,
        reason,
        notes: payment.notes,
        settlementAdjustmentOverride: Boolean(payload.settlementAdjustmentOverride),
        settlementAdjustmentReason: payload.settlementAdjustmentReason?.trim() || "",
        clientRequestId: payload.clientRequestId,
      },
      notes: `Payment reversed: ${reason}`,
      session,
    });

    const response = {
      paymentId: payment._id,
      schemeId: payment.scheme,
      customerId: payment.customer,
    };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.PAYMENT_REVERSE,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "Payment",
      resourceId: payment._id,
      session,
    });

    return { replay: false, response };
  });

  const paymentRef = txnResult.replay ? txnResult.response.paymentId : txnResult.response.paymentId;
  const [updatedPayment, schemeSummary] = await Promise.all([
    getPaymentByIdOrThrow(paymentRef),
    getSchemeLimitSummary(
      txnResult.replay ? txnResult.response.schemeId : txnResult.response.schemeId
    ),
  ]);

  if (!txnResult.replay && updatedPayment.customer) {
    const customer = await Customer.findById(
      updatedPayment.customer._id || updatedPayment.customer
    ).lean();
    if (customer) {
      notifyPaymentReversed({
        customer,
        payment: {
          _id: updatedPayment._id,
          amount: updatedPayment.amount,
          receiptNumber: updatedPayment.receiptNumber,
        },
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
  assertPaymentAccess,
};
