const { submitStaffCash } = require("../services/dashboard.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { staffSelfCashSubmissionSchema } = require("../validation/financial.validation");

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createStaffCashSubmissionHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(staffSelfCashSubmissionSchema, req.body);
  const { submission, cashSummary } = await submitStaffCash(req.user, payload);

  return res.status(201).json({
    success: true,
    data: {
      submission: submission.toObject(),
      cashInHand: cashSummary.cashInHand,
      cashCollected: cashSummary.cashCollected,
      cashSubmitted: cashSummary.cashSubmitted,
    },
  });
});

module.exports = {
  createStaffCashSubmissionHandler,
};
