const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const { adminOnlyMiddleware } = require("../middleware/staffPermission.middleware");

const router = express.Router();

router.use(authMiddleware);
router.use(adminOnlyMiddleware);

router.get("/summary", async (req, res, next) => {
  try {
    const Payment = require("../models/payment.model");
    const Scheme  = require("../models/scheme.model");
    const Customer = require("../models/customer.model");
    const { PAYMENT_STATUS, SCHEME_STATUS } = require("../constants/enums");
    const { parseDateRange } = require("../utils/date");

    const { startDate, endDate } = parseDateRange(req.query);
    const match = { status: PAYMENT_STATUS.SUCCESS };
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = startDate;
      if (endDate)   match.createdAt.$lte = endDate;
    }

    const [paymentSummary, schemeStats, customerStats] = await Promise.all([
      Payment.aggregate([
        { $match: match },
        { $group: { _id: "$method", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Scheme.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Customer.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    res.json({ success: true, data: { paymentSummary, schemeStats, customerStats } });
  } catch (err) { next(err); }
});

module.exports = router;
