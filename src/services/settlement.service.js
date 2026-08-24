const Scheme = require("../models/scheme.model");
const StaffProfile = require("../models/staffProfile.model");
const {
  SCHEME_STATUS,
  USER_ROLES,
  PAYMENT_METHODS,
  SETTLEMENT_WORKFLOW_STATUS,
  JOURNAL_EVENT_TYPES,
  AUDIT_ACTIONS,
  IDEMPOTENCY_OPERATIONS,
} = require("../constants/enums");
const { JOURNAL_ACCOUNTS } = require("../constants/journalAccounts");
const { SETTLEMENT_CONTRACT, ALLOWED_SETTLEMENT_PAYOUT_METHODS } = require("../constants/settlementContract");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const { hasStaffPermission } = require("../constants/staffPermissions");
const { withTransaction } = require("../utils/transaction");
const { isSchemeSettled, isSchemeFinanciallyLocked } = require("../utils/scheme");
const { generateSettlementReceiptNumber } = require("./receipt.service");
const { logAudit } = require("./audit.service");
const { enrichScheme } = require("./customer.service");
const { appendStatusHistory } = require("./scheme.service");
const { getTotalPaidForScheme } = require("./paymentLimit.service");
const { computeEntitlement } = require("./entitlement.service");
const {
  appendJournalEntry,
  getJournalEntriesForScheme,
} = require("./financialJournal.service");
const {
  checkIdempotencyReplay,
  saveIdempotencyResult,
} = require("./idempotency.service");

const auditActionForStatus = {
  [SCHEME_STATUS.REDEEMED]: AUDIT_ACTIONS.SCHEME_REDEEMED,
  [SCHEME_STATUS.CLOSED]: AUDIT_ACTIONS.SCHEME_CLOSED,
};

const plainWorkflow = (workflow) =>
  workflow?.toObject ? workflow.toObject() : { ...(workflow || {}) };

const LOCKED_WORKFLOW_STATUSES = new Set([
  SETTLEMENT_WORKFLOW_STATUS.APPROVED,
  SETTLEMENT_WORKFLOW_STATUS.PAYOUT_PENDING,
  SETTLEMENT_WORKFLOW_STATUS.PAID,
  SETTLEMENT_WORKFLOW_STATUS.FINALIZED,
]);

const assertSettlementActorAllowed = async (actor, settlementType) => {
  if (actor.role === USER_ROLES.ADMIN) {
    return;
  }

  if (actor.role !== USER_ROLES.STAFF) {
    throw new ApiError(403, "Only admin or authorized staff can settle schemes.");
  }

  const profile = await StaffProfile.findOne({ user: actor._id });
  if (!profile) {
    throw new ApiError(403, "Staff profile not found.");
  }

  if (!hasStaffPermission(profile, "canFinalizeSettlement")) {
    throw new ApiError(403, "Staff does not have settlement finalization permission.");
  }

  if (settlementType === SCHEME_STATUS.REDEEMED && !hasStaffPermission(profile, "canMarkRedeemed")) {
    throw new ApiError(403, "Staff does not have redeem permission.");
  }
  if (settlementType === SCHEME_STATUS.CLOSED && !hasStaffPermission(profile, "canMarkClosed")) {
    throw new ApiError(403, "Staff does not have early closure permission.");
  }
};

const assertPayoutPayload = (payload) => {
  const payoutMethod = payload.payoutMethod;
  if (!ALLOWED_SETTLEMENT_PAYOUT_METHODS.includes(payoutMethod)) {
    throw new ApiError(400, "Settlement payout method must be CASH, UPI, or BANK.", [], {
      code: ERROR_CODES.SETTLEMENT_PAYOUT_METHOD_INVALID,
      retryable: false,
    });
  }

  const payoutReference = payload.payoutReference?.trim() || "";
  return { payoutMethod, payoutReference };
};

const settlementCategoryForType = (settlementType) =>
  settlementType === SCHEME_STATUS.CLOSED ? "early_closure" : "maturity";

const assertSettlementEligibility = (scheme, settlementType) => {
  const now = new Date();
  if (settlementType === SCHEME_STATUS.REDEEMED && now < new Date(scheme.maturityDate)) {
    throw new ApiError(400, "Scheme can be redeemed only after maturity date.", [], {
      code: ERROR_CODES.SETTLEMENT_NOT_ELIGIBLE,
      retryable: false,
    });
  }
  if (settlementType === SCHEME_STATUS.CLOSED && now >= new Date(scheme.maturityDate)) {
    throw new ApiError(400, "After maturity date use REDEEMED status.", [], {
      code: ERROR_CODES.SETTLEMENT_NOT_ELIGIBLE,
      retryable: false,
    });
  }
  if (!SETTLEMENT_CONTRACT.earlyClosureAllowed && settlementType === SCHEME_STATUS.CLOSED) {
    throw new ApiError(400, "Early closure is not allowed.", [], {
      code: ERROR_CODES.SETTLEMENT_NOT_ELIGIBLE,
      retryable: false,
    });
  }
};

