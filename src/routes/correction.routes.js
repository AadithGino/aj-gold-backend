const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const { adminOrStaffMiddleware, adminOnlyMiddleware } = require("../middleware/staffPermission.middleware");
const { USER_ROLES } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const {
  listCorrectionsHandler,
  getCorrectionHandler,
  approveCorrectionHandler,
  rejectCorrectionHandler,
} = require("../controllers/correction.controller");

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (req.user.role === USER_ROLES.CUSTOMER) {
    return next(new ApiError(403, "Customers cannot access corrections."));
  }
  next();
});
router.use(adminOrStaffMiddleware);

router.get("/", listCorrectionsHandler);
router.get("/:correctionId", getCorrectionHandler);
router.post("/:correctionId/approve", adminOnlyMiddleware, approveCorrectionHandler);
router.post("/:correctionId/reject", adminOnlyMiddleware, rejectCorrectionHandler);

module.exports = router;
