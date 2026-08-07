const {
  getDeletionRequestForUser,
  createDeletionRequest,
  cancelDeletionRequest,
} = require("../services/customerDeletion.service");

const getDeletionRequestHandler = async (req, res, next) => {
  try {
    const data = await getDeletionRequestForUser(req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const createDeletionRequestHandler = async (req, res, next) => {
  try {
    const request = await createDeletionRequest(req.user, req.body);
    res.status(201).json({ success: true, data: { request } });
  } catch (err) {
    next(err);
  }
};

const cancelDeletionRequestHandler = async (req, res, next) => {
  try {
    const request = await cancelDeletionRequest(req.user);
    res.json({ success: true, data: { request } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getDeletionRequestHandler,
  createDeletionRequestHandler,
  cancelDeletionRequestHandler,
};
