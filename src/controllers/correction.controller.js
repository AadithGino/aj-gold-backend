const { z } = require("zod");
const { CORRECTION_TYPES } = require("../constants/enums");
const {
  createCorrectionRequest,
  approveCorrection,
  rejectCorrection,
  listCorrections,
  getCorrectionDetail,
} = require("../services/correction.service");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { correctionReviewSchema } = require("../validation/financial.validation");

const createSchema = z.object({
  correctionType: z.enum(Object.values(CORRECTION_TYPES)),
  requestedValue: z.any().optional(),
  reason: z.string().trim().min(3, "Reason is required."),
  notes: z.string().trim().optional(),
});

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const createCorrectionHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(createSchema, req.body);
  const data = await createCorrectionRequest(req.params.paymentId, payload, req.user);
  res.status(201).json({ success: true, data });
});

const listCorrectionsHandler = asyncHandler(async (req, res) => {
  const data = await listCorrections(req.query, req.user);
  res.json({ success: true, data: { items: data } });
});

const getCorrectionHandler = asyncHandler(async (req, res) => {
  const data = await getCorrectionDetail(req.params.correctionId, req.user);
  res.json({ success: true, data });
});

const approveCorrectionHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(correctionReviewSchema, req.body);
  const data = await approveCorrection(req.params.correctionId, payload, req.user);
  res.json({ success: true, data });
});

const rejectCorrectionHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(correctionReviewSchema, req.body);
  const data = await rejectCorrection(req.params.correctionId, payload, req.user);
  res.json({ success: true, data });
});

module.exports = {
  createCorrectionHandler,
  listCorrectionsHandler,
  getCorrectionHandler,
  approveCorrectionHandler,
  rejectCorrectionHandler,
};
