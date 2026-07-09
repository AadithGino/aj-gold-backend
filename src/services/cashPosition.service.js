const User = require("../models/user.model");
const CashSubmission = require("../models/cashSubmission.model");
const CustomerPayout = require("../models/customerPayout.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYOUT_STATUS,
} = require("../constants/enums");
const { getStaffCashInHand, getPaymentMethodBreakdown } = require("./cash.service");

const sumMethod = (rows, method) =>
  rows.find((row) => row.paymentMethod === method)?.total || 0;

const sumPayoutByMethod = async (method) => {
  const rows = await CustomerPayout.aggregate([
    { $match: { status: PAYOUT_STATUS.SUCCESS, payoutMethod: method } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return rows[0]?.total || 0;
};

const getPayoutTotals = async () => {
  const [
    totalCashCustomerPayout,
    totalUpiCustomerPayout,
    totalBankCustomerPayout,
    totalCardCustomerPayout,
  ] = await Promise.all([
    sumPayoutByMethod(PAYMENT_METHODS.CASH),
    sumPayoutByMethod(PAYMENT_METHODS.UPI),
    sumPayoutByMethod(PAYMENT_METHODS.BANK),
    sumPayoutByMethod(PAYMENT_METHODS.CARD),
  ]);

  const totalCustomerPayout =
    totalCashCustomerPayout +
    totalUpiCustomerPayout +
    totalBankCustomerPayout +
    totalCardCustomerPayout;

  return {
    totalCustomerPayout,
    totalCashCustomerPayout,
    totalUpiCustomerPayout,
    totalBankCustomerPayout,
    totalCardCustomerPayout,
  };
};

const buildCashPositionPayload = ({
  totalCashSubmittedToVault,
  totalCashCollectedFromCustomers,
  totalUpiCollectedFromCustomers,
  totalBankCollectedFromCustomers,
  totalCardCollectedFromCustomers,
  totalCashWithStaff,
  payoutTotals,
}) => {
  const totalCollectedFromCustomers =
    totalCashCollectedFromCustomers +
    totalUpiCollectedFromCustomers +
    totalBankCollectedFromCustomers +
    totalCardCollectedFromCustomers;

  const cashInVault =
    totalCashSubmittedToVault +
    totalUpiCollectedFromCustomers +
    totalBankCollectedFromCustomers +
    totalCardCollectedFromCustomers -
    payoutTotals.totalCustomerPayout;

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
    totalCustomerPayout: payoutTotals.totalCustomerPayout,
    totalCashCustomerPayout: payoutTotals.totalCashCustomerPayout,
    totalUpiCustomerPayout: payoutTotals.totalUpiCustomerPayout,
    totalBankCustomerPayout: payoutTotals.totalBankCustomerPayout,
    totalCardCustomerPayout: payoutTotals.totalCardCustomerPayout,
    payoutTrackingImplemented: true,
    cashPosition: {
      cashInVault,
      totalCashWithStaff,
      totalCashSubmittedToVault,
      totalCustomerPayout: payoutTotals.totalCustomerPayout,
    },
    collectionBreakdown: {
      totalCashCollectedFromCustomers,
      totalUpiCollectedFromCustomers,
      totalBankCollectedFromCustomers,
      totalCardCollectedFromCustomers,
      totalCollectedFromCustomers,
    },
    payoutBreakdown: {
      totalCashCustomerPayout: payoutTotals.totalCashCustomerPayout,
      totalUpiCustomerPayout: payoutTotals.totalUpiCustomerPayout,
      totalBankCustomerPayout: payoutTotals.totalBankCustomerPayout,
      totalCardCustomerPayout: payoutTotals.totalCardCustomerPayout,
      totalCustomerPayout: payoutTotals.totalCustomerPayout,
    },
  };
};

const getCashPositionSummary = async () => {
  const [allTimeBreakdown, totalCashSubmitted, payoutTotals, staffUsers] =
    await Promise.all([
      getPaymentMethodBreakdown({ status: PAYMENT_STATUS.SUCCESS }),
      CashSubmission.aggregate([
        { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
      ]),
      getPayoutTotals(),
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
    totalCashCollectedFromCustomers,
    totalUpiCollectedFromCustomers,
    totalBankCollectedFromCustomers,
    totalCardCollectedFromCustomers,
    totalCashWithStaff,
    payoutTotals,
  });
};

module.exports = {
  getCashPositionSummary,
  getPayoutTotals,
  buildCashPositionPayload,
};
