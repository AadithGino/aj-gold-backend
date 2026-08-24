const {
  createScheme,
  updateSchemeStatus,
  getSchemeDetail,
} = require("../services/schemeManagement.service");
const {
  previewEntitlement,
  getSettlementDetail,
} = require("../services/settlement.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { z } = require("zod");
const { schemeSettlementSchema } = require("../validation/financial.validation");

const { clientRequestIdSchema } = require("../validation/financial.validation");

const createSchemeSchema = z.object({
  customerId: z.string().min(1, "Customer is required."),
  schemeName: z.string().trim().optional(),
  startDate: z.coerce.date().optional(),
  clientRequestId: clientRequestIdSchema,
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
  const payload = parseBody(schemeSettlementSchema, req.body);
  const scheme = await updateSchemeStatus(req.params.schemeId, payload, req.user);

  return res.status(200).json({
    success: true,
    data: scheme,
  });
});

const previewSettlementHandler = asyncHandler(async (req, res) => {
  const preview = await previewEntitlement(req.params.schemeId);
  return res.status(200).json({
    success: true,
    data: preview,
  });
});

const getSettlementDetailHandler = asyncHandler(async (req, res) => {
  const detail = await getSettlementDetail(req.params.schemeId);
  return res.status(200).json({
    success: true,
    data: detail,
  });
});

module.exports = {
  createSchemeHandler,
  getSchemeHandler,
  updateSchemeStatusHandler,
  previewSettlementHandler,
  getSettlementDetailHandler,
};
