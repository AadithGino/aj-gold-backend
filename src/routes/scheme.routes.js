const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  staffPermissionMiddleware,
  adminOnlyMiddleware,
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
  adminOnlyMiddleware,
  previewSettlementHandler
);
router.get(
  "/:schemeId/settlement/detail",
  adminOnlyMiddleware,
  getSettlementDetailHandler
);
router.get(
  "/:schemeId",
  adminOnlyMiddleware,
  getSchemeHandler
);
router.patch("/:schemeId/status", adminOnlyMiddleware, updateSchemeStatusHandler);

module.exports = router;
