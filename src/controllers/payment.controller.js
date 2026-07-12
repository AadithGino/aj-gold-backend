const { z } = require("zod");
const {
  collectPayment,
  listPayments,
  getPaymentDetail,
  getPaymentReceipt,
  reversePayment,
} = require("../services/payment.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const {
  collectPaymentSchema,
  reversePaymentSchema,
} = require("../validation/financial.validation");

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const collectPaymentHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(collectPaymentSchema, req.body);
  const result = await collectPayment(payload, req.user);
  res.status(201).json({ success: true, data: result });
});

const listPaymentsHandler = asyncHandler(async (req, res) => {
  const result = await listPayments(req.query, req.user);
  res.json({ success: true, data: result });
});

const getPaymentDetailHandler = asyncHandler(async (req, res) => {
  const result = await getPaymentDetail(req.params.paymentId, req.user);
  res.json({ success: true, data: result });
});

const getPaymentReceiptHandler = asyncHandler(async (req, res) => {
  const result = await getPaymentReceipt(req.params.paymentId, req.user);
  res.json({ success: true, data: result });
});

const reversePaymentHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(reversePaymentSchema, req.body);
  const result = await reversePayment(req.params.paymentId, payload, req.user);
  res.json({ success: true, data: result });
});

module.exports = {
  collectPaymentHandler,
  listPaymentsHandler,
  getPaymentDetailHandler,
  getPaymentReceiptHandler,
  reversePaymentHandler,
};
