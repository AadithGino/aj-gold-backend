const DEFAULT_STAFF_PERMISSIONS = {
  canCollectPayment: true,
  canCreateCustomer: true,
  canViewReports: false,
  canSubmitCash: true,
  canMarkRedeemed: true,
  canMarkClosed: true,
};

const isLegacyLockedProfile = (permissions = {}) =>
  !permissions.canCollectPayment &&
  !permissions.canCreateCustomer &&
  !permissions.canSubmitCash &&
  !permissions.canViewReports;

const resolveStaffPermissions = (permissions = {}) => {
  const stored =
    permissions?.toObject?.() ||
    permissions ||
    {};

  if (isLegacyLockedProfile(stored)) {
    return { ...DEFAULT_STAFF_PERMISSIONS };
  }

  return {
    ...DEFAULT_STAFF_PERMISSIONS,
    ...stored,
  };
};

const hasStaffPermission = (profile, permissionKey) =>
  Boolean(resolveStaffPermissions(profile?.permissions)[permissionKey]);

module.exports = {
  DEFAULT_STAFF_PERMISSIONS,
  resolveStaffPermissions,
  hasStaffPermission,
  isLegacyLockedProfile,
};
