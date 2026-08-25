const User = require("../models/user.model");
const CashSubmission = require("../models/cashSubmission.model");
const FinancialJournal = require("../models/financialJournal.model");
const { JOURNAL_ACCOUNTS } = require("../constants/journalAccounts");
const { JOURNAL_EVENT_TYPES, USER_ROLES, PAYMENT_METHODS, CASH_SUBMISSION_STATUS } = require("../constants/enums");
const {
  getJournalAccountBalance,
  getSettlementPaidTotal,
  getEventTypeTotal,
} = require("./financialJournal.service");
const { aggregateEffectiveByStaff } = require("../utils/effectiveReadModel");

const buildReconciliationSummary = async () => {
  const [
    customerLiability,
    vaultBalance,
    settlementPaid,
    collectionReceived,
    collectionReversed,
    staffCashSubmitted,
    vaultAdjustments,
  ] = await Promise.all([
    getJournalAccountBalance(JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY),
    getJournalAccountBalance(JOURNAL_ACCOUNTS.VAULT),
    getSettlementPaidTotal(),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.COLLECTION_REVERSAL),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED),
    getEventTypeTotal(JOURNAL_EVENT_TYPES.VAULT_ADJUSTMENT),
  ]);

  const netCustomerCollected = collectionReceived - collectionReversed;
  const settlementPayable = await getJournalAccountBalance(JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE);

  const staffUsers = await User.find({ role: USER_ROLES.STAFF }).select("_id name status").lean();
  const staffIds = staffUsers.map((staff) => staff._id);
  const [journalRows, effectiveCashByStaff, submittedRows] = await Promise.all([
    FinancialJournal.aggregate([
      {
        $match: {
          $and: [
            {
              $or: [
                { debitAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY },
                { creditAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY },
              ],
            },
            {
              $or: [{ actor: { $in: staffIds } }, { "metadata.staffId": { $in: staffIds } }],
            },
          ],
        },
      },
      {
        $project: {
          staffKey: { $ifNull: ["$metadata.staffId", "$actor"] },
          debitAmount: {
            $cond: [{ $eq: ["$debitAccount", JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY] }, "$amount", 0],
          },
          creditAmount: {
            $cond: [{ $eq: ["$creditAccount", JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY] }, "$amount", 0],
          },
        },
      },
      {
        $group: {
          _id: "$staffKey",
          debits: { $sum: "$debitAmount" },
          credits: { $sum: "$creditAmount" },
        },
      },
    ]),
    aggregateEffectiveByStaff(
      { collectedByRole: USER_ROLES.STAFF },
      { paymentMethod: PAYMENT_METHODS.CASH }
    ),
    CashSubmission.aggregate([
      {
        $match: {
          staff: { $in: staffIds },
          status: CASH_SUBMISSION_STATUS.ACTIVE,
        },
      },
      {
        $group: {
          _id: "$staff",
          total: { $sum: "$submittedAmount" },
        },
      },
    ]),
  ]);
  const journalByStaff = new Map(
    journalRows.map((row) => [String(row._id), (row.debits || 0) - (row.credits || 0)])
  );
  const submittedByStaff = new Map(
    submittedRows.map((row) => [String(row._id), row.total || 0])
  );
  const staffCustodyRows = staffUsers.map((staff) => {
    const staffId = String(staff._id);
    const journalBalance = journalByStaff.get(staffId) || 0;
    const cashCollected = effectiveCashByStaff.get(staffId)?.total || 0;
    const cashSubmitted = submittedByStaff.get(staffId) || 0;
    return {
      staffId: staff._id,
      staffName: staff.name,
      staffStatus: staff.status,
      journalCustodyBalance: journalBalance,
      aggregateCustodyBalance: cashCollected - cashSubmitted,
      cashCollected,
      cashSubmitted,
    };
  });

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
      settlementPaid,
    },
    liquidPosition,
    equation: {
      netCustomerCollected,
      customerSchemeLiability: customerLiability,
      settlementPaid,
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
