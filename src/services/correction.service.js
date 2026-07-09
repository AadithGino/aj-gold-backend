const PaymentCorrection = require("../models/paymentCorrection.model");
const Payment = require("../models/payment.model");
const Customer = require("../models/customer.model");
const {
  USER_ROLES,
  CORRECTION_TYPES,
  CORRECTION_STATUS,
  PAYMENT_STATUS,
  PAYMENT_METHODS,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { parseDateRange } = require("../utils/date");
const { logAudit } = require("./audit.service");
const { getPaymentByIdOrThrow } = require("./payment.service");
const { getSchemeLimitSummary } = require("./paymentLimit.service");
const { notifyPaymentReversed } = require("./notification.service");

const buildPaymentSnapshot = (payment) => ({
  amount: payment.amount,
  paymentMethod: payment.paymentMethod,
  paymentDate: payment.paymentDate,
  transactionReference: payment.transactionReference || "",
  notes: payment.notes || "",
  status: payment.status,
  receiptNumber: payment.receiptNumber,
});

const mapCorrection = (doc) => ({
  _id: doc._id,
  payment: doc.payment,
  customer: doc.customer,
  scheme: doc.scheme,
  requestedBy: doc.requestedBy,
  requestedByRole: doc.requestedByRole,
  correctionType: doc.correctionType,
  originalSnapshot: doc.originalSnapshot,
  requestedValue: doc.requestedValue,
  reason: doc.reason,
  status: doc.status,
  reviewedBy: doc.reviewedBy,
  reviewedAt: doc.reviewedAt,
  reviewNotes: doc.reviewNotes || "",
  notes: doc.notes || "",
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const assertCanRequestCorrection = async (payment, actor) => {
  if (actor.role === USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Customers cannot request payment corrections.");
  }

  if (actor.role === USER_ROLES.STAFF) {
    const collectorId = String(payment.collectedBy?._id || payment.collectedBy);
    if (collectorId !== String(actor._id)) {
      throw new ApiError(403, "Staff can only request corrections for payments they collected.");
    }
  }

  const pending = await PaymentCorrection.findOne({
    payment: payment._id,
    status: CORRECTION_STATUS.PENDING,
  });
  if (pending) {
    throw new ApiError(409, "A pending correction already exists for this payment.");
  }
};

const validateRequestedValue = (correctionType, requestedValue) => {
  if (correctionType === CORRECTION_TYPES.REVERSE_PAYMENT) {
    return requestedValue || null;
  }
  if (requestedValue == null || requestedValue === "") {
    throw new ApiError(400, "requestedValue is required for this correction type.");
  }

  switch (correctionType) {
    case CORRECTION_TYPES.EDIT_AMOUNT: {
      const amount = Number(requestedValue);
      if (!amount || amount <= 0) throw new ApiError(400, "Amount must be greater than zero.");
      return amount;
    }
    case CORRECTION_TYPES.EDIT_METHOD: {
      if (!Object.values(PAYMENT_METHODS).includes(requestedValue)) {
        throw new ApiError(400, "Invalid payment method.");
      }
      return requestedValue;
    }
    case CORRECTION_TYPES.EDIT_DATE: {
      const date = new Date(requestedValue);
      if (Number.isNaN(date.getTime())) throw new ApiError(400, "Invalid payment date.");
      return date;
    }
    case CORRECTION_TYPES.EDIT_REFERENCE:
    case CORRECTION_TYPES.EDIT_NOTES:
      return String(requestedValue).trim();
    default:
      return requestedValue;
  }
};

const createCorrectionRequest = async (paymentId, payload, actor) => {
  const payment = await getPaymentByIdOrThrow(paymentId);

  if (payment.status !== PAYMENT_STATUS.SUCCESS) {
    throw new ApiError(409, "Only SUCCESS payments can be corrected.");
  }

  await assertCanRequestCorrection(payment, actor);

  const reason = payload.reason?.trim();
  if (!reason) throw new ApiError(400, "Reason is required.");

  if (!Object.values(CORRECTION_TYPES).includes(payload.correctionType)) {
    throw new ApiError(400, "Invalid correction type.");
  }

  const requestedValue = validateRequestedValue(payload.correctionType, payload.requestedValue);

  const correction = await PaymentCorrection.create({
    payment: payment._id,
    customer: payment.customer._id || payment.customer,
    scheme: payment.scheme._id || payment.scheme,
    requestedBy: actor._id,
    requestedByRole: actor.role,
    correctionType: payload.correctionType,
    originalSnapshot: buildPaymentSnapshot(payment),
    requestedValue,
    reason,
    status: CORRECTION_STATUS.PENDING,
    notes: payload.notes?.trim() || "",
  });

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CORRECTION_REQUESTED,
    targetType: "PaymentCorrection",
    targetId: correction._id,
    newValue: {
      paymentId: payment._id,
      correctionType: correction.correctionType,
      requestedValue,
    },
    notes: reason,
  });

  return mapCorrection(
    await PaymentCorrection.findById(correction._id)
      .populate("requestedBy", "name role")
      .populate("payment", "receiptNumber amount paymentMethod")
  );
};

const applyApprovedCorrection = async (payment, correction, approvedValue) => {
  const { correctionType } = correction;
  const value = approvedValue != null ? approvedValue : correction.requestedValue;

  if (correctionType === CORRECTION_TYPES.REVERSE_PAYMENT) {
    payment.status = PAYMENT_STATUS.REVERSED;
    payment.notes = correction.reason;
    await payment.save();
    return payment;
  }

  switch (correctionType) {
    case CORRECTION_TYPES.EDIT_AMOUNT:
      payment.amount = Number(value);
      break;
    case CORRECTION_TYPES.EDIT_METHOD:
      payment.paymentMethod = value;
      break;
    case CORRECTION_TYPES.EDIT_DATE:
      payment.paymentDate = new Date(value);
      break;
    case CORRECTION_TYPES.EDIT_REFERENCE:
      payment.transactionReference = String(value);
      break;
    case CORRECTION_TYPES.EDIT_NOTES:
      payment.notes = String(value);
      break;
    default:
      throw new ApiError(400, "Unsupported correction type.");
  }

  await payment.save();
  return payment;
};

const approveCorrection = async (correctionId, payload, actor) => {
  if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can approve corrections.");
  }

  const correction = await PaymentCorrection.findById(correctionId);
  if (!correction) throw new ApiError(404, "Correction request not found.");
  if (correction.status !== CORRECTION_STATUS.PENDING) {
    throw new ApiError(409, "Correction is not pending.");
  }

  const payment = await Payment.findById(correction.payment);
  if (!payment) throw new ApiError(404, "Linked payment not found.");

  const approvedValue =
    payload.approvedValue != null
      ? validateRequestedValue(correction.correctionType, payload.approvedValue)
      : correction.requestedValue;

  await applyApprovedCorrection(payment, correction, approvedValue);

  correction.status = CORRECTION_STATUS.APPROVED;
  correction.reviewedBy = actor._id;
  correction.reviewedAt = new Date();
  correction.reviewNotes = payload.reviewNotes?.trim() || "";
  if (payload.approvedValue != null) {
    correction.requestedValue = approvedValue;
  }
  await correction.save();

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CORRECTION_APPROVED,
    targetType: "PaymentCorrection",
    targetId: correction._id,
    previousValue: correction.originalSnapshot,
    newValue: {
      paymentId: payment._id,
      correctionType: correction.correctionType,
      approvedValue,
    },
    notes: correction.reviewNotes || payload.reason || "Correction approved",
  });

  if (correction.correctionType === CORRECTION_TYPES.REVERSE_PAYMENT) {
    const customer = await Customer.findById(payment.customer).lean();
    if (customer) {
      notifyPaymentReversed({
        customer,
        payment: {
          _id: payment._id,
          amount: payment.amount,
          receiptNumber: payment.receiptNumber,
        },
      });
    }
  }

  const schemeSummary = await getSchemeLimitSummary(payment.scheme);
  const populated = await PaymentCorrection.findById(correction._id)
    .populate("requestedBy", "name role")
    .populate("reviewedBy", "name role")
    .populate("payment", "receiptNumber amount paymentMethod status");

  return { correction: mapCorrection(populated), schemeSummary };
};

