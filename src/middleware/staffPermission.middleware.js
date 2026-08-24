const { hasStaffPermission } = require("../constants/staffPermissions");
const StaffProfile = require("../models/staffProfile.model");
const { USER_ROLES } = require("../constants/enums");
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
    if (!profile) {
      throw new ApiError(403, "Forbidden: staff profile not found.");
    }

    if (!hasStaffPermission(profile, permissionKey)) {
      throw new ApiError(403, "Forbidden: staff permission denied.");
    }

    return next();
  });

const adminOrStaffMiddleware = asyncHandler(async (req, res, next) => {
  if (!req.user) {
    throw new ApiError(401, "Unauthorized.");
  }

  if (req.user.role === USER_ROLES.ADMIN) {
    return next();
  }

  if (req.user.role !== USER_ROLES.STAFF) {
    throw new ApiError(403, "Forbidden: insufficient role access.");
  }

  const profile = await StaffProfile.findOne({ user: req.user._id });
  if (!profile) {
    throw new ApiError(403, "Forbidden: staff profile not found.");
  }

  req.staffProfile = profile;
  return next();
});

const adminOnlyMiddleware = (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(401, "Unauthorized."));
  }

  if (req.user.role !== USER_ROLES.ADMIN) {
    return next(new ApiError(403, "Forbidden: admin access required."));
  }

  return next();
};

const customerOnlyMiddleware = (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(401, "Unauthorized."));
  }

  if (req.user.role !== USER_ROLES.CUSTOMER) {
    return next(new ApiError(403, "Forbidden: customer access required."));
  }

  return next();
};

const staffPermissionAnyMiddleware = (permissionKeys) =>
  asyncHandler(async (req, res, next) => {
    if (req.user.role === USER_ROLES.ADMIN) {
      return next();
    }

    if (req.user.role !== USER_ROLES.STAFF) {
      throw new ApiError(403, "Forbidden: insufficient role access.");
    }

    const profile = await StaffProfile.findOne({ user: req.user._id });
    if (!profile) {
      throw new ApiError(403, "Forbidden: staff profile not found.");
    }

    const allowed = permissionKeys.some((key) => hasStaffPermission(profile, key));
    if (!allowed) {
      throw new ApiError(403, "Forbidden: staff permission denied.");
    }

    req.staffProfile = profile;
    return next();
  });

module.exports = {
  staffPermissionMiddleware,
  staffPermissionAnyMiddleware,
  adminOrStaffMiddleware,
  adminOnlyMiddleware,
  customerOnlyMiddleware,
};
