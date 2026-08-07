const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const { USER_ROLES } = require("../constants/enums");
const {
  getDeletionRequestHandler,
  createDeletionRequestHandler,
  cancelDeletionRequestHandler,
} = require("../controllers/customerDeletion.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(roleMiddleware(USER_ROLES.CUSTOMER));

router.get("/deletion-request", getDeletionRequestHandler);
router.post("/deletion-request", createDeletionRequestHandler);
router.post("/deletion-request/cancel", cancelDeletionRequestHandler);

module.exports = router;
