const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  adminOnlyMiddleware,
  staffPermissionMiddleware,
  staffPermissionAnyMiddleware,
} = require("../middleware/staffPermission.middleware");
const {
  createCustomerHandler,
  listCustomersHandler,
  getCustomerHandler,
  updateCustomerHandler,
  resetCustomerPasswordHandler,
  getCustomerSchemesHandler,
} = require("../controllers/customer.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(adminOrStaffMiddleware);

router.get("/", staffPermissionAnyMiddleware(["canCollectPayment"]), listCustomersHandler);
router.get("/:customerId/schemes", staffPermissionAnyMiddleware(["canCollectPayment"]), getCustomerSchemesHandler);
router.get("/:customerId", staffPermissionAnyMiddleware(["canCollectPayment"]), getCustomerHandler);

router.post("/", staffPermissionMiddleware("canCreateCustomer"), createCustomerHandler);
router.patch("/:customerId", adminOnlyMiddleware, updateCustomerHandler);
router.post("/:customerId/reset-password", adminOnlyMiddleware, resetCustomerPasswordHandler);

module.exports = router;
