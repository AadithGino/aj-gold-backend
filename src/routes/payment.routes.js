const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  staffPermissionMiddleware,
  adminOnlyMiddleware,
} = require("../middleware/staffPermission.middleware");
const {
  collectPaymentHandler,
  listPaymentsHandler,
  getPaymentDetailHandler,
  getPaymentReceiptHandler,
  reversePaymentHandler,
} = require("../controllers/payment.controller");
const { createCorrectionHandler } = require("../controllers/correction.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(adminOrStaffMiddleware);

router.post("/", staffPermissionMiddleware("canCollectPayment"), collectPaymentHandler);
router.get("/", listPaymentsHandler);
router.get("/:paymentId", getPaymentDetailHandler);
router.get("/:paymentId/receipt", getPaymentReceiptHandler);
router.post("/:paymentId/correction-request", createCorrectionHandler);
router.post("/:paymentId/corrections", createCorrectionHandler);
router.patch("/:paymentId/reverse", adminOnlyMiddleware, reversePaymentHandler);

module.exports = router;
