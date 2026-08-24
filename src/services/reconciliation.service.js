const mongoose = require("mongoose");
const User = require("../models/user.model");
const Scheme = require("../models/scheme.model");
const { JOURNAL_ACCOUNTS } = require("../constants/journalAccounts");
const { JOURNAL_EVENT_TYPES, USER_ROLES, SETTLEMENT_WORKFLOW_STATUS } = require("../constants/enums");
const {
  getJournalAccountBalance,
  getStaffCustodyBalance,
  getSettlementPaidTotal,
  getSettlementAuthorizedTotal,
  getEventTypeTotal,
} = require("./financialJournal.service");
const { getStaffCashInHand } = require("./staffCash.service");

const buildReconciliationSummary = async () => {
  const [
    customerLiability,
    vaultBalance,
    settlementPaid,
    settlementAuthorized,
    collectionReceived,
    collectionReversed,
    staffCashSubmitted,
    vaultAdjustments,
  ] = await Promise.all([
    getJournalAccountBalance(JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY),
    getJournalAccountBalance(JOURNAL_ACCOUNTS.VAULT),
    getSettlementPaidTotal(),
    getSettlementAuthorizedTotal(),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.COLLECTION_REVERSAL),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.VAULT_ADJUSTMENT),
  ]);

  const netCustomerCollected = collectionReceived - collectionReversed;
  const settlementPayable = await getJournalAccountBalance(JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE);

  const staffUsers = await User.find({ role: USER_ROLES.STAFF }).select("_id name status").lean();
  const staffCustodyRows = await Promise.all(
    staffUsers.map(async (staff) => {
      const [journalBalance, aggregateBalance] = await Promise.all([
        getStaffCustodyBalance(staff._id),
        getStaffCashInHand(staff._id),
      ]);
      return {
        staffId: staff._id,
        staffName: staff.name,
        staffStatus: staff.status,
        journalCustodyBalance: journalBalance,
        aggregateCustodyBalance: aggregateBalance.aggregateCashInHand,
        cashCollected: aggregateBalance.cashCollected,
        cashSubmitted: aggregateBalance.cashSubmitted,
      };
    })
  );

  const totalStaffCustodyJournal = staffCustodyRows.reduce(
    (sum, row) => sum + row.journalCustodyBalance,
    0
  );
  const totalStaffCustodyAggregate = staffCustodyRows.reduce(
    (sum, row) => sum + row.aggregateCustodyBalance,
    0
  );

  const liquidPosition = vaultBalance + totalStaffCustodyJournal;
  const exceptions = [];

  for (const row of staffCustodyRows) {
    if (row.journalCustodyBalance !== row.aggregateCustodyBalance) {
      exceptions.push({
        code: "STAFF_CUSTODY_MISMATCH",
        staffId: row.staffId,
        journalBalance: row.journalCustodyBalance,
        aggregateBalance: row.aggregateCustodyBalance,
      });
    }
    if (row.journalCustodyBalance < 0) {
      exceptions.push({
        code: "NEGATIVE_STAFF_CUSTODY",
        staffId: row.staffId,
        balance: row.journalCustodyBalance,
      });
    }
  }

  const authorizedNotPaidSchemes = await Scheme.countDocuments({
    "settlementWorkflow.status": {
      $in: [SETTLEMENT_WORKFLOW_STATUS.APPROVED, SETTLEMENT_WORKFLOW_STATUS.PAYOUT_PENDING],
    },
  });

  return {
    accounts: {
      customerSchemeLiability: customerLiability,
      vault: vaultBalance,
      settlementPayable,
      totalStaffCustody: totalStaffCustodyJournal,
    },
    flows: {
      collectionReceived,
      collectionReversed,
      netCustomerCollected,
      staffCashSubmitted,
      vaultAdjustments,
      settlementAuthorized,
      settlementPaid,
      authorizedNotPaidSchemes,
    },
    liquidPosition,
    equation: {
      netCustomerCollected,
      customerSchemeLiability: customerLiability,
      settlementPaid,
      settlementAuthorized,
      vaultPlusStaffCustody: liquidPosition,
      balanced: exceptions.length === 0,
    },
    staffCustodyRows,
    aggregateStaffCustodyTotal: totalStaffCustodyAggregate,
    exceptions,
  };
};

module.exports = {
  buildReconciliationSummary,
};
