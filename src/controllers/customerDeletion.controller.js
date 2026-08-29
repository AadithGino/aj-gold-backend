const {
  getDeletionRequestForUser,
  createDeletionRequest,
  cancelDeletionRequest,
} = require("../services/customerDeletion.service");
const asyncHandler = require("../utils/asyncHandler");

const getDeletionRequestHandler = asyncHandler(async (req, res) => {
  const data = await getDeletionRequestForUser(req.user);
  res.json({ success: true, data });
});

const createDeletionRequestHandler = asyncHandler(async (req, res) => {
  const request = await createDeletionRequest(req.user, req.body);
  res.status(201).json({ success: true, data: { request } });
});

const cancelDeletionRequestHandler = asyncHandler(async (req, res) => {
  const request = await cancelDeletionRequest(req.user);
  res.json({ success: true, data: { request } });
});

module.exports = {
  getDeletionRequestHandler,
  createDeletionRequestHandler,
  cancelDeletionRequestHandler,
};
