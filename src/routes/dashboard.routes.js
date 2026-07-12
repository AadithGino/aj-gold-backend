const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const { USER_ROLES } = require("../constants/enums");
const {
  adminDashboardHandler,
  staffDashboardHandler,
  staffCashSubmissionsHandler,
  staffRedemptionHistoryHandler,
  customerDashboardHandler,
  roleProfileHandler,
} = require("../controllers/dashboard.controller");
const { createStaffCashSubmissionHandler } = require("../controllers/staff.cashSubmission.controller");
const ApiError = require("../utils/ApiError");

const router = express.Router();

router.use(authMiddleware);

router.get("/profile",  roleProfileHandler);
router.get("/admin",    (req, res, next) => {
  if (req.user.role !== USER_ROLES.ADMIN) return next(new ApiError(403, "Admin only."));
  adminDashboardHandler(req, res, next);
});
router.get("/staff",    (req, res, next) => {
  if (![USER_ROLES.ADMIN, USER_ROLES.STAFF].includes(req.user.role)) return next(new ApiError(403, "Staff/Admin only."));
  staffDashboardHandler(req, res, next);
});
router.get("/staff/cash-submissions", (req, res, next) => {
  if (![USER_ROLES.ADMIN, USER_ROLES.STAFF].includes(req.user.role)) return next(new ApiError(403, "Staff/Admin only."));
  staffCashSubmissionsHandler(req, res, next);
});
router.post("/staff/cash-submissions", (req, res, next) => {
  if (req.user.role !== USER_ROLES.STAFF) return next(new ApiError(403, "Staff only."));
  createStaffCashSubmissionHandler(req, res, next);
});
router.get("/staff/redemptions", (req, res, next) => {
  if (![USER_ROLES.ADMIN, USER_ROLES.STAFF].includes(req.user.role)) return next(new ApiError(403, "Staff/Admin only."));
  staffRedemptionHistoryHandler(req, res, next);
});
router.get("/customer", (req, res, next) => {
  if (req.user.role !== USER_ROLES.CUSTOMER) return next(new ApiError(403, "Customer only."));
  customerDashboardHandler(req, res, next);
});
module.exports = router;
