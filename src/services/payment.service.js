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
const { isSchemeSettled, isSchemeFinanciallyLocked } = require("../utils/scheme");
const { logAudit } = require("./audit.service");
const { generateReceiptNumber } = require("./receipt.service");
const { willNewPaymentExceedLimit, getSchemeLimitSummary } = require("./paymentLimit.service");
const {
  assertCollectPaymentAllowed,
  assertCallerPaymentDateNotAllowed,
} = require("../utils/schemeWindow");
const { getReceiptDisplayData } = require("./cash.service");
const { hasStaffPermission } = require("../constants/staffPermissions");
const { assertNonCashReference } = require("../utils/paymentReference");
const { enqueueOutboxEvent } = require("./outbox.service");
const { OUTBOX_TOPICS } = require("../models/outboxEvent.model");
const { NOTIFICATION_TYPES } = require("../models/notification.model");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");
const { buildPaymentCollectIntent } = require("../utils/idempotencyPayload");
const {
  loadSchemeLedgerContext,
  buildSourceSnapshot,
  getEffectiveLedgerFields,
} = require("../utils/paymentLedger");
const { assertLedgerEntriesValid } = require("../utils/ledgerValidation");
const {
  recordCollectionReceived,
  recordCollectionReversal,
} = require("../utils/journalRecording");
const {
  lockStaffCashProfile,
  assertStaffCashInHandSufficient,
} = require("./staffCash.service");
const { parseCursorPagination, buildCursorPage } = require("../utils/pagination");
const {
  enrichPaymentsWithEffectiveView,
  applyEffectivePaymentRow,
  loadEffectivePaymentContext,
  filterEffectiveEntries,
} = require("../utils/effectiveReadModel");

const MAX_LIST_LIMIT = 200;
const PAGE_SCAN_MULTIPLIER = 3;
const MAX_PAGE_SCAN_BATCHES = 40;

const buildListScopeToken = ({ actor, query, method, customRange }) =>
  JSON.stringify({
    actorRole: actor?.role || null,
    actorId: actor?._id ? String(actor._id) : null,
    collectedBy: query.collectedBy ? String(query.collectedBy) : null,
    customer: query.customer ? String(query.customer) : null,
    scheme: query.scheme ? String(query.scheme) : null,
    method: method || null,
    from: customRange.from ? customRange.from.toISOString() : null,
    to: customRange.to ? customRange.to.toISOString() : null,
  });

const assertPaymentsCursor = (decodedCursor, scopeToken) => {
  if (!decodedCursor) return null;
  if (
    typeof decodedCursor !== "object" ||
    !decodedCursor._id ||
    typeof decodedCursor.scope !== "string"
  ) {
    throw new ApiError(400, "Invalid cursor.");
  }
  if (decodedCursor.scope !== scopeToken) {
    throw new ApiError(400, "Cursor does not match the current scope.");
  }
  return {
    _id: decodedCursor._id,
  };
};

