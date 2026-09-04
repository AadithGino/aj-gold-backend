const { buildReconciliationSummary } = require("./reconciliation.service");
const { aggregateEffectiveBreakdown } = require("../utils/effectiveReadModel");
const { PAYMENT_METHODS, USER_ROLES } = require("../constants/enums");

const sumMethodTotal = (rows, method) =>
  rows.find((row) => row.paymentMethod === method)?.total || 0;

const buildCashInvariantMeta = (exceptions, negativeCashStaff, staffCustodyRows) => {
  const staffNameById = new Map(
    staffCustodyRows.map((row) => [String(row.staffId), row.staffName])
  );
  const mismatchViolations = exceptions
    .filter((entry) => entry.code === "STAFF_CUSTODY_MISMATCH")
    .map((entry) => ({
      staffId: entry.staffId,
      staffName: staffNameById.get(String(entry.staffId)) || "Staff",
      cashInHand: entry.journalBalance ?? entry.aggregateBalance ?? 0,
      journalCustodyBalance: entry.journalBalance,
      aggregateCustodyBalance: entry.aggregateBalance,
      code: entry.code,
    }));

  const negativeViolations = negativeCashStaff.map((row) => ({
    staffId: row.staffId,
    staffName: row.staffName,
    cashInHand: row.journalCustodyBalance,
    journalCustodyBalance: row.journalCustodyBalance,
    aggregateCustodyBalance: row.aggregateCustodyBalance,
    code: "NEGATIVE_STAFF_CUSTODY",
  }));

  const negativeCashInvariantViolations = [...negativeViolations, ...mismatchViolations];
  const cashInvariantWarning = negativeCashInvariantViolations.length > 0 || exceptions.length > 0;
  let cashInvariantMessage = "";

  if (negativeViolations.length > 0) {
    cashInvariantMessage = `Negative staff cash detected for ${negativeViolations.length} staff member(s).`;
  } else if (mismatchViolations.length > 0) {
    cashInvariantMessage = `Staff cash custody mismatch for ${mismatchViolations.length} staff member(s).`;
  } else if (exceptions.length > 0) {
    cashInvariantMessage = "Cash reconciliation exceptions require review.";
  }

  return {
    cashInvariantWarning,
    cashInvariantMessage,
    negativeCashInvariantViolations,
  };
};

const getSettlementTotals = async () => {
  const summary = await buildReconciliationSummary();
  return { totalCustomerSettlement: summary.flows.settlementPaid };
};

const getCashPositionSummary = async () => {
  const summary = await buildReconciliationSummary();
  const negativeCashStaff = summary.staffCustodyRows.filter(
    (row) => row.journalCustodyBalance < 0 || row.aggregateCustodyBalance < 0
  );
  const cashInvariantMeta = buildCashInvariantMeta(
    summary.exceptions,
    negativeCashStaff,
    summary.staffCustodyRows
  );

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
  const settlementAuthorizedNotPaid = accounts.settlementPayable;
  const authorizedNotPaidSchemes = settlementAuthorizedNotPaid > 0 ? 1 : 0;

  const [methodBreakdown, adminCashBreakdown] = await Promise.all([
    aggregateEffectiveBreakdown(),
    aggregateEffectiveBreakdown(
      { collectedByRole: USER_ROLES.ADMIN },
      { paymentMethod: PAYMENT_METHODS.CASH, collectedByRole: USER_ROLES.ADMIN }
    ),
  ]);

  const totalCashCollectedFromCustomers = sumMethodTotal(methodBreakdown, PAYMENT_METHODS.CASH);
  const totalUpiCollectedFromCustomers = sumMethodTotal(methodBreakdown, PAYMENT_METHODS.UPI);
  const totalBankCollectedFromCustomers = sumMethodTotal(methodBreakdown, PAYMENT_METHODS.BANK);
  const totalCardCollectedFromCustomers = sumMethodTotal(methodBreakdown, PAYMENT_METHODS.CARD);
  const totalAdminCashCollected = sumMethodTotal(adminCashBreakdown, PAYMENT_METHODS.CASH);

  return {
    cashInVault,
    totalCashInVault: cashInVault,
    totalCustomerMoneyHeld: liquidPosition,
    totalCollectedFromCustomers: flows.netCustomerCollected,
    totalCashCollectedFromCustomers,
    totalUpiCollectedFromCustomers,
    totalBankCollectedFromCustomers,
    totalCardCollectedFromCustomers,
    totalCashWithStaff,
    totalCashSubmittedToVault: flows.staffCashSubmitted,
    totalAdminCashCollected,
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
    negativeCashInvariantViolations: cashInvariantMeta.negativeCashInvariantViolations,
    cashInvariantWarning: cashInvariantMeta.cashInvariantWarning,
    cashInvariantMessage: cashInvariantMeta.cashInvariantMessage,
  };
};

const buildCashPositionPayload = (payload) => payload;

module.exports = {
  getCashPositionSummary,
  getSettlementTotals,
  buildCashPositionPayload,
};
