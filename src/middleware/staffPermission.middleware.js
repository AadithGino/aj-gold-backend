const StaffProfile = require("../models/staffProfile.model");
const { USER_ROLES } = require("../constants/enums");
const { hasStaffPermission } = require("../constants/staffPermissions");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const staffPermissionMiddleware = (permissionKey) =>
  asyncHandler(async (req, res, next) => {
    if (req.user.role === USER_ROLES.ADMIN) {
      return next();
    }

    if (req.user.role !== USER_ROLES.STAFF) {
      throw new ApiError(403, "Forbidden: insufficient role access.");
    }

    const profile = await StaffProfile.findOne({ user: req.user._id });

    if (!hasStaffPermission(profile, permissionKey)) {
      throw new ApiError(403, "Forbidden: staff permission denied.");
    }

    return next();
  });

const adminOrStaffMiddleware = (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(401, "Unauthorized."));
  }

  if ([USER_ROLES.ADMIN, USER_ROLES.STAFF].includes(req.user.role)) {
    return next();
  }

  return next(new ApiError(403, "Forbidden: insufficient role access."));
};

const adminOnlyMiddleware = (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(401, "Unauthorized."));
  }

  if (req.user.role !== USER_ROLES.ADMIN) {
    return next(new ApiError(403, "Forbidden: admin access required."));
  }

  return next();
};

module.exports = {
  staffPermissionMiddleware,
  adminOrStaffMiddleware,
  adminOnlyMiddleware,
};
