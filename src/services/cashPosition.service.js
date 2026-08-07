const User = require("../models/user.model");
const Scheme = require("../models/scheme.model");
const CashSubmission = require("../models/cashSubmission.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { getPaymentMethodBreakdown, getAdminCashCollected } = require("./cash.service");
const { getStaffCashInHand } = require("./staffCash.service");

const sumMethod = (rows, method) =>
  rows.find((row) => row.paymentMethod === method)?.total || 0;

const getSettlementTotals = async () => {
  const rows = await Scheme.aggregate([
    {
      $match: {
        status: { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] },
        "settlement.amount": { $exists: true, $ne: null },
      },
    },
    { $group: { _id: null, total: { $sum: "$settlement.amount" } } },
  ]);

  return { totalCustomerSettlement: rows[0]?.total || 0 };
};

const buildCashPositionPayload = ({
  totalCashSubmittedToVault,
  totalAdminCashCollected,
  totalCashCollectedFromCustomers,
  totalUpiCollectedFromCustomers,
  totalBankCollectedFromCustomers,
  totalCardCollectedFromCustomers,
  totalCashWithStaff,
  settlementTotals,
  staffCashRows = [],
  negativeCashStaff = [],
}) => {
  const totalCollectedFromCustomers =
    totalCashCollectedFromCustomers +
    totalUpiCollectedFromCustomers +
    totalBankCollectedFromCustomers +
    totalCardCollectedFromCustomers;

  const cashInVault =
    totalCashSubmittedToVault +
    totalAdminCashCollected +
    totalUpiCollectedFromCustomers +
    totalBankCollectedFromCustomers +
    totalCardCollectedFromCustomers -
    settlementTotals.totalCustomerSettlement;

  return {
    cashInVault,
    totalCashInVault: cashInVault,
    totalCustomerMoneyHeld: cashInVault,
    totalCollectedFromCustomers,
    totalCashCollectedFromCustomers,
    totalUpiCollectedFromCustomers,
    totalBankCollectedFromCustomers,
    totalCardCollectedFromCustomers,
    totalCashWithStaff,
    totalCashSubmittedToVault,
    totalAdminCashCollected,
    totalCustomerSettlement: settlementTotals.totalCustomerSettlement,
    settlementTrackingImplemented: true,
    cashPosition: {
      cashInVault,
      totalCashWithStaff,
      totalCashSubmittedToVault,
      totalAdminCashCollected,
      totalCustomerSettlement: settlementTotals.totalCustomerSettlement,
    },
    collectionBreakdown: {
      totalCashCollectedFromCustomers,
      totalUpiCollectedFromCustomers,
      totalBankCollectedFromCustomers,
      totalCardCollectedFromCustomers,
      totalCollectedFromCustomers,
      totalAdminCashCollected,
    },
    settlementBreakdown: {
      totalCustomerSettlement: settlementTotals.totalCustomerSettlement,
    },
    staffCashRows,
    negativeCashInvariantViolations: negativeCashStaff,
  };
};

const getCashPositionSummary = async () => {
  const [allTimeBreakdown, totalCashSubmitted, totalAdminCashCollected, settlementTotals, staffUsers] =
    await Promise.all([
      getPaymentMethodBreakdown({ status: PAYMENT_STATUS.SUCCESS }),
      CashSubmission.aggregate([
        { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
      ]),
      getAdminCashCollected(),
      getSettlementTotals(),
      User.find({ role: USER_ROLES.STAFF }).select("_id name status").lean(),
    ]);

  const totalCashSubmittedToVault = totalCashSubmitted[0]?.total || 0;

  const staffCashSummaries = await Promise.all(
    staffUsers.map(async (staff) => {
      const summary = await getStaffCashInHand(staff._id);
      return {
        staffId: staff._id,
        staffName: staff.name,
        staffStatus: staff.status,
        ...summary,
      };
    })
  );

  const staffWithActivity = staffCashSummaries.filter(
    (row) => row.cashCollected > 0 || row.cashSubmitted > 0 || row.cashInHand !== 0
  );

  const negativeCashStaff = staffWithActivity.filter((row) => row.cashInHand < 0);
  if (negativeCashStaff.length > 0) {
    throw new ApiError(
      500,
      `Cash invariant violated for ${negativeCashStaff.length} staff member(s).`
    );
  }

  const totalCashWithStaff = staffWithActivity.reduce(
    (sum, row) => sum + row.cashInHand,
    0
  );

  const totalCashCollectedFromCustomers = sumMethod(allTimeBreakdown, PAYMENT_METHODS.CASH);
  const totalUpiCollectedFromCustomers = sumMethod(allTimeBreakdown, PAYMENT_METHODS.UPI);
  const totalBankCollectedFromCustomers = sumMethod(allTimeBreakdown, PAYMENT_METHODS.BANK);
  const totalCardCollectedFromCustomers = sumMethod(allTimeBreakdown, PAYMENT_METHODS.CARD);

  return buildCashPositionPayload({
    totalCashSubmittedToVault,
    totalAdminCashCollected,
    totalCashCollectedFromCustomers,
    totalUpiCollectedFromCustomers,
    totalBankCollectedFromCustomers,
    totalCardCollectedFromCustomers,
    totalCashWithStaff,
    settlementTotals,
    staffCashRows: staffWithActivity,
    negativeCashStaff,
  });
};

module.exports = {
  getCashPositionSummary,
  getSettlementTotals,
  buildCashPositionPayload,
};
