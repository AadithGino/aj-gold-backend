const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOnlyMiddleware,
  staffPermissionMiddleware,
} = require("../middleware/staffPermission.middleware");
const {
  createPayoutHandler,
  listPayoutsHandler,
  getPayoutHandler,
  reversePayoutHandler,
} = require("../controllers/payout.controller");

const router = express.Router();

router.use(authMiddleware);

router.post("/", staffPermissionMiddleware("canCollectPayment"), createPayoutHandler);

router.use(adminOnlyMiddleware);

router.get("/", listPayoutsHandler);
router.get("/:payoutId", getPayoutHandler);
router.post("/:payoutId/reverse", reversePayoutHandler);

module.exports = router;
