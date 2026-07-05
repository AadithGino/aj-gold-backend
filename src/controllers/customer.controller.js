const { z } = require("zod");
const {
  createCustomer,
  updateCustomer,
  resetCustomerPassword,
  searchCustomers,
  getCustomerDetail,
  getCustomerSchemes,
} = require("../services/customer.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const nomineeSchema = z.object({
  name: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  relationship: z.string().trim().optional(),
  address: z.string().trim().optional(),
});

const createCustomerSchema = z
  .object({
    name: z.string().trim().min(2, "Customer name is required."),
    phone: z
      .string()
      .trim()
      .min(10, "Phone must be at least 10 digits.")
      .max(15, "Phone must be at most 15 digits.")
      .regex(/^\d+$/, "Phone must contain only digits."),
    address: z.string().trim().optional(),
    password: z.string().min(4).optional(),
    nominee: nomineeSchema.optional(),
  })
  .strict();

const updateCustomerSchema = z.object({
  name: z.string().trim().min(2).optional(),
  phone: z
    .string()
    .trim()
    .min(10)
    .max(15)
    .regex(/^\d+$/)
    .optional(),
  address: z.string().trim().optional(),
  passbookNumber: z.string().trim().min(1).optional(),
  nominee: nomineeSchema.optional(),
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(4).optional(),
});

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createCustomerHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(createCustomerSchema, req.body);
  const customer = await createCustomer(payload, req.user);

  return res.status(201).json({
    success: true,
    data: customer,
  });
});

const listCustomersHandler = asyncHandler(async (req, res) => {
  const items = await searchCustomers(req.query.search || "");

  return res.status(200).json({
    success: true,
    data: { items },
  });
});

const getCustomerHandler = asyncHandler(async (req, res) => {
  const detail = await getCustomerDetail(req.params.customerId);

  return res.status(200).json({
    success: true,
    data: detail,
  });
});

const updateCustomerHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(updateCustomerSchema, req.body);
  const customer = await updateCustomer(req.params.customerId, payload, req.user);

  return res.status(200).json({
    success: true,
    data: customer,
  });
});

const resetCustomerPasswordHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(resetPasswordSchema, req.body);
  await resetCustomerPassword(req.params.customerId, payload.newPassword, req.user);

  return res.status(200).json({
    success: true,
    message: "Customer password reset successfully.",
  });
});

const getCustomerSchemesHandler = asyncHandler(async (req, res) => {
  const schemes = await getCustomerSchemes(req.params.customerId);

  return res.status(200).json({
    success: true,
    data: { items: schemes },
  });
});

module.exports = {
  createCustomerHandler,
  listCustomersHandler,
  getCustomerHandler,
  updateCustomerHandler,
  resetCustomerPasswordHandler,
  getCustomerSchemesHandler,
};
