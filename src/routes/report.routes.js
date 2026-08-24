const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  staffPermissionMiddleware,
} = require("../middleware/staffPermission.middleware");
const {
  collectionsHandler,
  staffPerformanceHandler,
  cashPositionHandler,
  schemesHandler,
  maturityCalendarHandler,
  customerLedgerHandler,
  schemeLedgerHandler,
} = require("../controllers/report.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(adminOrStaffMiddleware);

router.get("/collections", staffPermissionMiddleware("canViewReports"), collectionsHandler);
router.get("/staff-performance", staffPermissionMiddleware("canViewReports"), staffPerformanceHandler);
router.get("/cash-position", staffPermissionMiddleware("canViewReports"), cashPositionHandler);
router.get("/schemes", staffPermissionMiddleware("canViewReports"), schemesHandler);
router.get("/maturity-calendar", staffPermissionMiddleware("canViewReports"), maturityCalendarHandler);
router.get("/customer-ledger/:customerId", staffPermissionMiddleware("canViewReports"), customerLedgerHandler);
router.get("/scheme-ledger/:schemeId", staffPermissionMiddleware("canViewReports"), schemeLedgerHandler);

module.exports = router;
