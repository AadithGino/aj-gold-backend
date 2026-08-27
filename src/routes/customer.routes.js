const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  adminOnlyMiddleware,
  staffPermissionMiddleware,
  staffPermissionAnyMiddleware,
} = require("../middleware/staffPermission.middleware");
const { CUSTOMER_LOOKUP_PERMISSIONS } = require("../constants/staffPermissions");
const {
  createCustomerHandler,
  listCustomersHandler,
  getCustomerHandler,
  updateCustomerHandler,
  resetCustomerPasswordHandler,
  getCustomerSchemesHandler,
  getCustomerRedemptionsHandler,
} = require("../controllers/customer.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(adminOrStaffMiddleware);

router.get("/", staffPermissionAnyMiddleware(CUSTOMER_LOOKUP_PERMISSIONS), listCustomersHandler);
router.get(
  "/:customerId/schemes",
  staffPermissionAnyMiddleware(CUSTOMER_LOOKUP_PERMISSIONS),
  getCustomerSchemesHandler
);
router.get("/:customerId/redemptions", adminOnlyMiddleware, getCustomerRedemptionsHandler);
router.get(
  "/:customerId",
  staffPermissionAnyMiddleware(CUSTOMER_LOOKUP_PERMISSIONS),
  getCustomerHandler
);

router.post("/", staffPermissionMiddleware("canCreateCustomer"), createCustomerHandler);
router.patch("/:customerId", adminOnlyMiddleware, updateCustomerHandler);
router.post("/:customerId/reset-password", adminOnlyMiddleware, resetCustomerPasswordHandler);

module.exports = router;
