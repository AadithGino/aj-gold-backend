const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const { USER_ROLES } = require("../constants/enums");
const {
  registerFcmTokenHandler,
  unregisterFcmTokenHandler,
  testPushHandler,
} = require("../controllers/device.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(roleMiddleware(USER_ROLES.CUSTOMER));

router.put("/fcm-token", registerFcmTokenHandler);
router.delete("/fcm-token", unregisterFcmTokenHandler);
router.post("/test-push", testPushHandler);

module.exports = router;
