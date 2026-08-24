const Payment = require("../models/payment.model");
const PaymentCorrection = require("../models/paymentCorrection.model");
const { PAYMENT_STATUS, CORRECTION_STATUS, CORRECTION_TYPES } = require("../constants/enums");

const FINANCIAL_CORRECTION_TYPES = new Set([
  CORRECTION_TYPES.EDIT_AMOUNT,
  CORRECTION_TYPES.EDIT_DATE,
  CORRECTION_TYPES.REVERSE_PAYMENT,
]);

const LEDGER_FIELD_TYPES = new Set([CORRECTION_TYPES.EDIT_AMOUNT, CORRECTION_TYPES.EDIT_DATE]);

const buildSourceSnapshot = (payment) => ({
  amount: payment.amount,
  paymentMethod: payment.paymentMethod,
  paymentDate: payment.paymentDate,
  transactionReference: payment.transactionReference || "",
  notes: payment.notes || "",
  status: payment.status,
  receiptNumber: payment.receiptNumber,
});

const getLatestApprovedCorrectionsByPayment = (corrections) => {
  const latest = new Map();
  for (const correction of corrections) {
    const paymentId = String(correction.payment);
    const existing = latest.get(paymentId);
    if (
      !existing ||
      new Date(correction.reviewedAt || correction.updatedAt).getTime() >
        new Date(existing.reviewedAt || existing.updatedAt).getTime()
    ) {
      latest.set(paymentId, correction);
    }
  }
  return latest;
};

const getEffectiveLedgerFields = (payment, latestCorrection) => {
  if (payment.status === PAYMENT_STATUS.REVERSED) {
    return null;
  }

  const source = buildSourceSnapshot(payment);
  if (!latestCorrection?.appliedSnapshot) {
    return {
      paymentId: payment._id,
      amount: source.amount,
      paymentMethod: source.paymentMethod,
      paymentDate: source.paymentDate,
      transactionReference: source.transactionReference,
      notes: source.notes,
      status: source.status,
      sourceSnapshot: source,
      adjustmentCorrectionId: null,
    };
  }

  const applied = latestCorrection.appliedSnapshot;
  return {
    paymentId: payment._id,
    amount: applied.amount ?? source.amount,
    paymentMethod: applied.paymentMethod ?? source.paymentMethod,
    paymentDate: applied.paymentDate ?? source.paymentDate,
    transactionReference: applied.transactionReference ?? source.transactionReference,
    notes: applied.notes ?? source.notes,
    status: applied.status === PAYMENT_STATUS.REVERSED ? PAYMENT_STATUS.REVERSED : source.status,
    sourceSnapshot: source,
    adjustmentCorrectionId: latestCorrection._id,
  };
};

const getEffectivePaymentView = (payment, latestCorrection = null) => {
  const ledger = getEffectiveLedgerFields(payment, latestCorrection);
  if (!ledger || ledger.status === PAYMENT_STATUS.REVERSED) {
    return {
      ...buildSourceSnapshot(payment),
      status: payment.status,
      isReversed: payment.status === PAYMENT_STATUS.REVERSED,
      sourceSnapshot: buildSourceSnapshot(payment),
      effectiveLedger: null,
    };
  }

  return {
    ...ledger.sourceSnapshot,
    amount: ledger.amount,
    paymentMethod: ledger.paymentMethod,
    paymentDate: ledger.paymentDate,
    transactionReference: ledger.transactionReference,
    notes: ledger.notes,
    status: payment.status,
    isReversed: false,
    sourceSnapshot: ledger.sourceSnapshot,
    effectiveLedger: ledger,
    adjustmentCorrectionId: ledger.adjustmentCorrectionId,
  };
};

const loadSchemeLedgerContext = async (schemeId, session = null) => {
  const [payments, corrections] = await Promise.all([
    Payment.find({ scheme: schemeId }).session(session || null).lean(),
    PaymentCorrection.find({
      scheme: schemeId,
      status: CORRECTION_STATUS.APPROVED,
    })
      .session(session || null)
      .lean(),
  ]);

  const latestByPayment = getLatestApprovedCorrectionsByPayment(corrections);
  const entries = [];

  for (const payment of payments) {
    const latest = latestByPayment.get(String(payment._id)) || null;
    const ledger = getEffectiveLedgerFields(payment, latest);
    if (ledger && ledger.status !== PAYMENT_STATUS.REVERSED) {
      entries.push(ledger);
    }
  }

  return { payments, corrections, entries, latestByPayment };
};

const buildProposedLedgerEntries = (entries, paymentId, replacement = null) => {
  const targetId = String(paymentId);
  const filtered = entries.filter((entry) => String(entry.paymentId) !== targetId);
  if (replacement) {
    filtered.push(replacement);
  }
  return filtered;
};

module.exports = {
  FINANCIAL_CORRECTION_TYPES,
  LEDGER_FIELD_TYPES,
  buildSourceSnapshot,
  getLatestApprovedCorrectionsByPayment,
  getEffectivePaymentView,
  getEffectiveLedgerFields,
  loadSchemeLedgerContext,
  buildProposedLedgerEntries,
};
