const { z } = require("zod");
const { SCHEME_STATUS } = require("../constants/enums");
const {
  createScheme,
  updateSchemeStatus,
  getSchemeDetail,
} = require("../services/schemeManagement.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const createSchemeSchema = z.object({
  customerId: z.string().min(1, "Customer is required."),
  schemeName: z.string().trim().optional(),
  startDate: z.coerce.date().optional(),
});

const updateSchemeStatusSchema = z.object({
  status: z.enum(Object.values(SCHEME_STATUS)),
  notes: z.string().trim().optional(),
});

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createSchemeHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(createSchemeSchema, req.body);
  const scheme = await createScheme(payload, req.user);

  return res.status(201).json({
    success: true,
    data: scheme,
  });
});

const getSchemeHandler = asyncHandler(async (req, res) => {
  const scheme = await getSchemeDetail(req.params.schemeId);

  return res.status(200).json({
    success: true,
    data: scheme,
  });
});

const updateSchemeStatusHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(updateSchemeStatusSchema, req.body);
  const scheme = await updateSchemeStatus(req.params.schemeId, payload, req.user);

  return res.status(200).json({
    success: true,
    data: scheme,
  });
});

module.exports = {
  createSchemeHandler,
  getSchemeHandler,
  updateSchemeStatusHandler,
};
