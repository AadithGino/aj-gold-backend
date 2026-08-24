const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  staffPermissionMiddleware,
  staffPermissionAnyMiddleware,
} = require("../middleware/staffPermission.middleware");
const {
  createSchemeHandler,
  getSchemeHandler,
  updateSchemeStatusHandler,
  previewSettlementHandler,
  getSettlementDetailHandler,
} = require("../controllers/scheme.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(adminOrStaffMiddleware);

router.post("/", staffPermissionMiddleware("canCreateCustomer"), createSchemeHandler);
router.get(
  "/:schemeId/settlement/preview",
  staffPermissionAnyMiddleware(["canFinalizeSettlement", "canMarkRedeemed", "canMarkClosed"]),
  previewSettlementHandler
);
router.get(
  "/:schemeId/settlement/detail",
  staffPermissionAnyMiddleware(["canFinalizeSettlement", "canMarkRedeemed", "canMarkClosed"]),
  getSettlementDetailHandler
);
router.get(
  "/:schemeId",
  staffPermissionAnyMiddleware(["canFinalizeSettlement", "canMarkRedeemed", "canMarkClosed"]),
  getSchemeHandler
);
router.patch("/:schemeId/status", updateSchemeStatusHandler);

module.exports = router;
