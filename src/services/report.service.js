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
const { getPaymentMethodBreakdown } = require("./cash.service");
const { getStaffCashInHand } = require("./staffCash.service");
const { getCashPositionSummary } = require("./cashPosition.service");
const { enrichScheme, getCustomerDetail, getCustomerOrThrow } = require("./customer.service");
const { getSchemeLimitSummariesBatch } = require("./paymentLimit.service");
const { parseCursorPagination, buildCursorPage } = require("../utils/pagination");
const { parseSafeSearchTerm } = require("../utils/safeSearch");
const {
  enrichPaymentsWithEffectiveView,
  applyEffectivePaymentRow,
  loadEffectivePaymentContext,
} = require("../utils/effectiveReadModel");

const mapSettlementEntry = (scheme, event, index = 0) => ({
  _id: `${scheme._id}-${event.status}-${event.changedAt || index}`,
  settlementRef: `SETTLE-${scheme.enrollmentNumber}-${index + 1}`,
  settlementType: event.status === SCHEME_STATUS.CLOSED ? "CLOSURE" : "REDEMPTION",
  amount: scheme.settlement?.amount ?? 0,
  settledAt: scheme.settlement?.settledAt || event.changedAt || scheme.updatedAt || scheme.createdAt,
  notes: scheme.settlement?.notes || event.notes || "",
  status: event.status,
  settledBy: scheme.settlement?.settledBy || event.changedBy || null,
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

const mapCollectionPayment = (payment, effectiveMeta = null) => ({
  _id: payment._id,
  receiptNumber: payment.receiptNumber,
  customerName: payment.customer?.name || null,
  passbookNumber: payment.customer?.passbookNumber || null,
  enrollmentNumber: payment.scheme?.enrollmentNumber || null,
  collectedBy: mapCollectedBy(payment.collectedBy),
  collectedByRole: payment.collectedByRole,
  paymentDate: effectiveMeta?.displayPaymentDate ?? payment.paymentDate,
  paymentMethod: effectiveMeta?.displayPaymentMethod ?? payment.paymentMethod,
  amount: effectiveMeta?.displayAmount ?? payment.amount,
  status: payment.status,
  transactionReference: payment.transactionReference || "",
  notes: payment.notes || "",
  createdAt: payment.createdAt,
  ...(effectiveMeta
    ? {
        sourceAmount: payment.amount,
        sourcePaymentMethod: payment.paymentMethod,
        effectiveAmount: effectiveMeta.effectiveAmount,
        effectivePaymentMethod: effectiveMeta.effectivePaymentMethod,
        isEffectivelyReversed: effectiveMeta.isEffectivelyReversed,
      }
    : {}),
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
  const { limit, cursor: decodedCursor } = parseCursorPagination(scopedFilters, {
    maxLimit: 200,
    defaultLimit: 50,
  });

  const effectiveFilters = {};
  if (query.paymentMethod) {
    effectiveFilters.paymentMethod = query.paymentMethod;
    delete query.paymentMethod;
  }
  if (query.paymentDate) {
    effectiveFilters.paymentDate = query.paymentDate;
  }

  const listQuery = { ...query };
  if (decodedCursor?.paymentDate && decodedCursor?.createdAt && decodedCursor?._id) {
    listQuery.$or = [
      { paymentDate: { $lt: new Date(decodedCursor.paymentDate) } },
      {
        paymentDate: new Date(decodedCursor.paymentDate),
        createdAt: { $lt: new Date(decodedCursor.createdAt) },
      },
      {
        paymentDate: new Date(decodedCursor.paymentDate),
        createdAt: new Date(decodedCursor.createdAt),
        _id: { $lt: decodedCursor._id },
      },
    ];
  }

  const [successBreakdown, paymentRows, effectiveContext, rawReversedCount] = await Promise.all([
    getPaymentMethodBreakdown({ ...query, status: PAYMENT_STATUS.SUCCESS }),
    Payment.find(listQuery)
      .populate("customer", "name passbookNumber phone")
      .populate("scheme", "enrollmentNumber schemeName status")
      .populate("collectedBy", "name role")
      .sort({ paymentDate: -1, createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean(),
    loadEffectivePaymentContext(query),
    Payment.countDocuments({ ...query, status: PAYMENT_STATUS.REVERSED }),
  ]);

  const enriched = await enrichPaymentsWithEffectiveView(paymentRows);
  const mappedPayments = enriched
    .filter(({ view }) => {
      if (statusFilter === PAYMENT_STATUS.REVERSED) {
        return !view.effectiveLedger;
      }
      if (statusFilter === PAYMENT_STATUS.SUCCESS) {
        return Boolean(view.effectiveLedger);
      }
      return true;
    })
    .map(({ payment, latest }) =>
      mapCollectionPayment(payment, applyEffectivePaymentRow(payment, latest))
    );

  const paymentPage = buildCursorPage(mappedPayments, {
    limit,
    getCursorValue: (row) => ({
      paymentDate: row.paymentDate,
      createdAt: row.createdAt || row.paymentDate,
      _id: row._id,
    }),
  });

  const effectiveEntries = effectiveContext.entries.filter(({ ledger, payment }) => {
    if (effectiveFilters.paymentMethod && ledger.paymentMethod !== effectiveFilters.paymentMethod) {
      return false;
    }
    if (effectiveFilters.paymentDate) {
      const timestamp = new Date(ledger.paymentDate).getTime();
      if (
        effectiveFilters.paymentDate.$gte &&
        timestamp < effectiveFilters.paymentDate.$gte.getTime()
      ) {
        return false;
      }
      if (
        effectiveFilters.paymentDate.$lte &&
        timestamp > effectiveFilters.paymentDate.$lte.getTime()
      ) {
        return false;
      }
    }
    if (statusFilter === PAYMENT_STATUS.REVERSED) {
      return false;
    }
    if (statusFilter === PAYMENT_STATUS.SUCCESS) {
      return true;
    }
    return payment.status === statusFilter;
  });

  const methodTotals = {
    CASH: sumMethod(successBreakdown, PAYMENT_METHODS.CASH),
    UPI: sumMethod(successBreakdown, PAYMENT_METHODS.UPI),
    BANK: sumMethod(successBreakdown, PAYMENT_METHODS.BANK),
    CARD: sumMethod(successBreakdown, PAYMENT_METHODS.CARD),
  };

  const effectivelyReversedCount =
    effectiveContext.payments.length - effectiveContext.entries.length;

  return {
    from: range.from || null,
    to: range.to || null,
    totalCollection: Object.values(methodTotals).reduce((sum, value) => sum + value, 0),
    methodTotals,
    successPaymentCount: effectiveEntries.length,
    reversedPaymentCount: rawReversedCount + effectivelyReversedCount,
    payments: paymentPage.items,
    pageInfo: paymentPage.pageInfo,
  };
};

const getStaffPerformanceReport = async (filters = {}) => {
  const { query, range } = buildBasePaymentQuery(filters);

  const staffQuery = { role: USER_ROLES.STAFF, status: "ACTIVE" };
  if (filters.staffId) {
    staffQuery._id = toObjectId(filters.staffId, "staff id");
  }

  const effectiveFilters = {};
  if (query.paymentDate) {
    effectiveFilters.paymentDate = query.paymentDate;
  }
  if (query.paymentMethod) {
    effectiveFilters.paymentMethod = query.paymentMethod;
    delete query.paymentMethod;
  }

  const staffUsers = await User.find(staffQuery).sort({ name: 1 }).lean();
  const [profiles, effectiveContext] = await Promise.all([
    StaffProfile.find({ user: { $in: staffUsers.map((staff) => staff._id) } }).lean(),
    loadEffectivePaymentContext(query),
  ]);

  const profileMap = new Map(profiles.map((profile) => [String(profile.user), profile]));
  const methodTotalsByStaff = new Map();
  const recentByStaff = new Map();

  for (const { payment, ledger } of effectiveContext.entries) {
    if (effectiveFilters.paymentMethod && ledger.paymentMethod !== effectiveFilters.paymentMethod) {
      continue;
    }
    if (effectiveFilters.paymentDate) {
      const timestamp = new Date(ledger.paymentDate).getTime();
      if (
        effectiveFilters.paymentDate.$gte &&
        timestamp < effectiveFilters.paymentDate.$gte.getTime()
      ) {
        continue;
      }
      if (
        effectiveFilters.paymentDate.$lte &&
        timestamp > effectiveFilters.paymentDate.$lte.getTime()
      ) {
        continue;
      }
    }

    const staffId = String(payment.collectedBy);
    const methodMap = methodTotalsByStaff.get(staffId) || new Map();
    const methodRow = methodMap.get(ledger.paymentMethod) || { total: 0, count: 0 };
    methodRow.total += ledger.amount;
    methodRow.count += 1;
    methodMap.set(ledger.paymentMethod, methodRow);
    methodTotalsByStaff.set(staffId, methodMap);

    const recentBucket = recentByStaff.get(staffId) || [];
    recentBucket.push({ payment, ledger });
    recentByStaff.set(staffId, recentBucket);
  }

  const staffList = await Promise.all(
    staffUsers.map(async (staff) => {
      const staffId = String(staff._id);
      const methodMap = methodTotalsByStaff.get(staffId) || new Map();
      const breakdown = Array.from(methodMap.entries()).map(([paymentMethod, value]) => ({
        paymentMethod,
        total: value.total,
        count: value.count,
      }));

      const [cashSummary, submissionAgg] = await Promise.all([
        getStaffCashInHand(staff._id),
        CashSubmission.aggregate([
          { $match: { staff: staff._id } },
          { $group: { _id: null, total: { $sum: "$submittedAmount" } } },
        ]),
      ]);

      const recentPaymentsRaw = (recentByStaff.get(staffId) || [])
        .sort(
          (left, right) =>
            new Date(right.ledger.paymentDate).getTime() -
            new Date(left.ledger.paymentDate).getTime()
        )
        .slice(0, 5)
        .map(({ payment, ledger }) =>
          mapCollectionPayment(payment, {
            displayAmount: ledger.amount,
            displayPaymentMethod: ledger.paymentMethod,
            displayPaymentDate: ledger.paymentDate,
            effectiveAmount: ledger.amount,
            effectivePaymentMethod: ledger.paymentMethod,
            isEffectivelyReversed: false,
          })
        );

      const cashCollected = sumMethod(breakdown, PAYMENT_METHODS.CASH);
      const onlineCollected =
        sumMethod(breakdown, PAYMENT_METHODS.UPI) +
        sumMethod(breakdown, PAYMENT_METHODS.BANK) +
        sumMethod(breakdown, PAYMENT_METHODS.CARD);
      const totalCollected = breakdown.reduce((sum, row) => sum + row.total, 0);
      const paymentCount = breakdown.reduce((sum, row) => sum + row.count, 0);
      const submittedCash = submissionAgg[0]?.total || 0;
      const profile = profileMap.get(staffId);

      return {
        staffUserId: staff._id,
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
        recentPayments: recentPaymentsRaw,
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

  const { limit, cursor: decodedCursor } = parseCursorPagination(filters, {
    maxLimit: 200,
    defaultLimit: 50,
  });

  if (filters.search?.trim()) {
    const term = parseSafeSearchTerm(filters.search, { label: "search" });
    const customers = await Customer.find({
      $or: [
        { name: { $regex: term, $options: "i" } },
        { phone: { $regex: term, $options: "i" } },
        { passbookNumber: { $regex: term, $options: "i" } },
      ],
    }).select("_id");
    query.customer = { $in: customers.map((customer) => customer._id) };
  }

  const listQuery = { ...query };
  if (decodedCursor?.maturityDate && decodedCursor?.createdAt && decodedCursor?._id) {
    listQuery.$or = [
      { maturityDate: { $gt: new Date(decodedCursor.maturityDate) } },
      {
        maturityDate: new Date(decodedCursor.maturityDate),
        createdAt: { $lt: new Date(decodedCursor.createdAt) },
      },
      {
        maturityDate: new Date(decodedCursor.maturityDate),
        createdAt: new Date(decodedCursor.createdAt),
        _id: { $gt: decodedCursor._id },
      },
    ];
  }

  const schemes = await Scheme.find(listQuery)
    .sort({ maturityDate: 1, createdAt: -1, _id: 1 })
    .limit(limit + 1)
    .lean();

  const uniqueCustomerIds = [...new Set(schemes.map((scheme) => String(scheme.customer)))];
  const [customers, limitSummaries] = await Promise.all([
    Customer.find({ _id: { $in: uniqueCustomerIds } }).lean(),
    getSchemeLimitSummariesBatch(schemes.map((scheme) => scheme._id)),
  ]);
  const customerMap = new Map(customers.map((customer) => [String(customer._id), customer]));

  const items = schemes.map((scheme) => {
    const summary = limitSummaries.get(String(scheme._id));
    const customer = customerMap.get(String(scheme.customer));
    return {
      schemeId: scheme._id,
      customerId: customer?._id || scheme.customer,
      customerName: customer?.name || "—",
      phone: customer?.phone || "—",
      passbookNumber: customer?.passbookNumber || "—",
      enrollmentNumber: scheme.enrollmentNumber,
      schemeName: scheme.schemeName,
      status: scheme.status,
      totalPaid: summary?.totalPaid ?? 0,
      remainingAllowedPayment: summary?.remainingAllowedPayment ?? 0,
      startDate: scheme.startDate,
      sixMonthDate: scheme.sixMonthDate,
      maturityDate: scheme.maturityDate,
      statusHistorySummary: (scheme.statusHistory || []).map((entry) => ({
        status: entry.status,
        changedAt: entry.changedAt,
        notes: entry.notes || "",
      })),
    };
  });

  const page = buildCursorPage(items, {
    limit,
    getCursorValue: (row) => ({
      maturityDate: row.maturityDate,
      createdAt: row.startDate,
      _id: row.schemeId,
    }),
  });

  return {
    items: page.items,
    count: page.items.length,
    pageInfo: page.pageInfo,
  };
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

  const buildEntry = (scheme, limitSummary) => {
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
      totalPaid: limitSummary?.totalPaid ?? 0,
      status: scheme.status,
      daysRemaining,
      monthKey: dayjs(maturity).format("YYYY-MM"),
      dateKey: dayjs(maturity).format("YYYY-MM-DD"),
    };
  };

  const allSchemes = [...schemes, ...pendingSchemes];
  const limitSummaries = await getSchemeLimitSummariesBatch(allSchemes.map((scheme) => scheme._id));

  const entries = schemes.map((scheme) =>
    buildEntry(scheme, limitSummaries.get(String(scheme._id)))
  );

  const pendingEntries = pendingSchemes.map((scheme) =>
    buildEntry(scheme, limitSummaries.get(String(scheme._id)))
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

const getCustomerLedger = async (customerId, actor = null) => {
  const detail = await getCustomerDetail(customerId, actor);
  const allPayments = await Payment.find({ customer: customerId })
    .populate("scheme", "enrollmentNumber schemeName status")
    .populate("collectedBy", "name role")
    .sort({ paymentDate: -1 })
    .lean();

  const enriched = await enrichPaymentsWithEffectiveView(allPayments);
  const successPayments = enriched
    .filter(({ view }) => view.effectiveLedger)
    .map(({ payment, latest }) => ({ payment, latest }));
  const reversedPayments = enriched
    .filter(({ view }) => !view.effectiveLedger)
    .map(({ payment, latest }) => ({ payment, latest }));

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
      .filter(({ payment }) => String(payment.scheme?._id || payment.scheme) === String(scheme._id))
      .map(({ payment, latest }) =>
        mapCollectionPayment(payment, applyEffectivePaymentRow(payment, latest))
      ),
    reversedPayments: reversedPayments
      .filter(({ payment }) => String(payment.scheme?._id || payment.scheme) === String(scheme._id))
      .map(({ payment, latest }) =>
        mapCollectionPayment(payment, applyEffectivePaymentRow(payment, latest))
      ),
    settlements: settlementByScheme.get(String(scheme._id)) || [],
  }));

  const totalSettled = settlements.reduce((sum, entry) => sum + (entry.amount || 0), 0);
  const totalPaidAllSchemes = detail.schemes.reduce((sum, scheme) => sum + (scheme.totalPaid || 0), 0);

  return {
    customer: detail.customer,
    passbookNumber: detail.customer.passbookNumber,
    nominee: detail.nominee,
    schemes: detail.schemes,
    totalPaid: totalPaidAllSchemes,
    totalSettled,
    netBalance: totalPaidAllSchemes - totalSettled,
    paymentsByScheme,
    receipts: successPayments.map(({ payment, latest }) => {
      const effectiveMeta = applyEffectivePaymentRow(payment, latest);
      return {
        receiptNumber: payment.receiptNumber,
        amount: effectiveMeta.displayAmount,
        paymentDate: effectiveMeta.displayPaymentDate,
        enrollmentNumber: payment.scheme?.enrollmentNumber,
      };
    }),
    paymentHistory: detail.paymentHistory,
    settlementHistory: settlements,
    statusHistory: detail.schemes.flatMap((scheme) =>
      (scheme.statusHistory || []).map((entry) => ({
        schemeId: scheme._id,
        enrollmentNumber: scheme.enrollmentNumber,
        ...entry,
      }))
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

  const enriched = await enrichPaymentsWithEffectiveView(payments);
  const successfulPayments = enriched
    .filter(({ view }) => view.effectiveLedger)
    .map(({ payment, latest }) =>
      mapCollectionPayment(payment, applyEffectivePaymentRow(payment, latest))
    );
  const reversedPayments = enriched
    .filter(({ view }) => !view.effectiveLedger)
    .map(({ payment, latest }) =>
      mapCollectionPayment(payment, applyEffectivePaymentRow(payment, latest))
    );

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
    receipts: successfulPayments.map((payment) => ({
      receiptNumber: payment.receiptNumber,
      amount: payment.amount,
      paymentDate: payment.paymentDate,
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
