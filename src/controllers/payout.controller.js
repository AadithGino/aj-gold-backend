const { z } = require("zod");
const { PAYMENT_METHODS, PAYOUT_TYPES, SCHEME_STATUS } = require("../constants/enums");
const {
  createPayout,
  listPayouts,
  getPayoutDetail,
  reversePayout,
  listPayoutsForCustomer,
  listPayoutsForScheme,
} = require("../services/payout.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const createSchema = z.object({
  customerId: z.string().min(1).optional(),
  customer: z.string().min(1).optional(),
  schemeId: z.string().min(1).optional(),
  scheme: z.string().min(1).optional(),
  payoutType: z.enum(Object.values(PAYOUT_TYPES)),
  payoutMethod: z.enum(Object.values(PAYMENT_METHODS)),
  amount: z.coerce.number().positive(),
  payoutDate: z.coerce.date().optional(),
  referenceNumber: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  applySchemeStatus: z
    .enum([SCHEME_STATUS.REDEEMED, SCHEME_STATUS.WITHDRAWN, SCHEME_STATUS.CLOSED])
    .optional(),
});

const reverseSchema = z.object({
  reason: z.string().trim().min(3, "Reason is required."),
});

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createPayoutHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(createSchema, req.body);
  const data = await createPayout(payload, req.user);
  res.status(201).json({ success: true, data });
});

const listPayoutsHandler = asyncHandler(async (req, res) => {
  const data = await listPayouts(req.query, req.user);
  res.json({ success: true, data: { items: data } });
});

const getPayoutHandler = asyncHandler(async (req, res) => {
  const data = await getPayoutDetail(req.params.payoutId, req.user);
  res.json({ success: true, data });
});

const reversePayoutHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(reverseSchema, req.body);
  const data = await reversePayout(req.params.payoutId, payload, req.user);
  res.json({ success: true, data });
});

const customerPayoutsHandler = asyncHandler(async (req, res) => {
  const data = await listPayoutsForCustomer(req.params.customerId, req.user);
  res.json({ success: true, data: { items: data } });
});

const schemePayoutsHandler = asyncHandler(async (req, res) => {
  const data = await listPayoutsForScheme(req.params.schemeId, req.user);
  res.json({ success: true, data: { items: data } });
});

module.exports = {
  createPayoutHandler,
  listPayoutsHandler,
  getPayoutHandler,
  reversePayoutHandler,
  customerPayoutsHandler,
  schemePayoutsHandler,
};
