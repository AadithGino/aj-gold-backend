const asyncHandler = require("../utils/asyncHandler");
const {
  listJournalEntries,
  listAuditLogs,
  listIdempotencyRecords,
  listOutboxEvents,
  getIntegritySummary,
  getSettlementDetail,
} = require("../services/adminOversight.service");
const { buildReconciliationSummary } = require("../services/reconciliation.service");

const getIntegritySummaryHandler = asyncHandler(async (req, res) =>
  res.status(200).json({ success: true, data: await getIntegritySummary() })
);

const listJournalEntriesHandler = asyncHandler(async (req, res) =>
  res.status(200).json({ success: true, data: await listJournalEntries(req.query) })
);

const listAuditLogsHandler = asyncHandler(async (req, res) =>
  res.status(200).json({ success: true, data: await listAuditLogs(req.query) })
);

const listIdempotencyRecordsHandler = asyncHandler(async (req, res) =>
  res.status(200).json({ success: true, data: await listIdempotencyRecords(req.query) })
);

const listOutboxEventsHandler = asyncHandler(async (req, res) =>
  res.status(200).json({ success: true, data: await listOutboxEvents(req.query) })
);

const getReconciliationExceptionsHandler = asyncHandler(async (req, res) => {
  const summary = await buildReconciliationSummary();
  return res.status(200).json({
    success: true,
    data: {
      exceptions: summary.exceptions,
      equation: summary.equation,
      accounts: summary.accounts,
      flows: summary.flows,
    },
  });
});

const getAdminSettlementDetailHandler = asyncHandler(async (req, res) =>
  res.status(200).json({
    success: true,
    data: await getSettlementDetail(req.params.schemeId),
  })
);

module.exports = {
  getIntegritySummaryHandler,
  listJournalEntriesHandler,
  listAuditLogsHandler,
  listIdempotencyRecordsHandler,
  listOutboxEventsHandler,
  getReconciliationExceptionsHandler,
  getAdminSettlementDetailHandler,
};
