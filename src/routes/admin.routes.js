const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const { USER_ROLES } = require("../constants/enums");
const {
  createStaffHandler,
  listStaffHandler,
  getStaffHandler,
  updateStaffHandler,
  updateStaffStatusHandler,
  getStaffCashSummaryHandler,
  getStaffRedeemedClosedHistoryHandler,
} = require("../controllers/admin.staff.controller");
const {
  createCashSubmissionHandler,
  listCashSubmissionsHandler,
  reverseCashSubmissionHandler,
} = require("../controllers/admin.cashSubmission.controller");
const {
  getIntegritySummaryHandler,
  listJournalEntriesHandler,
  listAuditLogsHandler,
  listIdempotencyRecordsHandler,
  listOutboxEventsHandler,
  getReconciliationExceptionsHandler,
  getAdminSettlementDetailHandler,
} = require("../controllers/admin.oversight.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(roleMiddleware(USER_ROLES.ADMIN));

router.post("/staff", createStaffHandler);
router.get("/staff", listStaffHandler);
router.get("/staff/:staffId/cash-summary", getStaffCashSummaryHandler);
router.get("/staff/:staffId/redeemed-closed-history", getStaffRedeemedClosedHistoryHandler);
router.get("/staff/:staffId", getStaffHandler);
router.patch("/staff/:staffId/status", updateStaffStatusHandler);
router.patch("/staff/:staffId", updateStaffHandler);

router.post("/cash-submissions", createCashSubmissionHandler);
router.post("/cash-submissions/:submissionId/reverse", reverseCashSubmissionHandler);
router.get("/cash-submissions", listCashSubmissionsHandler);

router.get("/integrity-summary", getIntegritySummaryHandler);
router.get("/reconciliation/exceptions", getReconciliationExceptionsHandler);
router.get("/journal", listJournalEntriesHandler);
router.get("/audit-logs", listAuditLogsHandler);
router.get("/idempotency-records", listIdempotencyRecordsHandler);
router.get("/outbox-events", listOutboxEventsHandler);
router.get("/schemes/:schemeId/settlement", getAdminSettlementDetailHandler);

module.exports = router;
