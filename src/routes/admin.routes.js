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
} = require("../controllers/admin.cashSubmission.controller");

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
router.get("/cash-submissions", listCashSubmissionsHandler);

module.exports = router;
