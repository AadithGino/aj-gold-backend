const { createCashSubmission, listCashSubmissions, reverseCashSubmission } = require("../services/cash.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { cashSubmissionSchema, cashSubmissionReversalSchema } = require("../validation/financial.validation");

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createCashSubmissionHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(cashSubmissionSchema, req.body);
  const { submission, cashSummary } = await createCashSubmission(payload, req.user);

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

const listCashSubmissionsHandler = asyncHandler(async (req, res) => {
  const items = await listCashSubmissions({
    staffId: req.query.staffId,
    from: req.query.from,
    to: req.query.to,
  });
  const summary = {
    count: items.length,
    totalAmount: items.reduce((sum, row) => sum + (row.submittedAmount || 0), 0),
  };

  return res.status(200).json({
    success: true,
    data: { items, summary },
  });
});

const reverseCashSubmissionHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(cashSubmissionReversalSchema, req.body);
  const { submission, cashSummary } = await reverseCashSubmission(
    req.params.submissionId,
    payload,
    req.user
  );

  return res.status(200).json({
    success: true,
    data: {
      submission: submission.toObject(),
      cashSummary,
    },
  });
});

module.exports = {
  createCashSubmissionHandler,
  listCashSubmissionsHandler,
  reverseCashSubmissionHandler,
};
