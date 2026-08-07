const Customer = require("../models/customer.model");
const CustomerDeletionRequest = require("../models/customerDeletionRequest.model");
const {
  USER_ROLES,
  DELETION_REQUEST_STATUS,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { logAudit } = require("./audit.service");

const mapDeletionRequest = (doc) => ({
  _id: doc._id,
  customer: doc.customer,
  user: doc.user,
  reason: doc.reason || "",
  status: doc.status,
  reviewedBy: doc.reviewedBy || null,
  reviewedAt: doc.reviewedAt || null,
  reviewNotes: doc.reviewNotes || "",
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const getCustomerForUser = async (user) => {
  const customer = await Customer.findOne({ user: user._id });
  if (!customer) {
    throw new ApiError(404, "Customer profile not found.");
  }
  return customer;
};

const getDeletionRequestForUser = async (user) => {
  if (user.role !== USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Customer only.");
  }

  const customer = await getCustomerForUser(user);
  const request = await CustomerDeletionRequest.findOne({ customer: customer._id })
    .sort({ createdAt: -1 })
    .lean();

  return {
    request: request ? mapDeletionRequest(request) : null,
    canRequest:
      !request ||
      request.status === DELETION_REQUEST_STATUS.REJECTED ||
      request.status === DELETION_REQUEST_STATUS.CANCELLED,
  };
};

const createDeletionRequest = async (user, { reason } = {}) => {
  if (user.role !== USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Customer only.");
  }

  const customer = await getCustomerForUser(user);

  const pending = await CustomerDeletionRequest.findOne({
    customer: customer._id,
    status: DELETION_REQUEST_STATUS.PENDING,
  });
  if (pending) {
    throw new ApiError(409, "A pending deletion request already exists.");
  }

  const approved = await CustomerDeletionRequest.findOne({
    customer: customer._id,
    status: DELETION_REQUEST_STATUS.APPROVED,
  });
  if (approved) {
    throw new ApiError(409, "Your account deletion has already been approved and is awaiting processing.");
  }

  const request = await CustomerDeletionRequest.create({
    customer: customer._id,
    user: user._id,
    reason: reason?.trim() || "",
    status: DELETION_REQUEST_STATUS.PENDING,
  });

  await logAudit({
    actor: user._id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.DELETION_REQUESTED,
    targetType: "CustomerDeletionRequest",
    targetId: request._id,
    newValue: {
      customerId: customer._id,
      passbookNumber: customer.passbookNumber,
      reason: request.reason,
    },
    notes: "Customer requested account deletion",
  });

  return mapDeletionRequest(request);
};

const cancelDeletionRequest = async (user) => {
  if (user.role !== USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Customer only.");
  }

  const customer = await getCustomerForUser(user);
  const request = await CustomerDeletionRequest.findOne({
    customer: customer._id,
    status: DELETION_REQUEST_STATUS.PENDING,
  });

  if (!request) {
    throw new ApiError(404, "No pending deletion request found.");
  }

  request.status = DELETION_REQUEST_STATUS.CANCELLED;
  await request.save();

  await logAudit({
    actor: user._id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.DELETION_REQUEST_CANCELLED,
    targetType: "CustomerDeletionRequest",
    targetId: request._id,
    notes: "Customer cancelled deletion request",
  });

  return mapDeletionRequest(request);
};

module.exports = {
  getDeletionRequestForUser,
  createDeletionRequest,
  cancelDeletionRequest,
};