const assertCollectorAllowed = async (actor) => {
  if (actor.role === USER_ROLES.ADMIN) {
    return;
  }

  if (actor.role !== USER_ROLES.STAFF) {
    throw new ApiError(403, "Only admin or staff can collect payments.");
  }

  const staffProfile = await StaffProfile.findOne({ user: actor._id });
  if (!staffProfile || !hasStaffPermission(staffProfile, "canCollectPayment")) {
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

const { getCustomerOrThrow, assertCustomerActiveForOperations } = require("./customer.service");

const mapPayment = (payment, effectiveMeta = null) => {
  const base = {
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
    notes: payment.notes || "",
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };

  if (!effectiveMeta) {
    return base;
  }

  return {
    ...base,
    amount: effectiveMeta.displayAmount,
    paymentMethod: effectiveMeta.displayPaymentMethod,
    paymentDate: effectiveMeta.displayPaymentDate,
    sourceAmount: payment.amount,
    sourcePaymentMethod: payment.paymentMethod,
    effectiveAmount: effectiveMeta.effectiveAmount,
    effectivePaymentMethod: effectiveMeta.effectivePaymentMethod,
    isEffectivelyReversed: effectiveMeta.isEffectivelyReversed,
  };
};

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

const buildCollectIdempotencyPayload = (payload, amount) =>
  buildPaymentCollectIntent(payload, amount);

const collectPayment = async (payload, actor) => {
  await assertCollectorAllowed(actor);

  assertCallerPaymentDateNotAllowed(payload);

  const amount = parsePositiveRupeeInteger(payload.amount, "amount");
  assertNonCashReference(payload.paymentMethod, payload.transactionReference);
  const paymentDate = new Date();

  const idempotencyPayload = buildCollectIdempotencyPayload(payload, amount);

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
      { returnDocument: "after", session }
    );
    if (!scheme) {
      const existing = await Scheme.findById(payload.scheme).session(session);
      if (existing && isSchemeFinanciallyLocked(existing)) {
        throw new ApiError(409, "Scheme is already settled.", [], {
          code: ERROR_CODES.PAYMENT_AFTER_SETTLEMENT,
          retryable: false,
        });
      }
      throw new ApiError(409, "Payment can only be collected for ACTIVE schemes.");
    }

    if (isSchemeFinanciallyLocked(scheme)) {
      throw new ApiError(409, "Scheme is already settled.", [], {
        code: ERROR_CODES.PAYMENT_AFTER_SETTLEMENT,
        retryable: false,
      });
    }

    const customer = await getCustomerOrThrow(payload.customer, session);
    await assertCustomerActiveForOperations(customer, session);
    if (scheme.customer.toString() !== customer._id.toString()) {
      throw new ApiError(400, "Scheme does not belong to the selected customer.");
    }

    assertCollectPaymentAllowed(scheme, paymentDate);

    const limitCheck = await willNewPaymentExceedLimit(scheme._id, amount, paymentDate, session);

    if (limitCheck.exceedsLimit) {
      throw new ApiError(409, "Payment exceeds remaining allowed amount for the post-six-month period.", [], {
        code: ERROR_CODES.PAYMENT_LIMIT_EXCEEDED,
        retryable: false,
      });
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
          notes: payload.notes?.trim() || "",
        },
      ],
      { session }
    );

    await recordCollectionReceived(
      {
        payment,
        actor,
        clientRequestId: payload.clientRequestId,
      },
      session
    );

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

    if (customer.user) {
      const roleTag = actor.role === USER_ROLES.ADMIN ? "Admin" : "Staff";
      await enqueueOutboxEvent(
        {
          topic: OUTBOX_TOPICS.PAYMENT_RECEIVED,
          dedupeKey: `payment-received:${payment._id}`,
          payload: {
            recipient: customer.user,
            type: NOTIFICATION_TYPES.PAYMENT_RECEIVED,
            title: "Payment Received",
            message: `${roleTag} ${actor.name || actor.role} collected ₹${payment.amount.toLocaleString("en-IN")} via ${payment.paymentMethod} for your scheme (${payment.receiptNumber}).`,
            data: {
              paymentId: payment._id,
              amount: payment.amount,
              paymentMethod: payment.paymentMethod,
              receiptNumber: payment.receiptNumber,
            },
          },
        },
        session
      );
    }

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

  return {
    payment: mapPayment(savedPayment),
    schemeSummary,
    receipt,
    limitCheck: response.limitCheck,
  };
};

