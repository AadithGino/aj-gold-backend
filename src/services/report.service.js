const mongoose = require("mongoose");
const Payment = require("../models/payment.model");
const Scheme = require("../models/scheme.model");
const Customer = require("../models/customer.model");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const CashSubmission = require("../models/cashSubmission.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
  SETTLEMENT_STATUSES,
} = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const { parseDateRange, startOfDay, endOfDay } = require("../utils/date");
const dayjs = require("dayjs");
const { getStaffCashInHand, getPaymentMethodBreakdown } = require("./cash.service");
const { getCashPositionSummary } = require("./cashPosition.service");
const { enrichScheme, getCustomerDetail, getCustomerOrThrow } = require("./customer.service");
const { getSchemeLimitSummary } = require("./paymentLimit.service");

const mapSettlementEntry = (scheme, event, index = 0) => ({
  _id: `${scheme._id}-${event.status}-${event.changedAt || index}`,
  settlementRef: `SETTLE-${scheme.enrollmentNumber}-${index + 1}`,
  settlementType: event.status === SCHEME_STATUS.CLOSED ? "CLOSURE" : "REDEMPTION",
  amount: scheme.totalPaid || 0,
  settledAt: event.changedAt || scheme.updatedAt || scheme.createdAt,
  notes: event.notes || "",
  status: event.status,
  settledBy: event.changedBy || null,
  scheme: {
    _id: scheme._id,
    enrollmentNumber: scheme.enrollmentNumber,
    schemeName: scheme.schemeName,
    status: scheme.status,
  },
});

const toObjectId = (id, label = "id") => {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return new mongoose.Types.ObjectId(id);
};

const sumMethod = (rows, method) =>
  rows.find((row) => row.paymentMethod === method)?.total || 0;

const mapCollectedBy = (user) =>
  user && typeof user === "object"
    ? { _id: user._id, name: user.name, role: user.role }
    : null;

const mapCollectionPayment = (payment) => ({
  _id: payment._id,
  receiptNumber: payment.receiptNumber,
  customerName: payment.customer?.name || null,
  passbookNumber: payment.customer?.passbookNumber || null,
  enrollmentNumber: payment.scheme?.enrollmentNumber || null,
  collectedBy: mapCollectedBy(payment.collectedBy),
  collectedByRole: payment.collectedByRole,
  paymentDate: payment.paymentDate,
  paymentMethod: payment.paymentMethod,
  amount: payment.amount,
  status: payment.status,
  transactionReference: payment.transactionReference || "",
  notes: payment.notes || "",
});

const buildBasePaymentQuery = (filters = {}) => {
  const query = {};

  if (filters.customerId) query.customer = toObjectId(filters.customerId, "customer id");
  if (filters.schemeId) query.scheme = toObjectId(filters.schemeId, "scheme id");
  if (filters.staffId) query.collectedBy = toObjectId(filters.staffId, "staff id");
  if (filters.method) {
    if (!Object.values(PAYMENT_METHODS).includes(filters.method)) {
      throw new ApiError(400, "Invalid payment method filter.");
    }
    query.paymentMethod = filters.method;
  }

  const range = parseDateRange(filters.from, filters.to);
  if (range.error) throw new ApiError(400, range.error);
  if (range.from || range.to) {
    query.paymentDate = {};
    if (range.from) query.paymentDate.$gte = range.from;
    if (range.to) query.paymentDate.$lte = range.to;
  }

  return { query, range };
};

const getCollectionReport = async (filters = {}, actor) => {
  const scopedFilters = { ...filters };
  if (actor.role === USER_ROLES.STAFF) {
    scopedFilters.staffId = actor._id.toString();
  }

  const { query, range } = buildBasePaymentQuery(scopedFilters);
  const statusFilter = scopedFilters.status || PAYMENT_STATUS.SUCCESS;

  const listQuery = { ...query, status: statusFilter };
  const successQuery = { ...query, status: PAYMENT_STATUS.SUCCESS };
  const reversedQuery = { ...query, status: PAYMENT_STATUS.REVERSED };

  const [successBreakdown, payments, reversedCount, successCount] = await Promise.all([
    getPaymentMethodBreakdown(successQuery),
    Payment.find(listQuery)
      .populate("customer", "name passbookNumber phone")
      .populate("scheme", "enrollmentNumber schemeName status")
      .populate("collectedBy", "name role")
      .sort({ paymentDate: -1, createdAt: -1 })
      .limit(Math.min(Number(scopedFilters.limit) || 200, 500))
      .lean(),
    Payment.countDocuments(reversedQuery),
    Payment.countDocuments(successQuery),
  ]);

  const methodTotals = {
    CASH: sumMethod(successBreakdown, PAYMENT_METHODS.CASH),
    UPI: sumMethod(successBreakdown, PAYMENT_METHODS.UPI),
    BANK: sumMethod(successBreakdown, PAYMENT_METHODS.BANK),
    CARD: sumMethod(successBreakdown, PAYMENT_METHODS.CARD),
  };

  return {
    from: range.from || null,
    to: range.to || null,
    totalCollection: Object.values(methodTotals).reduce((s, v) => s + v, 0),
    methodTotals,
    successPaymentCount: successCount,
    reversedPaymentCount: reversedCount,
    payments: payments.map(mapCollectionPayment),
  };
};

