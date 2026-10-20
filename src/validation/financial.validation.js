const { z } = require("zod");
const { PAYMENT_METHODS, SCHEME_STATUS } = require("../constants/enums");
const {
  ALLOWED_SETTLEMENT_PAYOUT_METHODS,
} = require("../constants/settlementContract");

const clientRequestIdSchema = z
  .string()
  .trim()
  .min(1, "clientRequestId is required.")
  .max(128);

const positiveRupeeSchema = (label = "amount") =>
  z.union([z.number(), z.string()]).superRefine((value, ctx) => {
    let parsed = value;
    if (typeof parsed === "string") {
      const trimmed = parsed.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        ctx.addIssue({
          code: "custom",
          message: `${label} must be a whole rupee amount.`,
        });
        return;
      }
      parsed = Number(trimmed);
    }
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({
        code: "custom",
        message: `${label} must be a positive whole rupee amount.`,
      });
    }
  });

const collectPaymentSchema = z.object({
  customer: z.string().min(1, "Customer is required."),
  scheme: z.string().min(1, "Scheme is required."),
  amount: positiveRupeeSchema("amount"),
  paymentMethod: z.enum(Object.values(PAYMENT_METHODS)),
  transactionReference: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3, "Reason is required."),
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const businessDateInputSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z
    .union([
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
      z.date(),
      z.string().min(1),
    ])
    .optional()
);

const cashSubmissionSchema = z.object({
  staff: z.string().min(1, "Staff is required."),
  submittedAmount: positiveRupeeSchema("submittedAmount"),
  // Keep YYYY-MM-DD as a string so toBusinessInstant can apply IST start-of-day.
  // z.coerce.date() was storing UTC midnight and showing as 5:30 AM IST.
  submissionDate: businessDateInputSchema,
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const staffSelfCashSubmissionSchema = cashSubmissionSchema.omit({
  staff: true,
});

const schemeSettlementSchema = z
  .object({
    status: z.enum([SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED]),
    notes: z.string().trim().optional(),
    clientRequestId: clientRequestIdSchema,
    payoutMethod: z.enum(ALLOWED_SETTLEMENT_PAYOUT_METHODS),
    payoutReference: z.string().trim().optional(),
    payoutEvidence: z
      .object({
        objectRef: z.string().trim().min(1),
        checksum: z.string().trim().min(1),
      })
      .optional(),
  })
  .strict();

const cashSubmissionReversalSchema = z.object({
  reason: z.string().trim().min(3, "Reason is required."),
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const correctionReviewSchema = z.object({
  reviewNotes: z.string().trim().optional(),
  approvedValue: z.any().optional(),
  reason: z.string().trim().optional(),
  reviewClientRequestId: clientRequestIdSchema,
});

module.exports = {
  clientRequestIdSchema,
  positiveRupeeSchema,
  collectPaymentSchema,
  reversePaymentSchema,
  cashSubmissionSchema,
  staffSelfCashSubmissionSchema,
  schemeSettlementSchema,
  cashSubmissionReversalSchema,
  correctionReviewSchema,
};
