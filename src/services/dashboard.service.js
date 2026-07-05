const User = require("../models/user.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const Payment = require("../models/payment.model");
const StaffProfile = require("../models/staffProfile.model");
const CashSubmission = require("../models/cashSubmission.model");
const {
  USER_ROLES,
  SCHEME_STATUS,
  PAYMENT_STATUS,
  PAYMENT_METHODS,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { startOfDay, endOfDay, startOfMonth } = require("../utils/date");
const dayjs = require("dayjs");
const { getStaffCashInHand, getPaymentMethodBreakdown } = require("./cash.service");
const { enrichScheme } = require("./customer.service");
const { getSchemeLimitSummary } = require("./paymentLimit.service");

const APP_VERSION = "v1.0.0";

const mapPaymentItem = (payment) => {
  const scheme =
    payment.scheme && typeof payment.scheme === "object"
      ? {
          _id: payment.scheme._id,
          enrollmentNumber: payment.scheme.enrollmentNumber,
          schemeName: payment.scheme.schemeName,
          status: payment.scheme.status,
        }
      : payment.scheme || null;

  const enrollmentNumber = scheme?.enrollmentNumber || payment.enrollmentNumber || null;

  return {
    _id: payment._id,
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    receiptNumber: payment.receiptNumber,
    paymentDate: payment.paymentDate || payment.createdAt,
    customer: payment.customer,
    collectedBy: payment.collectedBy
      ? typeof payment.collectedBy === "object"
        ? { name: payment.collectedBy.name, role: payment.collectedBy.role }
        : payment.collectedBy
      : null,
    collectedByRole: payment.collectedByRole,
    collectedByName:
      typeof payment.collectedBy === "object" ? payment.collectedBy.name : undefined,
    scheme,
    enrollmentNumber,
    transactionReference: payment.transactionReference || null,
    notes: payment.notes || null,
    isLimitOverride: Boolean(payment.isLimitOverride),
    overrideReason: payment.overrideReason || null,
    createdAt: payment.createdAt,
  };
};

const sumMethod = (rows, method) =>
  rows.find((row) => row.paymentMethod === method)?.total || 0;

const buildTodayMethodTotals = (rows) => ({
  totalCollection: rows.reduce((sum, row) => sum + row.total, 0),
  cashCollection: sumMethod(rows, PAYMENT_METHODS.CASH),
  upiCollection: sumMethod(rows, PAYMENT_METHODS.UPI),
  bankCollection: sumMethod(rows, PAYMENT_METHODS.BANK),
  cardCollection: sumMethod(rows, PAYMENT_METHODS.CARD),
});

/* ─── Admin Dashboard ─────────────────────────────────────────── */
const getAdminDashboard = async () => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const [
    activeSchemes,
    todayBreakdown,
    allTimeBreakdown,
    totalCashSubmitted,
    recentPayments,
    staffUsers,
    topStaffRows,
  ] = await Promise.all([
    Scheme.countDocuments({ status: SCHEME_STATUS.ACTIVE }),
    getPaymentMethodBreakdown({ paymentDate: { $gte: todayStart, $lte: todayEnd } }),
    getPaymentMethodBreakdown({}),
    CashSubmission.aggregate([
      { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
    ]),
    Payment.find({ status: PAYMENT_STATUS.SUCCESS })
      .sort({ paymentDate: -1 })
      .limit(5)
      .populate("customer", "name passbookNumber")
      .populate("collectedBy", "name role")
      .lean(),
    User.find({ role: USER_ROLES.STAFF, status: "ACTIVE" }).select("name phone").lean(),
    Payment.aggregate([
      {
        $match: {
          status: PAYMENT_STATUS.SUCCESS,
          paymentDate: { $gte: todayStart, $lte: todayEnd },
          collectedByRole: USER_ROLES.STAFF,
        },
      },
      {
        $group: {
          _id: "$collectedBy",
          total: { $sum: "$amount" },
          paymentsCount: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const today = buildTodayMethodTotals(todayBreakdown);
  const totalCashSubmittedToVault = totalCashSubmitted[0]?.total || 0;

  const staffCashSummaries = await Promise.all(
    staffUsers.map(async (staff) => {
      const summary = await getStaffCashInHand(staff._id);
      return { staff, ...summary };
    })
  );

  const pendingStaff = staffCashSummaries.filter((row) => row.cashInHand > 0);
  const totalStaffCashInHand = staffCashSummaries.reduce(
    (sum, row) => sum + row.cashInHand,
    0
  );

  const staffMap = new Map(staffUsers.map((staff) => [String(staff._id), staff]));
  const topStaffByTodayCollection = topStaffRows
    .map((row) => {
      const staff = staffMap.get(String(row._id));
      if (!staff) return null;
      return {
        staffId: row._id,
        name: staff.name,
        phone: staff.phone,
        total: row.total,
        paymentsCount: row.paymentsCount,
      };
    })
    .filter(Boolean);

  return {
    counts: { activeSchemes },
    today,
    totalCashInVault: totalCashSubmittedToVault,
    totalCashSubmittedToVault,
    totalStaffCashInHand,
    totalCashWithStaff: totalStaffCashInHand,
    totalCollectedFromCustomers: allTimeBreakdown.reduce((sum, row) => sum + row.total, 0),
    totalCashCollectedFromCustomers: sumMethod(allTimeBreakdown, PAYMENT_METHODS.CASH),
    totalUpiCollectedFromCustomers: sumMethod(allTimeBreakdown, PAYMENT_METHODS.UPI),
    totalBankCollectedFromCustomers: sumMethod(allTimeBreakdown, PAYMENT_METHODS.BANK),
    totalCardCollectedFromCustomers: sumMethod(allTimeBreakdown, PAYMENT_METHODS.CARD),
    pendingCashSubmissionSummary: {
      staffWithPendingCash: pendingStaff.length,
      totalPendingCash: totalStaffCashInHand,
    },
    topStaffByTodayCollection,
    recentPayments: recentPayments.map(mapPaymentItem),
    payoutTrackingImplemented: false,
  };
};

/* ─── Staff Dashboard ─────────────────────────────────────────── */
const getStaffDashboard = async (user) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const monthStart = startOfMonth(now);
  const yesterdayStart = startOfDay(dayjs(now).subtract(1, "day").toDate());
  const yesterdayEnd = endOfDay(dayjs(now).subtract(1, "day").toDate());

  const [staffProfile, cashSummary, todayBreakdown, yesterdayBreakdown, monthBreakdown, recentPayments, hourlyRows] =
    await Promise.all([
      StaffProfile.findOne({ user: user._id }).lean(),
      getStaffCashInHand(user._id),
      getPaymentMethodBreakdown({
        collectedBy: user._id,
        paymentDate: { $gte: todayStart, $lte: todayEnd },
      }),
      getPaymentMethodBreakdown({
        collectedBy: user._id,
        paymentDate: { $gte: yesterdayStart, $lte: yesterdayEnd },
      }),
      getPaymentMethodBreakdown({
        collectedBy: user._id,
        paymentDate: { $gte: monthStart },
      }),
      Payment.find({ collectedBy: user._id, status: PAYMENT_STATUS.SUCCESS })
        .sort({ paymentDate: -1 })
        .limit(5)
        .populate("customer", "name passbookNumber phone")
        .populate("scheme", "enrollmentNumber schemeName")
        .lean(),
      Payment.aggregate([
        {
          $match: {
            collectedBy: user._id,
            status: PAYMENT_STATUS.SUCCESS,
            paymentDate: { $gte: todayStart, $lte: todayEnd },
          },
        },
        {
          $group: {
            _id: { $hour: "$paymentDate" },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

  const today = buildTodayMethodTotals(todayBreakdown);
  const yesterday = buildTodayMethodTotals(yesterdayBreakdown);
  const month = buildTodayMethodTotals(monthBreakdown);

  const todayAmount = today.totalCollection;
  const yesterdayAmount = yesterday.totalCollection;
  let trendPercent = 0;
  if (yesterdayAmount > 0) {
    trendPercent = Math.round(((todayAmount - yesterdayAmount) / yesterdayAmount) * 100);
  } else if (todayAmount > 0) {
    trendPercent = 100;
  }

  const hourlyChart = Array.from({ length: 12 }, (_, index) => {
    const hour = index + 8;
    const row = hourlyRows.find((entry) => entry._id === hour);
    return { hour, amount: row?.total || 0, count: row?.count || 0 };
  });

  return {
    staff: {
      _id: user._id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      permissions: staffProfile?.permissions || {},
      calculatedCashInHand: cashSummary.cashInHand,
    },
    calculatedCashInHand: cashSummary.cashInHand,
    cashSummary: {
      cashCollected: cashSummary.cashCollected,
      cashSubmitted: cashSummary.cashSubmitted,
      cashInHand: cashSummary.cashInHand,
      lastUpdated: now,
    },
    collections: {
      today: {
        amount: todayAmount,
        count: todayBreakdown.reduce((s, r) => s + r.count, 0),
        breakdown: today,
      },
      yesterday: {
        amount: yesterdayAmount,
        count: yesterdayBreakdown.reduce((s, r) => s + r.count, 0),
      },
      month: {
        amount: month.totalCollection,
        count: monthBreakdown.reduce((s, r) => s + r.count, 0),
      },
      trendPercent,
      hourlyChart,
    },
    recentPayments: recentPayments.map(mapPaymentItem),
    lastSyncedAt: now,
  };
};

/* ─── Customer Dashboard ─────────────────────────────────────── */
const getCustomerDashboard = async (user) => {
  const customer = await Customer.findOne({ user: user._id }).lean();
  if (!customer) throw new ApiError(404, "Customer profile not found.");

  const [schemeDocs, paymentDocs, allTimePaid] = await Promise.all([
    Scheme.find({ customer: customer._id }).sort({ createdAt: -1 }),
    Payment.find({ customer: customer._id, status: PAYMENT_STATUS.SUCCESS })
      .sort({ paymentDate: -1 })
      .limit(100)
      .populate("collectedBy", "name role")
      .populate("scheme", "enrollmentNumber schemeName status")
      .lean(),
    Payment.aggregate([
      { $match: { customer: customer._id, status: PAYMENT_STATUS.SUCCESS } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  const enrichedSchemes = await Promise.all(schemeDocs.map((scheme) => enrichScheme(scheme)));
  const activeScheme =
    enrichedSchemes.find((scheme) => scheme.status === SCHEME_STATUS.ACTIVE) || null;
  const schemeHistory = enrichedSchemes.filter(
    (scheme) => scheme.status !== SCHEME_STATUS.ACTIVE
  );

  const paymentHistory = paymentDocs.map(mapPaymentItem);
  const limitSummary = activeScheme
    ? await getSchemeLimitSummary(activeScheme._id)
    : null;

  return {
    profile: customer,
    passbookNumber: customer.passbookNumber,
    nominee: customer.nominee || {},
    activeScheme,
    schemes: enrichedSchemes,
    schemeHistory,
    paymentHistory,
    receipts: paymentHistory,
    activeSchemeSummary: activeScheme
      ? {
          ...activeScheme,
          sixMonthLimitSummary: limitSummary
            ? {
                firstSixMonthsPaid: limitSummary.firstSixMonthsPaid,
                afterSixMonthsPaid: limitSummary.afterSixMonthsPaid,
                remainingAllowedPayment: limitSummary.remainingAllowedPayment,
              }
            : null,
        }
      : null,
    totalPaidAllTime: allTimePaid[0]?.total || 0,
  };
};

/* ─── Role Profile ────────────────────────────────────────────── */
const getRoleProfile = async (user) => {
  const baseUser = {
    _id: user._id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    status: user.status,
  };

  if (user.role === USER_ROLES.CUSTOMER) {
    const customer = await Customer.findOne({ user: user._id }).lean();
    const activeSchemeDoc = customer
      ? await Scheme.findOne({ customer: customer._id, status: SCHEME_STATUS.ACTIVE })
      : null;
    const activeScheme = activeSchemeDoc ? await enrichScheme(activeSchemeDoc) : null;

    return {
      user: baseUser,
      customer,
      nominee: customer?.nominee || {},
      activeScheme,
      roleData: {
        role: USER_ROLES.CUSTOMER,
        passbookNumber: customer?.passbookNumber || "",
        customerCode: customer?.customerCode || "",
      },
      appVersion: APP_VERSION,
    };
  }

  if (user.role === USER_ROLES.STAFF) {
    const staffProfile = await StaffProfile.findOne({ user: user._id }).lean();
    const cashSummary = await getStaffCashInHand(user._id);

    return {
      user: baseUser,
      staffProfile,
      roleData: {
        role: USER_ROLES.STAFF,
        employeeCode: staffProfile?.employeeCode || "",
        cashInHand: cashSummary.cashInHand,
      },
      appVersion: APP_VERSION,
    };
  }

  return {
    user: baseUser,
    roleData: { role: USER_ROLES.ADMIN },
    appVersion: APP_VERSION,
  };
};

module.exports = { getAdminDashboard, getStaffDashboard, getCustomerDashboard, getRoleProfile };
