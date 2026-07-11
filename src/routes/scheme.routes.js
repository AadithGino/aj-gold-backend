const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  staffPermissionMiddleware,
} = require("../middleware/staffPermission.middleware");
const {
  createSchemeHandler,
  getSchemeHandler,
  updateSchemeStatusHandler,
} = require("../controllers/scheme.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(adminOrStaffMiddleware);

router.post("/", staffPermissionMiddleware("canCreateCustomer"), createSchemeHandler);
router.get("/:schemeId", getSchemeHandler);
router.patch("/:schemeId/status", updateSchemeStatusHandler);

module.exports = router;
