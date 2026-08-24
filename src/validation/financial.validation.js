const { z } = require("zod");
const { PAYMENT_METHODS, SCHEME_STATUS } = require("../constants/enums");
const { ALLOWED_SETTLEMENT_PAYOUT_METHODS } = require("../constants/settlementContract");

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

const collectPaymentSchema = z
  .object({
    customer: z.string().min(1, "Customer is required."),
    scheme: z.string().min(1, "Scheme is required."),
    amount: positiveRupeeSchema("amount"),
    paymentMethod: z.enum(Object.values(PAYMENT_METHODS)),
    transactionReference: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    clientRequestId: clientRequestIdSchema,
  })
  .superRefine((value, ctx) => {
    if (value.paymentMethod !== PAYMENT_METHODS.CASH && !value.transactionReference?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "transactionReference is required for non-cash payment methods.",
      });
    }
  });

const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3, "Reason is required."),
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const cashSubmissionSchema = z.object({
  staff: z.string().min(1, "Staff is required."),
  submittedAmount: positiveRupeeSchema("submittedAmount"),
  submissionDate: z.coerce.date().optional(),
  notes: z.string().trim().optional(),
  clientRequestId: clientRequestIdSchema,
});

const staffSelfCashSubmissionSchema = cashSubmissionSchema.omit({ staff: true });

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
