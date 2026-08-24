const { buildReconciliationSummary } = require("./reconciliation.service");
const ApiError = require("../utils/ApiError");

const getSettlementTotals = async () => {
  const summary = await buildReconciliationSummary();
  return { totalCustomerSettlement: summary.flows.settlementPaid };
};

const getCashPositionSummary = async () => {
  const summary = await buildReconciliationSummary();
  const negativeCashStaff = summary.staffCustodyRows.filter(
    (row) => row.journalCustodyBalance < 0 || row.aggregateCustodyBalance < 0
  );

  if (negativeCashStaff.length > 0) {
    throw new ApiError(
      500,
      `Cash invariant violated for ${negativeCashStaff.length} staff member(s).`
    );
  }

  const {
    accounts,
    flows,
    staffCustodyRows,
    exceptions,
    liquidPosition,
  } = summary;

  const totalCashWithStaff = accounts.totalStaffCustody;
  const cashInVault = accounts.vault;
  const totalCustomerSettlement = flows.settlementPaid;
  const settlementAuthorizedNotPaid = 0;
  const authorizedNotPaidSchemes = 0;

  return {
    cashInVault,
    totalCashInVault: cashInVault,
    totalCustomerMoneyHeld: liquidPosition,
    totalCollectedFromCustomers: flows.netCustomerCollected,
    totalCashCollectedFromCustomers: null,
    totalUpiCollectedFromCustomers: null,
    totalBankCollectedFromCustomers: null,
    totalCardCollectedFromCustomers: null,
    totalCashWithStaff,
    totalCashSubmittedToVault: flows.staffCashSubmitted,
    totalAdminCashCollected: null,
    totalCustomerSettlement,
    settlementAuthorizedNotPaid,
    settlementTrackingImplemented: true,
    journalBacked: true,
    cashPosition: {
      cashInVault,
      totalCashWithStaff,
      totalCashSubmittedToVault: flows.staffCashSubmitted,
      totalCustomerSettlement,
      settlementAuthorizedNotPaid,
      liquidPosition,
    },
    collectionBreakdown: {
      netCustomerCollected: flows.netCustomerCollected,
      collectionReceived: flows.collectionReceived,
      collectionReversed: flows.collectionReversed,
    },
    settlementBreakdown: {
      totalCustomerSettlement,
      settlementAuthorized: settlementAuthorizedNotPaid,
      authorizedNotPaidSchemes,
    },
    accounts: {
      customerSchemeLiability: accounts.customerSchemeLiability,
      vault: accounts.vault,
      settlementPayable: accounts.settlementPayable,
      staffCashCustody: accounts.totalStaffCustody,
    },
    staffCashRows: staffCustodyRows
      .filter(
        (row) =>
          row.journalCustodyBalance !== 0 ||
          row.cashCollected > 0 ||
          row.cashSubmitted > 0
      )
      .map((row) => ({
      staffId: row.staffId,
      staffName: row.staffName,
      staffStatus: row.staffStatus,
      cashInHand: row.journalCustodyBalance,
      journalCustodyBalance: row.journalCustodyBalance,
      aggregateCustodyBalance: row.aggregateCustodyBalance,
      cashCollected: row.cashCollected,
      cashSubmitted: row.cashSubmitted,
    })),
    reconciliationExceptions: exceptions,
    negativeCashInvariantViolations: negativeCashStaff,
  };
};

const buildCashPositionPayload = (payload) => payload;

module.exports = {
  getCashPositionSummary,
  getSettlementTotals,
  buildCashPositionPayload,
};
