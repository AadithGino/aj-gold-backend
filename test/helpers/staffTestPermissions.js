const FULL_OPERATIONAL_STAFF_PERMISSIONS = {
  canCollectPayment: true,
  canCreateCustomer: true,
  canViewReports: true,
  canSubmitCash: true,
  canMarkRedeemed: true,
  canMarkClosed: true,
  canFinalizeSettlement: false,
};

const SETTLEMENT_STAFF_PERMISSIONS = {
  ...FULL_OPERATIONAL_STAFF_PERMISSIONS,
  canFinalizeSettlement: true,
};

module.exports = {
  FULL_OPERATIONAL_STAFF_PERMISSIONS,
  SETTLEMENT_STAFF_PERMISSIONS,
};
