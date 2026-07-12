const DEFAULT_STAFF_PERMISSIONS = {
  canCollectPayment: true,
  canCreateCustomer: true,
  canViewReports: true,
  canSubmitCash: true,
  canMarkRedeemed: true,
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
    canMarkRedeemed: stored.canMarkRedeemed !== false,
    canMarkClosed: stored.canMarkClosed === true,
    canViewReports: stored.canViewReports !== false,
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