const listPayments = async (
  { customerId, schemeId, staffId, from, to, method, limit, cursor } = {},
  actor = null
) => {
  if (actor?.role === USER_ROLES.CUSTOMER) {
    const own = await Customer.findOne({ user: actor._id }).select("_id");
    if (!own) {
      throw new ApiError(404, "Customer profile not found.");
    }
    customerId = String(own._id);
    staffId = undefined;
  }

  const customRange = parseDateRange(from, to);
  if (customRange.error) {
    throw new ApiError(400, customRange.error);
  }
  if (method && !Object.values(PAYMENT_METHODS).includes(method)) {
    throw new ApiError(400, "Invalid payment method filter.");
  }

  const { limit: resolvedLimit, cursor: decodedCursor } = parseCursorPagination(
    { cursor, limit },
    { maxLimit: MAX_LIST_LIMIT, defaultLimit: 50 }
  );

  const query = {};

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
  if (customRange.from || customRange.to) {
    // Date filtering is applied on canonical effective payment dates
    // after correction overlays. The scan order remains immutable.
    query.paymentDate = undefined;
  }
  delete query.paymentDate;

  const scopeToken = buildListScopeToken({ actor, query, method, customRange });
  let cursorState = assertPaymentsCursor(decodedCursor, scopeToken);

  const items = [];
  let batchCount = 0;
  const batchSize = Math.max(resolvedLimit + 1, resolvedLimit * PAGE_SCAN_MULTIPLIER);
  let hasMoreRaw = true;

  const inEffectiveDateRange = (effectiveDate) => {
    const timestamp = new Date(effectiveDate).getTime();
    if (Number.isNaN(timestamp)) return false;
    if (customRange.from && timestamp < customRange.from.getTime()) {
      return false;
    }
    if (customRange.to && timestamp > customRange.to.getTime()) {
      return false;
    }
    return true;
  };

  while (hasMoreRaw && items.length <= resolvedLimit && batchCount < MAX_PAGE_SCAN_BATCHES) {
    batchCount += 1;
    const listQuery = { ...query };
    if (cursorState) {
      listQuery._id = { $lt: cursorState._id };
    }

    const rows = await Payment.find(listQuery)
      .populate("customer", "name phone passbookNumber")
      .populate("scheme", "enrollmentNumber status")
      .populate("collectedBy", "name role")
      .sort({ _id: -1 })
      .limit(batchSize)
      .lean();

    if (!rows.length) {
      hasMoreRaw = false;
      break;
    }

    const enriched = await enrichPaymentsWithEffectiveView(rows);
    for (const { payment, view, latest } of enriched) {
      if (!view.effectiveLedger) {
        continue;
      }
      if (method && view.paymentMethod !== method) {
        continue;
      }
      if (!inEffectiveDateRange(view.paymentDate)) {
        continue;
      }
      items.push(mapPayment(payment, applyEffectivePaymentRow(payment, latest)));
      if (items.length > resolvedLimit) {
        break;
      }
    }

    const tail = rows[rows.length - 1];
    cursorState = {
      _id: tail._id,
    };
    hasMoreRaw = rows.length === batchSize;
  }

  const page = buildCursorPage(items, {
    limit: resolvedLimit,
    getCursorValue: (row) => ({
      _id: row._id,
      scope: scopeToken,
    }),
  });

  // Approximate total from the immutable payment query (before effective overlays).
  // Date/method filters are applied after enrichment, so this is an upper bound when those filters are set.
  const total = await Payment.countDocuments(query);

  const effectiveFilters = {};
  if (method) {
    effectiveFilters.paymentMethod = method;
  }
  if (customRange.from || customRange.to) {
    effectiveFilters.paymentDate = {};
    if (customRange.from) {
      effectiveFilters.paymentDate.$gte = customRange.from;
    }
    if (customRange.to) {
      effectiveFilters.paymentDate.$lte = customRange.to;
    }
  }

  const effectiveContext = await loadEffectivePaymentContext(query);
  const effectiveEntries = filterEffectiveEntries(effectiveContext.entries, effectiveFilters);
  const effectiveCount = effectiveEntries.length;
  const totalAmount = effectiveEntries.reduce((sum, { ledger }) => sum + ledger.amount, 0);

  return {
    ...page,
    pageInfo: {
      ...page.pageInfo,
      total,
    },
    summary: {
      count: total,
      effectiveCount,
      totalAmount,
    },
  };
};

const getPaymentDetail = async (paymentId, actor = null) => {
  const payment = await getPaymentByIdOrThrow(paymentId);
  assertPaymentAccess(payment, actor);
  const enriched = await enrichPaymentsWithEffectiveView([payment.toObject ? payment.toObject() : payment]);
  const { payment: row, latest } = enriched[0];
  return mapPayment(row, applyEffectivePaymentRow(row, latest));
};

