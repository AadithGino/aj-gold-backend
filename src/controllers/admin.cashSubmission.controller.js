const { z } = require("zod");
const { createCashSubmission, listCashSubmissions } = require("../services/cash.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const createCashSubmissionSchema = z.object({
  staff: z.string().min(1, "Staff is required."),
  submittedAmount: z.coerce.number().positive("Submitted amount must be greater than zero."),
  submissionDate: z.coerce.date().optional(),
  notes: z.string().trim().optional(),
});

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createCashSubmissionHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(createCashSubmissionSchema, req.body);
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

  return res.status(200).json({
    success: true,
    data: { items },
  });
});

module.exports = {
  createCashSubmissionHandler,
  listCashSubmissionsHandler,
};
