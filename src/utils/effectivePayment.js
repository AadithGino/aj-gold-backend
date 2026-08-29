/**
 * Canonical effective-payment resolver.
 * All entitlement, cap, settlement, receipt, reconciliation, and report consumers
 * must derive financial payment state through these helpers rather than raw Payment rows.
 */
const Payment = require("../models/payment.model");
const PaymentCorrection = require("../models/paymentCorrection.model");
const { PAYMENT_STATUS, CORRECTION_STATUS } = require("../constants/enums");
const {
  buildSourceSnapshot,
  getEffectiveLedgerFields,
  getEffectivePaymentView,
  loadSchemeLedgerContext,
  buildProposedLedgerEntries,
} = require("./paymentLedger");

const buildEffectiveSnapshot = (ledgerFields) => {
  if (!ledgerFields) return null;
  return {
    amount: ledgerFields.amount,
    paymentMethod: ledgerFields.paymentMethod,
    paymentDate: ledgerFields.paymentDate,
    transactionReference: ledgerFields.transactionReference || "",
    notes: ledgerFields.notes || "",
    status: ledgerFields.status,
    receiptNumber: ledgerFields.sourceSnapshot?.receiptNumber || "",
  };
};

const getLatestApprovedCorrection = async (paymentId, session = null) => {
  return PaymentCorrection.findOne({
    payment: paymentId,
    status: CORRECTION_STATUS.APPROVED,
  })
    .sort({ reviewedAt: -1, createdAt: -1 })
    .session(session || null);
};

const getEffectiveSnapshotForPayment = async (paymentId, session = null) => {
  const payment = await Payment.findById(paymentId).session(session || null);
  if (!payment) return null;

  if (payment.status === PAYMENT_STATUS.REVERSED) {
    return {
      ...buildSourceSnapshot(payment),
      status: PAYMENT_STATUS.REVERSED,
    };
  }

  const latestCorrection = await getLatestApprovedCorrection(paymentId, session);
  const ledger = getEffectiveLedgerFields(payment, latestCorrection);
  return buildEffectiveSnapshot(ledger);
};

const getEffectivePaymentViewForPayment = async (paymentId, session = null) => {
  const payment = await Payment.findById(paymentId).session(session || null);
  if (!payment) return null;
  const latestCorrection = await getLatestApprovedCorrection(paymentId, session);
  return getEffectivePaymentView(payment, latestCorrection);
};

/** Transaction reference is optional for all payment methods (including corrections). */
const assertNonCashCollectionReference = (_paymentMethod, _transactionReference) => {};

module.exports = {
  buildEffectiveSnapshot,
  getLatestApprovedCorrection,
  getEffectiveSnapshotForPayment,
  getEffectivePaymentViewForPayment,
  assertNonCashCollectionReference,
  loadSchemeLedgerContext,
  buildProposedLedgerEntries,
};