const getStaffPerformanceReport = async (filters = {}) => {
  const { query, range } = buildBasePaymentQuery(filters);
  const successQuery = { ...query, status: PAYMENT_STATUS.SUCCESS };

  const staffQuery = { role: USER_ROLES.STAFF, status: "ACTIVE" };
  if (filters.staffId) {
    staffQuery._id = toObjectId(filters.staffId, "staff id");
  }

  const staffUsers = await User.find(staffQuery).sort({ name: 1 }).lean();
  const profiles = await StaffProfile.find({ user: { $in: staffUsers.map((s) => s._id) } }).lean();
  const profileMap = new Map(profiles.map((p) => [String(p.user), p]));

  const staffList = await Promise.all(
    staffUsers.map(async (staff) => {
      const staffId = staff._id;
      const staffFilter = { ...successQuery, collectedBy: staffId };
      const [breakdown, cashSummary, recentPayments, submissionAgg] = await Promise.all([
        getPaymentMethodBreakdown(staffFilter),
        getStaffCashInHand(staffId),
        Payment.find(staffFilter)
          .populate("customer", "name passbookNumber")
          .populate("scheme", "enrollmentNumber")
          .sort({ paymentDate: -1 })
          .limit(5)
          .lean(),
        CashSubmission.aggregate([
          { $match: { staff: staffId } },
          { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
        ]),
      ]);

      const cashCollected = sumMethod(breakdown, PAYMENT_METHODS.CASH);
      const onlineCollected =
        sumMethod(breakdown, PAYMENT_METHODS.UPI) +
        sumMethod(breakdown, PAYMENT_METHODS.BANK) +
        sumMethod(breakdown, PAYMENT_METHODS.CARD);
      const totalCollected = breakdown.reduce((s, r) => s + r.total, 0);
      const paymentCount = breakdown.reduce((s, r) => s + r.count, 0);
      const submittedCash = submissionAgg[0]?.total || 0;

      const profile = profileMap.get(String(staffId));

      return {
        staffUserId: staffId,
        name: staff.name,
        phone: staff.phone,
        employeeCode: profile?.employeeCode || "",
        totalCollected,
        cashCollected,
        onlineCollected,
        paymentCount,
        cashInHand: cashSummary.cashInHand,
        cashCollectedAllTime: cashSummary.cashCollected,
        submittedCash,
        submittedCashAllTime: cashSummary.cashSubmitted,
        pendingCash: cashSummary.cashInHand,
        recentPayments: recentPayments.map(mapCollectionPayment),
      };
    })
  );

  return {
    from: range.from || null,
    to: range.to || null,
    staff: staffList,
  };
};

const getCashPositionReport = async () => {
  const summary = await getCashPositionSummary();
  return summary;
};

const getSchemeReport = async (filters = {}) => {
  const query = {};
  if (filters.status) query.status = filters.status;

  const range = parseDateRange(filters.from, filters.to);
  if (range.error) throw new ApiError(400, range.error);
  if (range.from || range.to) {
    query.startDate = {};
    if (range.from) query.startDate.$gte = range.from;
    if (range.to) query.startDate.$lte = range.to;
  }

  const matRange = parseDateRange(filters.maturityFrom, filters.maturityTo);
  if (matRange.error) throw new ApiError(400, matRange.error);
  if (matRange.from || matRange.to) {
    query.maturityDate = {};
    if (matRange.from) query.maturityDate.$gte = matRange.from;
    if (matRange.to) query.maturityDate.$lte = matRange.to;
  }

  let customerIds = null;
  if (filters.search?.trim()) {
    const term = filters.search.trim();
    const customers = await Customer.find({
      $or: [
        { name: { $regex: term, $options: "i" } },
        { phone: { $regex: term, $options: "i" } },
        { passbookNumber: { $regex: term, $options: "i" } },
      ],
    }).select("_id");
    customerIds = customers.map((c) => c._id);
    query.customer = { $in: customerIds };
  }

  const schemes = await Scheme.find(query).sort({ maturityDate: 1 }).limit(500).lean();
  const customerMap = new Map();
  const uniqueCustomerIds = [...new Set(schemes.map((s) => String(s.customer)))];
  const customers = await Customer.find({ _id: { $in: uniqueCustomerIds } }).lean();
  customers.forEach((c) => customerMap.set(String(c._id), c));

  const items = await Promise.all(
    schemes.map(async (scheme) => {
      const enriched = await enrichScheme(scheme);
      const customer = customerMap.get(String(scheme.customer));
      return {
        schemeId: scheme._id,
        customerId: customer?._id || scheme.customer,
        customerName: customer?.name || "—",
        phone: customer?.phone || "—",
        passbookNumber: customer?.passbookNumber || "—",
        enrollmentNumber: enriched.enrollmentNumber,
        schemeName: enriched.schemeName,
        status: enriched.status,
        totalPaid: enriched.totalPaid,
        remainingAllowedPayment: enriched.remainingAllowedPayment,
        startDate: enriched.startDate,
        sixMonthDate: enriched.sixMonthDate,
        maturityDate: enriched.maturityDate,
        statusHistorySummary: (enriched.statusHistory || []).map((h) => ({
          status: h.status,
          changedAt: h.changedAt,
          notes: h.notes || "",
        })),
      };
    })
  );

  return { items, count: items.length };
};

const getMaturityCalendar = async (filters = {}) => {
  const range = parseDateRange(filters.from, filters.to);
  if (range.error) throw new ApiError(400, range.error);

  const from = range.from || startOfDay(new Date());
  const to = range.to || endOfDay(dayjs().add(12, "month").toDate());

  const query = {
    maturityDate: { $gte: from, $lte: to },
  };
  if (filters.status) query.status = filters.status;

  const pendingQuery = {
    maturityDate: { $lte: endOfDay(new Date()) },
    status: { $nin: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] },
  };

  const [schemes, pendingSchemes] = await Promise.all([
    Scheme.find(query).sort({ maturityDate: 1 }).lean(),
    Scheme.find(pendingQuery).sort({ maturityDate: 1 }).lean(),
  ]);

  const customers = await Customer.find({
    _id: { $in: [...schemes.map((s) => s.customer), ...pendingSchemes.map((s) => s.customer)] },
  }).lean();
  const customerMap = new Map(customers.map((c) => [String(c._id), c]));
  const today = startOfDay(new Date());

  const buildEntry = async (scheme) => {
    const limit = await getSchemeLimitSummary(scheme._id);
    const customer = customerMap.get(String(scheme.customer));
    const maturity = new Date(scheme.maturityDate);
    const daysRemaining = Math.ceil(
      (maturity.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );
    return {
      schemeId: scheme._id,
      customerId: customer?._id || scheme.customer,
      customerName: customer?.name || "—",
      phone: customer?.phone || "—",
      passbookNumber: customer?.passbookNumber || "—",
      enrollmentNumber: scheme.enrollmentNumber,
      maturityDate: scheme.maturityDate,
      totalPaid: limit.totalPaid,
      status: scheme.status,
      daysRemaining,
      monthKey: dayjs(maturity).format("YYYY-MM"),
      dateKey: dayjs(maturity).format("YYYY-MM-DD"),
    };
  };

  const entries = await Promise.all(
    schemes.map((scheme) => buildEntry(scheme))
  );

  const pendingEntries = await Promise.all(
    pendingSchemes.map((scheme) => buildEntry(scheme))
  );

  const groupedByMonth = entries.reduce((acc, entry) => {
    if (!acc[entry.monthKey]) acc[entry.monthKey] = [];
    acc[entry.monthKey].push(entry);
    return acc;
  }, {});

  return {
    from,
    to,
    entries,
    pendingEntries,
    groupedByMonth,
    count: entries.length,
    pendingCount: pendingEntries.length,
  };
};

const getCustomerLedger = async (customerId) => {
  const detail = await getCustomerDetail(customerId);
  const allPayments = await Payment.find({ customer: customerId })
    .populate("scheme", "enrollmentNumber schemeName status")
    .populate("collectedBy", "name role")
    .sort({ paymentDate: -1 })
    .lean();

  const successPayments = allPayments.filter((p) => p.status === PAYMENT_STATUS.SUCCESS);
  const reversedPayments = allPayments.filter((p) => p.status === PAYMENT_STATUS.REVERSED);

  const settlementByScheme = new Map(
    detail.schemes.map((scheme) => [
      String(scheme._id),
      (scheme.statusHistory || [])
        .filter((event) => SETTLEMENT_STATUSES.includes(event.status))
        .map((event, index) => mapSettlementEntry(scheme, event, index)),
    ])
  );
  const settlements = Array.from(settlementByScheme.values()).flat();

  const paymentsByScheme = detail.schemes.map((scheme) => ({
    schemeId: scheme._id,
    enrollmentNumber: scheme.enrollmentNumber,
    status: scheme.status,
    totalPaid: scheme.totalPaid,
    payments: successPayments
      .filter((p) => String(p.scheme?._id || p.scheme) === String(scheme._id))
      .map(mapCollectionPayment),
    reversedPayments: reversedPayments
      .filter((p) => String(p.scheme?._id || p.scheme) === String(scheme._id))
      .map(mapCollectionPayment),
    settlements: settlementByScheme.get(String(scheme._id)) || [],
  }));

  const totalSettled = settlements.reduce((sum, entry) => sum + (entry.amount || 0), 0);
  const totalPaidAllSchemes = detail.schemes.reduce((sum, s) => sum + (s.totalPaid || 0), 0);

  return {
    customer: detail.customer,
    passbookNumber: detail.customer.passbookNumber,
    nominee: detail.nominee,
    schemes: detail.schemes,
    totalPaid: totalPaidAllSchemes,
    totalSettled,
    netBalance: totalPaidAllSchemes - totalSettled,
    paymentsByScheme,
    receipts: successPayments.map((p) => ({
      receiptNumber: p.receiptNumber,
      amount: p.amount,
      paymentDate: p.paymentDate,
      enrollmentNumber: p.scheme?.enrollmentNumber,
    })),
    paymentHistory: detail.paymentHistory,
    settlementHistory: settlements,
    statusHistory: detail.schemes.flatMap((s) =>
      (s.statusHistory || []).map((h) => ({ schemeId: s._id, enrollmentNumber: s.enrollmentNumber, ...h }))
    ),
  };
};

const getSchemeLedger = async (schemeId) => {
  const schemeDoc = await Scheme.findById(schemeId).lean();
  if (!schemeDoc) throw new ApiError(404, "Scheme not found.");

  const scheme = await enrichScheme(schemeDoc);
  const customer = await Customer.findById(schemeDoc.customer).lean();
  if (!customer) throw new ApiError(404, "Customer not found.");

  const payments = await Payment.find({ scheme: schemeId })
    .populate("collectedBy", "name role phone")
    .sort({ paymentDate: -1 })
    .lean();

  const successfulPayments = payments
    .filter((p) => p.status === PAYMENT_STATUS.SUCCESS)
    .map(mapCollectionPayment);
  const reversedPayments = payments
    .filter((p) => p.status === PAYMENT_STATUS.REVERSED)
    .map(mapCollectionPayment);

  const settlements = (scheme.statusHistory || [])
    .filter((event) => SETTLEMENT_STATUSES.includes(event.status))
    .map((event, index) => mapSettlementEntry(scheme, event, index))
    .sort((a, b) => new Date(b.settledAt) - new Date(a.settledAt));
  const totalSettled = settlements.reduce((sum, entry) => sum + (entry.amount || 0), 0);

  return {
    scheme: {
      _id: scheme._id,
      enrollmentNumber: scheme.enrollmentNumber,
      schemeName: scheme.schemeName,
      status: scheme.status,
      startDate: scheme.startDate,
      sixMonthDate: scheme.sixMonthDate,
      maturityDate: scheme.maturityDate,
      totalPaid: scheme.totalPaid,
      statusHistory: scheme.statusHistory,
    },
    customer: {
      _id: customer._id,
      name: customer.name,
      phone: customer.phone,
      passbookNumber: customer.passbookNumber,
    },
    sixMonthLimitSummary: {
      firstSixMonthsPaid: scheme.firstSixMonthsPaid,
      afterSixMonthsPaid: scheme.afterSixMonthsPaid,
      remainingAllowedPayment: scheme.remainingAllowedPayment,
    },
    successfulPayments,
    reversedPayments,
    settlements,
    receipts: successfulPayments.map((p) => ({
      receiptNumber: p.receiptNumber,
      amount: p.amount,
      paymentDate: p.paymentDate,
    })),
    totalPaid: scheme.totalPaid,
    totalSettled,
    netBalance: scheme.totalPaid - totalSettled,
  };
};

module.exports = {
  getCollectionReport,
  getStaffPerformanceReport,
  getCashPositionReport,
  getSchemeReport,
  getMaturityCalendar,
  getCustomerLedger,
  getSchemeLedger,
};
