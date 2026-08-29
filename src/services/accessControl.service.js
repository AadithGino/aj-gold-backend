const StaffProfile = require("../models/staffProfile.model");
const { USER_ROLES } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const {
  resolveStaffPermissions,
  hasStaffPermission,
  CUSTOMER_LOOKUP_PERMISSIONS,
} = require("../constants/staffPermissions");

const loadStaffProfile = async (actor) => {
  if (!actor || actor.role !== USER_ROLES.STAFF) {
    return null;
  }
  return StaffProfile.findOne({ user: actor._id });
};

const assertAdmin = (actor, message = "Admin access required.") => {
  if (!actor || actor.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, message);
  }
};

const assertStaffPermission = async (actor, permissionKey, message) => {
  if (actor.role === USER_ROLES.ADMIN) {
    return null;
  }

  const profile = await loadStaffProfile(actor);
  if (!profile || !hasStaffPermission(profile, permissionKey)) {
    throw new ApiError(403, message || "Forbidden: staff permission denied.");
  }
  return profile;
};

const assertStaffAnyPermission = async (actor, permissionKeys, message) => {
  if (actor.role === USER_ROLES.ADMIN) {
    return null;
  }

  const profile = await loadStaffProfile(actor);
  if (!profile) {
    throw new ApiError(403, message || "Forbidden: staff profile not found.");
  }

  const allowed = permissionKeys.some((key) => hasStaffPermission(profile, key));
  if (!allowed) {
    throw new ApiError(403, message || "Forbidden: staff permission denied.");
  }
  return profile;
};

const getCustomerAccessMode = async (actor, staffProfile = null) => {
  if (!actor) {
    throw new ApiError(401, "Unauthorized.");
  }
  if (actor.role === USER_ROLES.ADMIN) {
    return "full";
  }
  if (actor.role !== USER_ROLES.STAFF) {
    throw new ApiError(403, "Forbidden.");
  }

  const profile = staffProfile || (await loadStaffProfile(actor));
  if (!profile) {
    throw new ApiError(403, "Forbidden: staff profile not found.");
  }

  const permissions = resolveStaffPermissions(profile.permissions);
  const canLookup = CUSTOMER_LOOKUP_PERMISSIONS.some((key) => permissions[key] === true);
  if (canLookup) {
    return "collection";
  }

  throw new ApiError(403, "Staff does not have customer access.");
};

const assertCustomerSearchAccess = async (actor, search = "", staffProfile = null) => {
  // Collection staff may list without a query; empty query is scoped to active schemes in searchCustomers.
  return getCustomerAccessMode(actor, staffProfile);
};

const assertCustomerUpdateAccess = (actor) => {
  assertAdmin(actor, "Only admin can update customer identity details.");
};

const assertSettlementReadAccess = async (actor) => {
  await assertStaffAnyPermission(
    actor,
    ["canFinalizeSettlement", "canMarkRedeemed", "canMarkClosed"],
    "Staff does not have settlement access."
  );
};

const assertReportAccess = async (actor) => {
  await assertStaffPermission(actor, "canViewReports", "Staff does not have report access.");
};

const assertPaymentReadAccess = async (actor) => {
  await assertStaffPermission(
    actor,
    "canCollectPayment",
    "Staff does not have payment collection access."
  );
};

module.exports = {
  loadStaffProfile,
  assertAdmin,
  assertStaffPermission,
  assertStaffAnyPermission,
  getCustomerAccessMode,
  assertCustomerSearchAccess,
  assertCustomerUpdateAccess,
  assertSettlementReadAccess,
  assertReportAccess,
  assertPaymentReadAccess,
};
