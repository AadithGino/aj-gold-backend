const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const router = express.Router();

router.use(authMiddleware);
router.all("*", (req, res) =>
  res.status(410).json({
    success: false,
    message: "Payout endpoints are deprecated. Use scheme status redemption/closure flow.",
  })
);

module.exports = router;
