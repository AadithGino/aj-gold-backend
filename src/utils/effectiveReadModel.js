const Payment = require("../models/payment.model");
const PaymentCorrection = require("../models/paymentCorrection.model");
const { PAYMENT_STATUS, CORRECTION_STATUS } = require("../constants/enums");
const {
  getLatestApprovedCorrectionsByPayment,
  getEffectiveLedgerFields,
  getEffectivePaymentView,
} = require("./paymentLedger");

const { inBusinessTz } = require("./date");

const comparePaymentTimeline = (left, right) => {
  const leftDate = new Date(left.paymentDate).getTime();
  const rightDate = new Date(right.paymentDate).getTime();
  if (leftDate !== rightDate) return leftDate - rightDate;
  const leftCreated = new Date(left.createdAt).getTime();
  const rightCreated = new Date(right.createdAt).getTime();
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  return String(left._id).localeCompare(String(right._id));
};

const filterEffectiveEntries = (entries, { paymentDate, paymentMethod, collectedByRole } = {}) => {
  return entries.filter(({ payment, ledger }) => {
    if (collectedByRole && payment.collectedByRole !== collectedByRole) {
      return false;
    }
    if (paymentMethod && ledger.paymentMethod !== paymentMethod) {
      return false;
    }
    if (paymentDate) {
      const timestamp = new Date(ledger.paymentDate).getTime();
      if (paymentDate.$gte && timestamp < paymentDate.$gte.getTime()) {
        return false;
      }
      if (paymentDate.$lte && timestamp > paymentDate.$lte.getTime()) {
        return false;
      }
    }
    return true;
  });
};

const loadEffectivePaymentContext = async (match = {}, { session = null } = {}) => {
  const paymentMatch = { ...match };
  delete paymentMatch.status;
  delete paymentMatch.paymentMethod;
  delete paymentMatch.paymentDate;

  const payments = await Payment.find(paymentMatch).session(session || null).lean();
  if (!payments.length) {
    return { payments: [], entries: [], latestByPayment: new Map() };
  }

  const paymentIds = payments.map((payment) => payment._id);
  const corrections = await PaymentCorrection.find({
    payment: { $in: paymentIds },
    status: CORRECTION_STATUS.APPROVED,
  })
    .session(session || null)
    .lean();

  const latestByPayment = getLatestApprovedCorrectionsByPayment(corrections);
  const entries = [];

  for (const payment of payments) {
    const latest = latestByPayment.get(String(payment._id)) || null;
    const ledger = getEffectiveLedgerFields(payment, latest);
    if (ledger && ledger.status !== PAYMENT_STATUS.REVERSED) {
      entries.push({ payment, ledger, latest });
    }
  }

  return { payments, entries, latestByPayment };
};

const aggregateEffectiveBreakdown = async (match = {}, filters = {}, session = null) => {
  const { entries } = await loadEffectivePaymentContext(match, { session });
  const filtered = filterEffectiveEntries(entries, filters);
  const byMethod = new Map();

  for (const { ledger } of filtered) {
    const row = byMethod.get(ledger.paymentMethod) || { total: 0, count: 0 };
    row.total += ledger.amount;
    row.count += 1;
    byMethod.set(ledger.paymentMethod, row);
  }

  return Array.from(byMethod.entries())
    .map(([paymentMethod, value]) => ({
      paymentMethod,
      total: value.total,
      count: value.count,
    }))
    .sort((left, right) => left.paymentMethod.localeCompare(right.paymentMethod));
};

const aggregateEffectiveTotal = async (match = {}, filters = {}, session = null) => {
  const { entries } = await loadEffectivePaymentContext(match, { session });
  const filtered = filterEffectiveEntries(entries, filters);
  return filtered.reduce((sum, { ledger }) => sum + ledger.amount, 0);
};

