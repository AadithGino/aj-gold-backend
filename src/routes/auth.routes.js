const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const loginRateLimitMiddleware = require("../middleware/loginRateLimit.middleware");
const {
  loginController,
  registerController,
  meController,
  logoutController,
} = require("../controllers/auth.controller");

const router = express.Router();

router.post("/login", loginRateLimitMiddleware, loginController);
router.post("/register", registerController);
router.get("/me", authMiddleware, meController);
router.post("/logout", authMiddleware, logoutController);

module.exports = router;
