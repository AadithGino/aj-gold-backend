const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  adminOrStaffMiddleware,
  adminOnlyMiddleware,
  staffPermissionMiddleware,
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

router.get("/", listCustomersHandler);
router.get("/:customerId/schemes", getCustomerSchemesHandler);
router.get("/:customerId", getCustomerHandler);

router.post("/", staffPermissionMiddleware("canCreateCustomer"), createCustomerHandler);
router.patch("/:customerId", updateCustomerHandler);
router.post("/:customerId/reset-password", adminOnlyMiddleware, resetCustomerPasswordHandler);

module.exports = router;
