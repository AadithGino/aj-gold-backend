const DEFAULT_STAFF_PERMISSIONS = {
  canCollectPayment: false,
  canCreateCustomer: false,
  canViewReports: false,
  canSubmitCash: false,
  canMarkRedeemed: false,
  canMarkClosed: false,
  canFinalizeSettlement: false,
};

const STAFF_PERMISSION_KEYS = Object.keys(DEFAULT_STAFF_PERMISSIONS);

const resolveStaffPermissions = (permissions = {}) => {
  const stored = permissions?.toObject?.() || permissions || {};
  const merged = { ...DEFAULT_STAFF_PERMISSIONS, ...stored };

  return Object.fromEntries(
    STAFF_PERMISSION_KEYS.map((key) => [key, merged[key] === true])
  );
};

const hasStaffPermission = (profile, permissionKey) => {
  if (!profile) return false;
  return Boolean(resolveStaffPermissions(profile?.permissions)[permissionKey]);
};

module.exports = {
  DEFAULT_STAFF_PERMISSIONS,
  STAFF_PERMISSION_KEYS,
  resolveStaffPermissions,
  hasStaffPermission,
};