const aggregateEffectiveByStaff = async (match = {}, filters = {}) => {
  const { entries } = await loadEffectivePaymentContext(match);
  const filtered = filterEffectiveEntries(entries, filters);
  const byStaff = new Map();

  for (const { payment, ledger } of filtered) {
    const staffId = String(payment.collectedBy);
    const row = byStaff.get(staffId) || { total: 0, count: 0 };
    row.total += ledger.amount;
    row.count += 1;
    byStaff.set(staffId, row);
  }

  return byStaff;
};

const aggregateEffectiveHourly = async (match = {}, filters = {}) => {
  const { entries } = await loadEffectivePaymentContext(match);
  const filtered = filterEffectiveEntries(entries, filters);
  const byHour = new Map();

  for (const { ledger } of filtered) {
    const hour = inBusinessTz(ledger.paymentDate).hour();
    const row = byHour.get(hour) || { total: 0, count: 0 };
    row.total += ledger.amount;
    row.count += 1;
    byHour.set(hour, row);
  }

  return Array.from(byHour.entries())
    .map(([_id, value]) => ({ _id, total: value.total, count: value.count }))
    .sort((left, right) => left._id - right._id);
};

const enrichPaymentsWithEffectiveView = async (payments, session = null) => {
  if (!payments.length) {
    return [];
  }

  const paymentIds = payments.map((payment) => payment._id);
  const corrections = await PaymentCorrection.find({
    payment: { $in: paymentIds },
    status: CORRECTION_STATUS.APPROVED,
  })
    .session(session || null)
    .lean();

  const latestByPayment = getLatestApprovedCorrectionsByPayment(corrections);

  return payments.map((payment) => {
    const latest = latestByPayment.get(String(payment._id)) || null;
    return {
      payment,
      view: getEffectivePaymentView(payment, latest),
      latest,
    };
  });
};

const getEffectiveTotalPaidTillNow = async (payment, session = null) => {
  const schemeId = payment.scheme?._id || payment.scheme;
  const { entries } = await loadEffectivePaymentContext({ scheme: schemeId }, { session });
  const sorted = entries
    .map(({ payment: row, ledger }) => ({
      _id: row._id,
      amount: ledger.amount,
      paymentDate: ledger.paymentDate,
      createdAt: row.createdAt,
    }))
    .sort(comparePaymentTimeline);

  const currentId = String(payment._id);
  let total = 0;
  for (const row of sorted) {
    total += row.amount;
    if (String(row._id) === currentId) {
      break;
    }
  }
  return total;
};

const getEffectiveReceiptFields = (payment, latestCorrection = null) => {
  const view = getEffectivePaymentView(payment, latestCorrection);
  if (!view.effectiveLedger) {
    return null;
  }

  return {
    amount: view.amount,
    paymentMethod: view.paymentMethod,
    paymentDate: view.paymentDate,
    transactionReference: view.transactionReference || "",
    notes: view.notes || "",
  };
};

const applyEffectivePaymentRow = (payment, latestCorrection = null) => {
  const view = getEffectivePaymentView(payment, latestCorrection);
  return {
    effectiveAmount: view.effectiveLedger ? view.amount : null,
    effectivePaymentMethod: view.effectiveLedger ? view.paymentMethod : null,
    effectivePaymentDate: view.effectiveLedger ? view.paymentDate : null,
    isEffectivelyReversed: !view.effectiveLedger,
    displayAmount: view.effectiveLedger ? view.amount : payment.amount,
    displayPaymentMethod: view.effectiveLedger ? view.paymentMethod : payment.paymentMethod,
    displayPaymentDate: view.effectiveLedger ? view.paymentDate : payment.paymentDate,
  };
};

module.exports = {
  comparePaymentTimeline,
  filterEffectiveEntries,
  loadEffectivePaymentContext,
  aggregateEffectiveBreakdown,
  aggregateEffectiveTotal,
  aggregateEffectiveByStaff,
  aggregateEffectiveHourly,
  enrichPaymentsWithEffectiveView,
  getEffectiveTotalPaidTillNow,
  getEffectiveReceiptFields,
  applyEffectivePaymentRow,
};