const rejectCorrection = async (correctionId, payload, actor) => {
  if (actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Only admin can reject corrections.");
  }

  const correction = await PaymentCorrection.findById(correctionId);
  if (!correction) throw new ApiError(404, "Correction request not found.");
  if (correction.status !== CORRECTION_STATUS.PENDING) {
    throw new ApiError(409, "Correction is not pending.");
  }

  correction.status = CORRECTION_STATUS.REJECTED;
  correction.reviewedBy = actor._id;
  correction.reviewedAt = new Date();
  correction.reviewNotes = payload.reviewNotes?.trim() || payload.reason?.trim() || "";
  await correction.save();

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.CORRECTION_REJECTED,
    targetType: "PaymentCorrection",
    targetId: correction._id,
    notes: correction.reviewNotes || "Correction rejected",
  });

  const populated = await PaymentCorrection.findById(correction._id)
    .populate("requestedBy", "name role")
    .populate("reviewedBy", "name role")
    .populate("payment", "receiptNumber amount paymentMethod status");

  return mapCorrection(populated);
};

const listCorrections = async (filters = {}, actor) => {
  const query = {};
  const range = parseDateRange(filters.from, filters.to);
  if (range.error) throw new ApiError(400, range.error);

  if (actor.role === USER_ROLES.STAFF) {
    query.requestedBy = actor._id;
  } else if (filters.staffId) {
    query.requestedBy = filters.staffId;
  }

  if (filters.status) query.status = filters.status;
  if (filters.customerId) query.customer = filters.customerId;
  if (filters.schemeId) query.scheme = filters.schemeId;
  if (range.from || range.to) {
    query.createdAt = {};
    if (range.from) query.createdAt.$gte = range.from;
    if (range.to) query.createdAt.$lte = range.to;
  }

  const items = await PaymentCorrection.find(query)
    .populate("requestedBy", "name role")
    .populate("reviewedBy", "name role")
    .populate("payment", "receiptNumber amount paymentMethod status paymentDate")
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status")
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(filters.limit) || 100, 200))
    .lean();

  return items.map(mapCorrection);
};

const getCorrectionDetail = async (correctionId, actor) => {
  const correction = await PaymentCorrection.findById(correctionId)
    .populate("requestedBy", "name role phone")
    .populate("reviewedBy", "name role")
    .populate("payment")
    .populate("customer", "name passbookNumber phone")
    .populate("scheme", "enrollmentNumber status schemeName");

  if (!correction) throw new ApiError(404, "Correction request not found.");

  if (
    actor.role === USER_ROLES.STAFF &&
    String(correction.requestedBy._id || correction.requestedBy) !== String(actor._id)
  ) {
    throw new ApiError(403, "Forbidden.");
  }

  return mapCorrection(correction);
};

module.exports = {
  createCorrectionRequest,
  approveCorrection,
  rejectCorrection,
  listCorrections,
  getCorrectionDetail,
  buildPaymentSnapshot,
};
