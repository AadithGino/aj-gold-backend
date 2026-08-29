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
const { getCashPositionSummary } = require("./cashPosition.service");
const { getStaffCustodyBalanceMap } = require("./financialJournal.service");
const { enrichScheme, getCustomerDetail, getCustomerOrThrow } = require("./customer.service");
const { getSchemeLimitSummariesBatch } = require("./paymentLimit.service");
const { parseCursorPagination, buildCursorPage } = require("../utils/pagination");
const { parseSafeSearchTerm } = require("../utils/safeSearch");
const {
  enrichPaymentsWithEffectiveView,
  applyEffectivePaymentRow,
  loadEffectivePaymentContext,
  filterEffectiveEntries,
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

const PAGE_SCAN_MULTIPLIER = 3;
const MAX_PAGE_SCAN_BATCHES = 40;

const buildCollectionScopeToken = ({ actor, query, statusFilter, effectiveFilters }) =>
  JSON.stringify({
    actorRole: actor?.role || null,
    actorId: actor?._id ? String(actor._id) : null,
    customer: query.customer ? String(query.customer) : null,
    scheme: query.scheme ? String(query.scheme) : null,
    collectedBy: query.collectedBy ? String(query.collectedBy) : null,
    status: statusFilter || null,
    method: effectiveFilters.paymentMethod || null,
    from: effectiveFilters.paymentDate?.$gte
      ? new Date(effectiveFilters.paymentDate.$gte).toISOString()
      : null,
    to: effectiveFilters.paymentDate?.$lte
      ? new Date(effectiveFilters.paymentDate.$lte).toISOString()
      : null,
  });

const assertCollectionCursor = (decodedCursor, scopeToken) => {
  if (!decodedCursor) return null;
  if (
    typeof decodedCursor !== "object" ||
    !decodedCursor._id ||
    typeof decodedCursor.scope !== "string"
  ) {
    throw new ApiError(400, "Invalid cursor.");
  }
  if (decodedCursor.scope !== scopeToken) {
    throw new ApiError(400, "Cursor does not match the current scope.");
  }
  return {
    _id: decodedCursor._id,
  };
};

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
    delete query.paymentDate;
  }

  const scopeToken = buildCollectionScopeToken({
    actor,
    query,
    statusFilter,
    effectiveFilters,
  });
  let cursorState = assertCollectionCursor(decodedCursor, scopeToken);

  const mappedPayments = [];
  let batchCount = 0;
  const batchSize = Math.max(limit + 1, limit * PAGE_SCAN_MULTIPLIER);
  let hasMoreRaw = true;

  const includeByStatus = (view) => {
    if (statusFilter === PAYMENT_STATUS.REVERSED) {
      return !view.effectiveLedger;
    }
    if (statusFilter === PAYMENT_STATUS.SUCCESS) {
      return Boolean(view.effectiveLedger);
    }
    return true;
  };

  const includeByEffectiveFilters = (view) => {
    if (!view.effectiveLedger) {
      return statusFilter === PAYMENT_STATUS.REVERSED;
    }
    if (effectiveFilters.paymentMethod && view.paymentMethod !== effectiveFilters.paymentMethod) {
      return false;
    }
    if (effectiveFilters.paymentDate) {
      const timestamp = new Date(view.paymentDate).getTime();
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
    return true;
  };

  while (hasMoreRaw && mappedPayments.length <= limit && batchCount < MAX_PAGE_SCAN_BATCHES) {
    batchCount += 1;
    const listQuery = { ...query };
    if (cursorState) {
      listQuery._id = { $lt: cursorState._id };
    }

    const paymentRows = await Payment.find(listQuery)
      .populate("customer", "name passbookNumber phone")
      .populate("scheme", "enrollmentNumber schemeName status")
      .populate("collectedBy", "name role")
      .sort({ _id: -1 })
      .limit(batchSize)
      .lean();

    if (!paymentRows.length) {
      hasMoreRaw = false;
      break;
    }

    const enriched = await enrichPaymentsWithEffectiveView(paymentRows);
    for (const { payment, view, latest } of enriched) {
      if (!includeByStatus(view) || !includeByEffectiveFilters(view)) {
        continue;
      }
      mappedPayments.push(mapCollectionPayment(payment, applyEffectivePaymentRow(payment, latest)));
      if (mappedPayments.length > limit) {
        break;
      }
    }

    const tail = paymentRows[paymentRows.length - 1];
    cursorState = {
      _id: tail._id,
    };
    hasMoreRaw = paymentRows.length === batchSize;
  }

  const effectiveContext = await loadEffectivePaymentContext(query);

  const paymentPage = buildCursorPage(mappedPayments, {
    limit,
    getCursorValue: (row) => ({
      _id: row._id,
      scope: scopeToken,
    }),
  });

  const effectiveEntries = filterEffectiveEntries(effectiveContext.entries, {
    paymentDate: effectiveFilters.paymentDate,
    paymentMethod: effectiveFilters.paymentMethod,
  });
  const scopedEffectiveEntries =
    statusFilter === PAYMENT_STATUS.REVERSED ? [] : effectiveEntries;
  const effectiveByMethod = scopedEffectiveEntries.reduce((acc, { ledger }) => {
    const key = ledger.paymentMethod;
    acc[key] = (acc[key] || 0) + ledger.amount;
    return acc;
  }, {});
  const methodTotals = {
    CASH: effectiveByMethod[PAYMENT_METHODS.CASH] || 0,
    UPI: effectiveByMethod[PAYMENT_METHODS.UPI] || 0,
    BANK: effectiveByMethod[PAYMENT_METHODS.BANK] || 0,
    CARD: effectiveByMethod[PAYMENT_METHODS.CARD] || 0,
  };

  const effectivelyReversedCount =
    effectiveContext.payments.length - effectiveContext.entries.length;

  return {
    from: range.from || null,
    to: range.to || null,
    totalCollection: scopedEffectiveEntries.reduce((sum, { ledger }) => sum + ledger.amount, 0),
    methodTotals,
    successPaymentCount: statusFilter === PAYMENT_STATUS.REVERSED ? 0 : scopedEffectiveEntries.length,
    reversedPaymentCount: effectivelyReversedCount,
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
    delete query.paymentDate;
  }
  if (query.paymentMethod) {
    effectiveFilters.paymentMethod = query.paymentMethod;
    delete query.paymentMethod;
  }

  const staffUsers = await User.find(staffQuery).sort({ name: 1 }).lean();
  const [profiles, effectiveContext, submissionRows] = await Promise.all([
    StaffProfile.find({ user: { $in: staffUsers.map((staff) => staff._id) } }).lean(),
    loadEffectivePaymentContext(query),
    CashSubmission.aggregate([
      {
        $match: {
          staff: { $in: staffUsers.map((staff) => staff._id) },
          status: "ACTIVE",
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

  const profileMap = new Map(profiles.map((profile) => [String(profile.user), profile]));
  const submittedByStaff = new Map(
    submissionRows.map((row) => [String(row._id), row.total || 0])
  );
  const custodyByStaff = await getStaffCustodyBalanceMap(
    staffUsers.map((staff) => staff._id)
  );
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

  const staffList = staffUsers.map((staff) => {
      const staffId = String(staff._id);
      const methodMap = methodTotalsByStaff.get(staffId) || new Map();
      const breakdown = Array.from(methodMap.entries()).map(([paymentMethod, value]) => ({
        paymentMethod,
        total: value.total,
        count: value.count,
      }));

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
      const submittedCash = submittedByStaff.get(staffId) || 0;
      const cashInHand = custodyByStaff.get(staffId) ?? 0;
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
        cashInHand,
        cashCollectedAllTime: cashCollected,
        submittedCash,
        submittedCashAllTime: submittedCash,
        pendingCash: cashInHand,
        recentPayments: recentPaymentsRaw,
      };
    });

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

  const scopeToken = JSON.stringify({
    status: filters.status || null,
    from: range.from ? range.from.toISOString() : null,
    to: range.to ? range.to.toISOString() : null,
    maturityFrom: matRange.from ? matRange.from.toISOString() : null,
    maturityTo: matRange.to ? matRange.to.toISOString() : null,
    search: filters.search?.trim() || null,
  });

  if (decodedCursor) {
    if (
      typeof decodedCursor !== "object" ||
      !decodedCursor._id ||
      decodedCursor.maturityDate == null ||
      decodedCursor.createdAt == null ||
      typeof decodedCursor.scope !== "string"
    ) {
      throw new ApiError(400, "Invalid cursor.");
    }
    if (decodedCursor.scope !== scopeToken) {
      throw new ApiError(400, "Cursor does not match the current scope.");
    }
  }

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

  const [schemes, total] = await Promise.all([
    Scheme.find(listQuery)
      .sort({ maturityDate: 1, createdAt: -1, _id: 1 })
      .limit(limit + 1)
      .lean(),
    Scheme.countDocuments(query),
  ]);

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
      createdAt: scheme.createdAt,
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
      createdAt: row.createdAt,
      _id: row.schemeId,
      scope: scopeToken,
    }),
  });

  return {
    items: page.items,
    count: total,
    pageInfo: {
      ...page.pageInfo,
      total,
    },
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
  if (actor?.role === USER_ROLES.STAFF) {
    const hasCollected = await Payment.exists({
      customer: toObjectId(customerId, "customer id"),
      collectedBy: actor._id,
    });
    if (!hasCollected) {
      throw new ApiError(403, "Forbidden.");
    }
  }
  const detail = await getCustomerDetail(customerId, actor, { forceFull: true });
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

const getSchemeLedger = async (schemeId, actor = null) => {
  if (actor?.role === USER_ROLES.STAFF) {
    const hasCollected = await Payment.exists({
      scheme: toObjectId(schemeId, "scheme id"),
      collectedBy: actor._id,
    });
    if (!hasCollected) {
      throw new ApiError(403, "Forbidden.");
    }
  }
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