const writeSettlementJournalEntries = async ({
  scheme,
  customerId,
  entitlement,
  payout,
  actor,
  clientRequestId,
  session,
}) => {
  const journalEntryIds = [];
  const baseKey = `scheme:${scheme._id}`;

  const entitlementEntry = await appendJournalEntry(
    {
      businessKey: `${baseKey}:entitlement:${clientRequestId}`,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_ENTITLEMENT_RECOGNIZED,
      amount: entitlement.finalEntitlement,
      debitAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
      creditAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
      customer: customerId,
      scheme: scheme._id,
      sourceRecordType: "Scheme",
      sourceRecordId: scheme._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: new Date(),
      formulaVersion: entitlement.formulaVersion,
      inputSnapshot: entitlement.inputSnapshot,
      metadata: { settlementType: payout.settlementType },
    },
    session
  );
  journalEntryIds.push(entitlementEntry._id);

  const authorizedEntry = await appendJournalEntry(
    {
      businessKey: `${baseKey}:authorized:${clientRequestId}`,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_AUTHORIZED,
      amount: entitlement.finalEntitlement,
      debitAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
      creditAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
      customer: customerId,
      scheme: scheme._id,
      sourceRecordType: "Scheme",
      sourceRecordId: scheme._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: new Date(),
      formulaVersion: entitlement.formulaVersion,
      metadata: { settlementType: payout.settlementType },
    },
    session
  );
  journalEntryIds.push(authorizedEntry._id);

  const paidEntry = await appendJournalEntry(
    {
      businessKey: `${baseKey}:paid:${clientRequestId}`,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
      amount: entitlement.finalEntitlement,
      debitAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
      creditAccount: JOURNAL_ACCOUNTS.VAULT,
      customer: customerId,
      scheme: scheme._id,
      sourceRecordType: "Scheme",
      sourceRecordId: scheme._id,
      actor: actor._id,
      actorRole: actor.role,
      clientRequestId,
      effectiveAt: new Date(),
      formulaVersion: entitlement.formulaVersion,
      metadata: {
        settlementType: payout.settlementType,
        payoutMethod: payout.payoutMethod,
        payoutReference: payout.payoutReference,
        payoutEvidence: payout.payoutEvidence || null,
      },
    },
    session
  );
  journalEntryIds.push(paidEntry._id);

  return journalEntryIds;
};

const previewEntitlement = async (schemeId) => {
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }
  const entitlement = await computeEntitlement(schemeId);
  return {
    schemeId: scheme._id,
    enrollmentNumber: scheme.enrollmentNumber,
    status: scheme.status,
    ...entitlement,
  };
};

const getSettlementDetail = async (schemeId) => {
  const scheme = await Scheme.findById(schemeId).lean();
  if (!scheme) {
    throw new ApiError(404, "Scheme not found.");
  }

  const [entitlement, journalEntries] = await Promise.all([
    computeEntitlement(schemeId),
    getJournalEntriesForScheme(schemeId),
  ]);

  return {
    schemeId: scheme._id,
    enrollmentNumber: scheme.enrollmentNumber,
    status: scheme.status,
    settlement: scheme.settlement || null,
    settlementWorkflow: scheme.settlementWorkflow || null,
    entitlement,
    contract: SETTLEMENT_CONTRACT,
    journalEntries,
  };
};

const authorizeSettlement = async (schemeId, payload, actor, session) => {
  const scheme = await Scheme.findOne({
    _id: schemeId,
    status: SCHEME_STATUS.ACTIVE,
  }).session(session);

  if (!scheme) {
    const existing = await Scheme.findById(schemeId).session(session);
    if (existing && (isSchemeSettled(existing) || isSchemeFinanciallyLocked(existing))) {
      throw new ApiError(409, "Scheme is already settled.", [], {
        code: ERROR_CODES.SCHEME_ALREADY_SETTLED,
        retryable: false,
      });
    }
    throw new ApiError(409, "Scheme must be ACTIVE to settle.");
  }

  if (scheme.settlementWorkflow?.status && LOCKED_WORKFLOW_STATUSES.has(scheme.settlementWorkflow.status)) {
    throw new ApiError(409, "Settlement is already in progress.", [], {
      code: ERROR_CODES.SETTLEMENT_INVALID_STATE,
      retryable: false,
    });
  }

  assertSettlementEligibility(scheme, payload.status);
  const entitlement = await computeEntitlement(scheme._id, session);

  if (entitlement.finalEntitlement <= 0) {
    throw new ApiError(400, "No eligible contributions to settle.", [], {
      code: ERROR_CODES.SETTLEMENT_NOT_ELIGIBLE,
      retryable: false,
    });
  }

  const now = new Date();
  scheme.settlementWorkflow = {
    status: SETTLEMENT_WORKFLOW_STATUS.APPROVED,
    settlementType: payload.status,
    entitlementAmount: entitlement.finalEntitlement,
    formulaVersion: entitlement.formulaVersion,
    inputSnapshot: entitlement.inputSnapshot,
    requestedAt: now,
    requestedBy: actor._id,
    approvedAt: now,
    approvedBy: actor._id,
    notes: payload.notes?.trim() || "",
    clientRequestId: payload.clientRequestId,
    journalEntryIds: [],
  };
  scheme.updatedBy = actor._id;
  scheme.financialVersion = (scheme.financialVersion || 0) + 1;
  await scheme.save({ session });

  return { scheme, entitlement };
};

