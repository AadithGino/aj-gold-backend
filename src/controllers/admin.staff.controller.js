const { z } = require("zod");
const { USER_STATUS } = require("../constants/enums");
const {
  createStaff,
  updateStaff,
  updateStaffStatus,
  listStaff,
  getStaffDetail,
  getStaffCashSummary,
  getStaffRedeemedClosedHistory,
  sanitizeStaffUser,
} = require("../services/staff.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const permissionsSchema = z.object({
  canCreateCustomer: z.boolean().optional(),
  canCollectPayment: z.boolean().optional(),
  canMarkRedeemed: z.boolean().optional(),
  canMarkClosed: z.boolean().optional(),
  canMarkWithdrawn: z.boolean().optional(),
});

const createStaffSchema = z.object({
  name: z.string().trim().min(2, "Name is required."),
  phone: z
    .string()
    .trim()
    .min(10, "Phone must be at least 10 digits.")
    .max(15, "Phone must be at most 15 digits.")
    .regex(/^\d+$/, "Phone must contain only digits."),
  email: z.string().trim().email("Invalid email.").optional().or(z.literal("")),
  password: z.string().min(6, "Password must be at least 6 characters."),
  employeeCode: z.string().trim().optional(),
  permissions: permissionsSchema.optional(),
  notes: z.string().trim().optional(),
});

const updateStaffSchema = z.object({
  name: z.string().trim().min(2).optional(),
  phone: z
    .string()
    .trim()
    .min(10)
    .max(15)
    .regex(/^\d+$/)
    .optional(),
  email: z.string().trim().email().optional().or(z.literal("")),
  status: z.enum([USER_STATUS.ACTIVE, USER_STATUS.INACTIVE]).optional(),
  permissions: permissionsSchema.optional(),
  notes: z.string().trim().optional(),
});

const statusSchema = z.object({
  status: z.enum([USER_STATUS.ACTIVE, USER_STATUS.INACTIVE]),
});

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createStaffHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(createStaffSchema, req.body);
  const { user, profile } = await createStaff(payload, req.user);

  return res.status(201).json({
    success: true,
    data: {
      staffUserId: user._id,
      staffProfileId: profile._id,
      ...sanitizeStaffUser(user),
      employeeCode: profile.employeeCode,
      permissions: profile.permissions,
      notes: profile.notes || "",
    },
  });
});

const listStaffHandler = asyncHandler(async (req, res) => {
  const items = await listStaff({ search: req.query.search || "" });

  return res.status(200).json({
    success: true,
    data: { items },
  });
});

const getStaffHandler = asyncHandler(async (req, res) => {
  const detail = await getStaffDetail(req.params.staffId, {
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
    paymentMethod: req.query.paymentMethod,
  });

  return res.status(200).json({
    success: true,
    data: detail,
  });
});

const updateStaffHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(updateStaffSchema, req.body);
  const { user, profile } = await updateStaff(req.params.staffId, payload, req.user);

  return res.status(200).json({
    success: true,
    data: {
      staffUserId: user._id,
      staffProfileId: profile._id,
      ...sanitizeStaffUser(user),
      employeeCode: profile.employeeCode,
      permissions: profile.permissions,
      notes: profile.notes || "",
    },
  });
});

const updateStaffStatusHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(statusSchema, req.body);
  const { user, profile } = await updateStaffStatus(req.params.staffId, payload.status, req.user);

  return res.status(200).json({
    success: true,
    data: {
      staffUserId: user._id,
      staffProfileId: profile._id,
      ...sanitizeStaffUser(user),
      employeeCode: profile.employeeCode,
    },
  });
});

const getStaffCashSummaryHandler = asyncHandler(async (req, res) => {
  const summary = await getStaffCashSummary(req.params.staffId, {
    from: req.query.from,
    to: req.query.to,
  });

  return res.status(200).json({
    success: true,
    data: summary,
  });
});

const getStaffRedeemedClosedHistoryHandler = asyncHandler(async (req, res) => {
  const history = await getStaffRedeemedClosedHistory(req.params.staffId);

  return res.status(200).json({
    success: true,
    data: history,
  });
});

module.exports = {
  createStaffHandler,
  listStaffHandler,
  getStaffHandler,
  updateStaffHandler,
  updateStaffStatusHandler,
  getStaffCashSummaryHandler,
  getStaffRedeemedClosedHistoryHandler,
};
