const DEFAULT_STAFF_PERMISSIONS = {
  canCollectPayment: true,
  canCreateCustomer: true,
  canViewReports: false,
  canSubmitCash: true,
  canMarkRedeemed: false,
  canMarkClosed: false,
};

const resolveStaffPermissions = (permissions = {}) => {
  const stored =
    permissions?.toObject?.() ||
    permissions ||
    {};

  return {
    ...DEFAULT_STAFF_PERMISSIONS,
    ...stored,
    canMarkRedeemed: stored.canMarkRedeemed === true,
    canMarkClosed: stored.canMarkClosed === true,
    canViewReports: stored.canViewReports === true,
    canCollectPayment: stored.canCollectPayment !== false,
    canCreateCustomer: stored.canCreateCustomer !== false,
    canSubmitCash: stored.canSubmitCash !== false,
  };
};

const hasStaffPermission = (profile, permissionKey) =>
  Boolean(resolveStaffPermissions(profile?.permissions)[permissionKey]);

module.exports = {
  DEFAULT_STAFF_PERMISSIONS,
  resolveStaffPermissions,
  hasStaffPermission,
};