const recordSettlementPayout = async (schemeId, payload, actor, session) => {
  const scheme = await Scheme.findOne({
    _id: schemeId,
    status: SCHEME_STATUS.ACTIVE,
  }).session(session);

  if (!scheme?.settlementWorkflow) {
    throw new ApiError(409, "Settlement must be authorized before payout.", [], {
      code: ERROR_CODES.SETTLEMENT_INVALID_STATE,
      retryable: false,
    });
  }

  const workflow = scheme.settlementWorkflow;
  if (![SETTLEMENT_WORKFLOW_STATUS.APPROVED, SETTLEMENT_WORKFLOW_STATUS.PAYOUT_PENDING].includes(workflow.status)) {
    if (workflow.status === SETTLEMENT_WORKFLOW_STATUS.PAID || workflow.status === SETTLEMENT_WORKFLOW_STATUS.FINALIZED) {
      return { scheme, alreadyPaid: true };
    }
    throw new ApiError(409, "Settlement is not ready for payout.", [], {
      code: ERROR_CODES.SETTLEMENT_INVALID_STATE,
      retryable: false,
    });
  }

  const payout = assertPayoutPayload(payload);
  const entitlement = await computeEntitlement(scheme._id, session);

  if (entitlement.finalEntitlement !== workflow.entitlementAmount) {
    throw new ApiError(409, "Entitlement changed since authorization.", [], {
      code: ERROR_CODES.SETTLEMENT_ENTITLEMENT_MISMATCH,
      retryable: false,
    });
  }

  const journalEntryIds = await writeSettlementJournalEntries({
    scheme,
    customerId: scheme.customer,
    entitlement,
    payout: {
      settlementType: workflow.settlementType,
      payoutMethod: payout.payoutMethod,
      payoutReference: payout.payoutReference,
      payoutEvidence: payload.payoutEvidence || null,
    },
    actor,
    clientRequestId: payload.clientRequestId,
    session,
  });

  const now = new Date();
  scheme.settlementWorkflow = {
    ...plainWorkflow(workflow),
    status: SETTLEMENT_WORKFLOW_STATUS.PAID,
    payoutPendingAt: workflow.payoutPendingAt || now,
    paidAt: now,
    paidBy: actor._id,
    payoutMethod: payout.payoutMethod,
    payoutReference: payout.payoutReference,
    payoutEvidence: payload.payoutEvidence || { objectRef: "", checksum: "" },
    journalEntryIds,
  };
  scheme.updatedBy = actor._id;
  await scheme.save({ session });

  return { scheme, entitlement, journalEntryIds };
};