const getPaymentReceipt = async (paymentId, actor = null) => {
  const payment = await getPaymentByIdOrThrow(paymentId);
  assertPaymentAccess(payment, actor);
  const receipt = await getReceiptDisplayData(paymentId);
  if (!receipt) {
    throw new ApiError(404, "Receipt not found.");
  }

  return {
    payment: await getPaymentDetail(paymentId, actor),
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

    if (isSchemeFinanciallyLocked(scheme)) {
      throw new ApiError(409, "Scheme is already settled.", [], {
        code: ERROR_CODES.SCHEME_ALREADY_SETTLED,
        retryable: false,
      });
    }

    await Scheme.findByIdAndUpdate(
      scheme._id,
      { $inc: { financialVersion: 1 } },
      { session }
    );

    const { entries, latestByPayment } = await loadSchemeLedgerContext(scheme._id, session);
    const latestCorrection = latestByPayment.get(String(payment._id)) || null;
    const currentLedger = getEffectiveLedgerFields(payment, latestCorrection);
    if (!currentLedger) {
      throw new ApiError(409, "Payment is already effectively reversed.", [], {
        code: ERROR_CODES.PAYMENT_ALREADY_REVERSED,
        retryable: false,
      });
    }

    const proposedEntries = entries.filter(
      (entry) => String(entry.paymentId) !== String(payment._id)
    );
    try {
      assertLedgerEntriesValid(scheme, proposedEntries);
    } catch (error) {
      if (error.code === ERROR_CODES.PAYMENT_LIMIT_EXCEEDED) {
        throw new ApiError(
          409,
          "Reversing this payment would break the later-period payment cap.",
          [],
          {
            code: ERROR_CODES.REVERSAL_BREAKS_PAYMENT_CAP,
            retryable: false,
          }
        );
      }
      throw error;
    }

    if (
      currentLedger.paymentMethod === PAYMENT_METHODS.CASH &&
      payment.collectedByRole === USER_ROLES.STAFF
    ) {
      await lockStaffCashProfile(payment.collectedBy, session);
      await assertStaffCashInHandSufficient(payment.collectedBy, currentLedger.amount, session);
    }

    const previousStatus = payment.status;
    payment.status = PAYMENT_STATUS.REVERSED;
    payment.notes = payload.notes?.trim() || reason;
    await payment.save({ session });

    await recordCollectionReversal(
      {
        payment,
        actor,
        clientRequestId: payload.clientRequestId,
        effectiveAmount: currentLedger.amount,
        effectiveMethod: currentLedger.paymentMethod,
      },
      session
    );

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
        effectiveAmount: currentLedger.amount,
        effectivePaymentMethod: currentLedger.paymentMethod,
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

    const customer = await Customer.findById(payment.customer).session(session);
    if (customer?.user) {
      await enqueueOutboxEvent(
        {
          topic: OUTBOX_TOPICS.PAYMENT_REVERSED,
          dedupeKey: `payment-reversed:${payment._id}`,
          payload: {
            recipient: customer.user,
            type: NOTIFICATION_TYPES.PAYMENT_REVERSED,
            title: "Payment Reversed",
            message: `Your payment of ₹${currentLedger.amount.toLocaleString("en-IN")} (${payment.receiptNumber}) has been reversed. Please contact your AJ Gold advisor for details.`,
            data: {
              paymentId: payment._id,
              amount: currentLedger.amount,
              receiptNumber: payment.receiptNumber,
            },
          },
        },
        session
      );
    }

    return { replay: false, response };
  });

  const paymentRef = txnResult.replay ? txnResult.response.paymentId : txnResult.response.paymentId;
  const [updatedPayment, schemeSummary] = await Promise.all([
    getPaymentByIdOrThrow(paymentRef),
    getSchemeLimitSummary(
      txnResult.replay ? txnResult.response.schemeId : txnResult.response.schemeId
    ),
  ]);

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
