const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  loginController,
  registerController,
  meController,
  logoutController,
} = require("../controllers/auth.controller");

const router = express.Router();

router.post("/login", loginController);
router.post("/register", registerController);
router.get("/me", authMiddleware, meController);
router.post("/logout", authMiddleware, logoutController);

module.exports = router;