const finalizeSettlement = async (schemeId, payload, actor, session) => {
  const scheme = await Scheme.findOne({
    _id: schemeId,
    status: SCHEME_STATUS.ACTIVE,
  }).session(session);

  if (!scheme?.settlementWorkflow) {
    throw new ApiError(409, "Settlement workflow not found.", [], {
      code: ERROR_CODES.SETTLEMENT_INVALID_STATE,
      retryable: false,
    });
  }

  const workflow = scheme.settlementWorkflow;
  if (workflow.status === SETTLEMENT_WORKFLOW_STATUS.FINALIZED) {
    return { scheme, alreadyFinalized: true };
  }

  if (workflow.status !== SETTLEMENT_WORKFLOW_STATUS.PAID) {
    throw new ApiError(409, "Settlement payout must be recorded before finalization.", [], {
      code: ERROR_CODES.SETTLEMENT_INVALID_STATE,
      retryable: false,
    });
  }

  const entitlement = await computeEntitlement(scheme._id, session);
  if (entitlement.finalEntitlement !== workflow.entitlementAmount) {
    throw new ApiError(409, "Entitlement changed since payout.", [], {
      code: ERROR_CODES.SETTLEMENT_ENTITLEMENT_MISMATCH,
      retryable: false,
    });
  }

  const settlementType = workflow.settlementType;
  const totalPaidAtSettlement = await getTotalPaidForScheme(scheme._id, session);
  const now = new Date();
  const settlementReceiptId = await generateSettlementReceiptNumber(now, session);

  appendStatusHistory(scheme, {
    status: settlementType,
    changedBy: actor._id,
    changedByRole: actor.role,
    notes: workflow.notes || payload.notes?.trim() || "",
  });

  scheme.status = settlementType;
  scheme.settlement = {
    amount: workflow.entitlementAmount,
    settledAt: now,
    settledBy: actor._id,
    notes: workflow.notes || payload.notes?.trim() || "",
    clientRequestId: payload.clientRequestId || workflow.clientRequestId,
    formulaVersion: workflow.formulaVersion,
    totalPaidAtSettlement,
    payoutMethod: workflow.payoutMethod,
    payoutReference: workflow.payoutReference,
    settlementReceiptId,
    settlementCategory: settlementCategoryForType(settlementType),
  };
  scheme.settlementWorkflow = {
    ...plainWorkflow(workflow),
    status: SETTLEMENT_WORKFLOW_STATUS.FINALIZED,
    finalizedAt: now,
    finalizedBy: actor._id,
  };
  scheme.updatedBy = actor._id;
  scheme.financialVersion = (scheme.financialVersion || 0) + 1;
  await scheme.save({ session });

  await logAudit({
    actor: actor._id,
    actorRole: actor.role,
    action: auditActionForStatus[settlementType],
    targetType: "Scheme",
    targetId: scheme._id,
    newValue: {
      status: settlementType,
      entitlementAmount: workflow.entitlementAmount,
      formulaVersion: workflow.formulaVersion,
      payoutMethod: workflow.payoutMethod,
      payoutReference: workflow.payoutReference,
      settlementReceiptId,
      clientRequestId: payload.clientRequestId || workflow.clientRequestId,
    },
    notes: `Scheme settlement finalized as ${settlementType}`,
    session,
  });

  return { scheme, entitlement };
};

const completeSettlement = async (schemeId, payload, actor) => {
  if (payload.settlementAmount !== undefined) {
    throw new ApiError(400, "settlementAmount is not allowed; entitlement is server-computed.", [], {
      code: ERROR_CODES.SETTLEMENT_AMOUNT_NOT_ALLOWED,
      retryable: false,
    });
  }

  await assertSettlementActorAllowed(actor, payload.status);

  const trimmedNotes = payload.notes?.trim();
  if (!trimmedNotes) {
    throw new ApiError(400, "Notes are required for this status change.");
  }

  const payout = assertPayoutPayload(payload);
  const clientRequestId = payload.clientRequestId;

  const idempotencyPayload = {
    schemeId,
    status: payload.status,
    notes: trimmedNotes,
    payoutMethod: payout.payoutMethod,
    payoutReference: payout.payoutReference,
  };

  const txnResult = await withTransaction(async (session) => {
    const replay = await checkIdempotencyReplay({
      clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.SCHEME_SETTLEMENT,
      requestPayload: idempotencyPayload,
      session,
    });
    if (replay.replay) {
      return { replay: true, response: replay.response };
    }

    await authorizeSettlement(
      schemeId,
      { status: payload.status, notes: trimmedNotes, clientRequestId },
      actor,
      session
    );

    await recordSettlementPayout(
      schemeId,
      {
        payoutMethod: payout.payoutMethod,
        payoutReference: payout.payoutReference,
        payoutEvidence: payload.payoutEvidence,
        clientRequestId,
      },
      actor,
      session
    );

    const { scheme } = await finalizeSettlement(
      schemeId,
      { notes: trimmedNotes, clientRequestId },
      actor,
      session
    );

    const response = { schemeId: scheme._id };

    await saveIdempotencyResult({
      clientRequestId: replay.clientRequestId,
      operationType: IDEMPOTENCY_OPERATIONS.SCHEME_SETTLEMENT,
      requestHash: replay.requestHash,
      responsePayload: response,
      actor,
      resourceType: "Scheme",
      resourceId: scheme._id,
      session,
    });

    return { replay: false, schemeId: scheme._id };
  });

  const resolvedSchemeId = txnResult.replay ? txnResult.response.schemeId : txnResult.schemeId;
  const scheme = await Scheme.findById(resolvedSchemeId);
  return enrichScheme(scheme);
};

module.exports = {
  previewEntitlement,
  getSettlementDetail,
  authorizeSettlement,
  recordSettlementPayout,
  finalizeSettlement,
  completeSettlement,
};
