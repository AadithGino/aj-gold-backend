const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
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

router.get("/collections", collectionsHandler);
router.get("/staff-performance", staffPerformanceHandler);
router.get("/cash-position", cashPositionHandler);
router.get("/schemes", schemesHandler);
router.get("/maturity-calendar", maturityCalendarHandler);
router.get("/customer-ledger/:customerId", customerLedgerHandler);
router.get("/scheme-ledger/:schemeId", schemeLedgerHandler);

module.exports = router;
