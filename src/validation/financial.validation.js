const { z } = require("zod");
const { PAYMENT_METHODS, SCHEME_STATUS } = require("../constants/enums");

const clientRequestIdSchema = z.string().trim().min(1, "clientRequestId is required.").max(128);

const positiveRupeeSchema = (label = "amount") =>
  z.union([z.number(), z.string()]).superRefine((value, ctx) => {
    let parsed = value;
    if (typeof parsed === "string") {
      const trimmed = parsed.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        ctx.addIssue({ code: "custom", message: `${label} must be a whole rupee amount.` });
        return;
      }
      parsed = Number(trimmed);
    }
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({ code: "custom", message: `${label} must be a positive whole rupee amount.` });
    }
  });

const collectPaymentSchema = z.object({
  customer: z.string().min(1, "Customer is required."),
  scheme: z.string().min(1, "Scheme is required."),
  amount: positiveRupeeSchema("amount"),
  paymentMethod: z.enum(Object.values(PAYMENT_METHODS)),
  paymentDate: z.coerce.date().optional(),
  transactionReference: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  overrideReason: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3, "Reason is required."),
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
  settlementAdjustmentOverride: z.boolean().optional(),
  settlementAdjustmentReason: z.string().trim().optional(),
});

const cashSubmissionSchema = z.object({
  staff: z.string().min(1, "Staff is required."),
  submittedAmount: positiveRupeeSchema("submittedAmount"),
  submissionDate: z.coerce.date().optional(),
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const staffSelfCashSubmissionSchema = cashSubmissionSchema.omit({ staff: true });

const schemeSettlementSchema = z.object({
  status: z.enum([SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED]),
  settlementAmount: positiveRupeeSchema("settlementAmount"),
  notes: z.string().trim().min(1, "Notes are required for settlement."),
  clientRequestId: clientRequestIdSchema,
  overrideReason: z.string().trim().optional(),
});

const correctionReviewSchema = z.object({
  reviewNotes: z.string().trim().optional(),
  approvedValue: z.any().optional(),
  reason: z.string().trim().optional(),
  reviewClientRequestId: clientRequestIdSchema,
  settlementAdjustmentOverride: z.boolean().optional(),
  settlementAdjustmentReason: z.string().trim().optional(),
});

module.exports = {
  clientRequestIdSchema,
  positiveRupeeSchema,
  collectPaymentSchema,
  reversePaymentSchema,
  cashSubmissionSchema,
  staffSelfCashSubmissionSchema,
  schemeSettlementSchema,
  correctionReviewSchema,
};
