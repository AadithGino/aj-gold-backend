const { buildReconciliationSummary } = require("../services/reconciliation.service");
const FinancialJournal = require("../models/financialJournal.model");
const AuditLog = require("../models/auditLog.model");
const IdempotencyRecord = require("../models/idempotencyRecord.model");
const OutboxEvent = require("../models/outboxEvent.model");
const Scheme = require("../models/scheme.model");
const ApiError = require("../utils/ApiError");
const { parseCursorPagination, buildCursorPage } = require("../utils/pagination");
const { buildSafeRegexFilter } = require("../utils/safeSearch");
const { getSettlementDetail } = require("../services/settlement.service");

const listJournalEntries = async (query = {}) => {
  const { limit, cursor } = parseCursorPagination(query, { maxLimit: 200 });
  const filter = {};
  if (query.schemeId) filter.scheme = query.schemeId;
  if (query.customerId) filter.customer = query.customerId;
  if (query.eventType) filter.eventType = query.eventType;

  if (cursor?.effectiveAt && cursor?.entryId) {
    filter.$or = [
      { effectiveAt: { $lt: new Date(cursor.effectiveAt) } },
      {
        effectiveAt: new Date(cursor.effectiveAt),
        entryId: { $lt: cursor.entryId },
      },
    ];
  }

  const rows = await FinancialJournal.find(filter)
    .sort({ effectiveAt: -1, entryId: -1 })
    .limit(limit + 1)
    .lean();

  return buildCursorPage(rows, {
    limit,
    getCursorValue: (row) => ({
      effectiveAt: row.effectiveAt,
      entryId: row.entryId,
    }),
  });
};

const listAuditLogs = async (query = {}) => {
  const { limit, cursor } = parseCursorPagination(query, { maxLimit: 200 });
  const filter = {};
  if (query.action) filter.action = query.action;
  if (query.targetType) filter.targetType = query.targetType;
  if (query.actorId) filter.actor = query.actorId;

  const searchFilter = buildSafeRegexFilter("notes", query.search, { label: "search" });
  if (searchFilter) {
    Object.assign(filter, searchFilter);
  }

  if (cursor?.createdAt && cursor?._id) {
    filter.$or = [
      { createdAt: { $lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), _id: { $lt: cursor._id } },
    ];
  }

  const rows = await AuditLog.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  return buildCursorPage(rows, {
    limit,
    getCursorValue: (row) => ({ createdAt: row.createdAt, _id: row._id }),
  });
};

const listIdempotencyRecords = async (query = {}) => {
  const { limit, cursor } = parseCursorPagination(query, { maxLimit: 100 });
  const filter = {};
  if (query.operationType) filter.operationType = query.operationType;
  if (query.clientRequestId) filter.clientRequestId = query.clientRequestId;

  if (cursor?.createdAt && cursor?._id) {
    filter.$or = [
      { createdAt: { $lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), _id: { $lt: cursor._id } },
    ];
  }

  const rows = await IdempotencyRecord.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  return buildCursorPage(rows, {
    limit,
    getCursorValue: (row) => ({ createdAt: row.createdAt, _id: row._id }),
  });
};

const listOutboxEvents = async (query = {}) => {
  const { limit, cursor } = parseCursorPagination(query, { maxLimit: 100 });
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.topic) filter.topic = query.topic;

  if (cursor?.createdAt && cursor?._id) {
    filter.$or = [
      { createdAt: { $lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), _id: { $lt: cursor._id } },
    ];
  }

  const rows = await OutboxEvent.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  return buildCursorPage(rows, {
    limit,
    getCursorValue: (row) => ({ createdAt: row.createdAt, _id: row._id }),
  });
};

const getIntegritySummary = async () => {
  const reconciliation = await buildReconciliationSummary();
  const [pendingOutbox, failedOutbox, pendingSettlements] = await Promise.all([
    OutboxEvent.countDocuments({ status: "PENDING" }),
    OutboxEvent.countDocuments({ status: "FAILED" }),
    Scheme.countDocuments({
      "settlementWorkflow.status": { $in: ["APPROVED", "PAYOUT_PENDING", "PAID"] },
    }),
  ]);

  return {
    reconciliation,
    outbox: { pending: pendingOutbox, failed: failedOutbox },
    settlementsInProgress: pendingSettlements,
    timezone: "Asia/Kolkata",
    weekStartsOn: "Monday (ISO)",
  };
};

module.exports = {
  listJournalEntries,
  listAuditLogs,
  listIdempotencyRecords,
  listOutboxEvents,
  getIntegritySummary,
  getSettlementDetail,
};
