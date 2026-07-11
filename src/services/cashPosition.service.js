const User = require("../models/user.model");
const CashSubmission = require("../models/cashSubmission.model");
const Payment = require("../models/payment.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
} = require("../constants/enums");
const { getStaffCashInHand, getPaymentMethodBreakdown, getAdminCashCollected } = require("./cash.service");

const sumMethod = (rows, method) =>
  rows.find((row) => row.paymentMethod === method)?.total || 0;

const sumSettlementByMethod = async (method) => {
  const rows = await Payment.aggregate([
    { $match: { status: PAYMENT_STATUS.SUCCESS, paymentMethod: method } },
    {
      $lookup: {
        from: "schemes",
        localField: "scheme",
        foreignField: "_id",
        as: "schemeDoc",
      },
    },
    { $unwind: "$schemeDoc" },
    {
      $match: {
        "schemeDoc.status": { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return rows[0]?.total || 0;
};

const getSettlementTotals = async () => {
  const [
    totalCashCustomerSettlement,
    totalUpiCustomerSettlement,
    totalBankCustomerSettlement,
    totalCardCustomerSettlement,
  ] = await Promise.all([
    sumSettlementByMethod(PAYMENT_METHODS.CASH),
    sumSettlementByMethod(PAYMENT_METHODS.UPI),
    sumSettlementByMethod(PAYMENT_METHODS.BANK),
    sumSettlementByMethod(PAYMENT_METHODS.CARD),
  ]);

  const totalCustomerSettlement =
    totalCashCustomerSettlement +
    totalUpiCustomerSettlement +
    totalBankCustomerSettlement +
    totalCardCustomerSettlement;

  return {
    totalCustomerSettlement,
    totalCashCustomerSettlement,
    totalUpiCustomerSettlement,
    totalBankCustomerSettlement,
    totalCardCustomerSettlement,
  };
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
    totalCashCustomerSettlement: settlementTotals.totalCashCustomerSettlement,
    totalUpiCustomerSettlement: settlementTotals.totalUpiCustomerSettlement,
    totalBankCustomerSettlement: settlementTotals.totalBankCustomerSettlement,
    totalCardCustomerSettlement: settlementTotals.totalCardCustomerSettlement,
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
      totalCashCustomerSettlement: settlementTotals.totalCashCustomerSettlement,
      totalUpiCustomerSettlement: settlementTotals.totalUpiCustomerSettlement,
      totalBankCustomerSettlement: settlementTotals.totalBankCustomerSettlement,
      totalCardCustomerSettlement: settlementTotals.totalCardCustomerSettlement,
      totalCustomerSettlement: settlementTotals.totalCustomerSettlement,
    },
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
      User.find({ role: USER_ROLES.STAFF, status: "ACTIVE" }).select("_id").lean(),
    ]);

  const totalCashSubmittedToVault = totalCashSubmitted[0]?.total || 0;
  const staffCashSummaries = await Promise.all(
    staffUsers.map((staff) => getStaffCashInHand(staff._id))
  );
  const totalCashWithStaff = staffCashSummaries.reduce(
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
  });
};

module.exports = {
  getCashPositionSummary,
  getSettlementTotals,
  buildCashPositionPayload,
};
