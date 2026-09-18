const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  loginController,
  registerController,
  meController,
  logoutController,
  changePasswordController,
} = require("../controllers/auth.controller");

const router = express.Router();

router.post("/login", loginController);
router.post("/register", registerController);
router.get("/me", authMiddleware, meController);
router.post("/logout", authMiddleware, logoutController);
router.post("/change-password", authMiddleware, changePasswordController);

module.exports = router;
