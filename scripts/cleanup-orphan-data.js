#!/usr/bin/env node
/**
 * Remove orphan financial journal entries and related stale records.
 * Requires: MONGO_URI, CONFIRM_ORPHAN_CLEANUP=true
 */
require("dotenv").config();

const mongoose = require("mongoose");
const { connectDb, CONNECTION_SCHEMA_MODE } = require("../src/config/db");
const { buildReconciliationSummary } = require("../src/services/reconciliation.service");
const { getCashPositionSummary } = require("../src/services/cashPosition.service");
const { aggregateEffectiveTotal } = require("../src/utils/effectiveReadModel");

const assertAllowed = () => {
  if (!process.env.MONGO_URI?.trim()) {
    throw new Error("MONGO_URI is required.");
  }
  if (process.env.CONFIRM_ORPHAN_CLEANUP !== "true") {
    throw new Error("Set CONFIRM_ORPHAN_CLEANUP=true to run orphan cleanup.");
  }
};

const isOrphanJournal = (entry, { paymentIds, submissionIds, schemeIds, userIds }) => {
  const sourceId = entry.sourceRecordId ? String(entry.sourceRecordId) : "";

  if (entry.sourceRecordType === "Payment" && sourceId && !paymentIds.has(sourceId)) {
    return "missing_payment";
  }
  if (entry.sourceRecordType === "CashSubmission" && sourceId && !submissionIds.has(sourceId)) {
    return "missing_submission";
  }
  if (entry.scheme && !schemeIds.has(String(entry.scheme))) {
    return "missing_scheme";
  }
  if (entry.metadata?.staffId && !userIds.has(String(entry.metadata.staffId))) {
    return "missing_staff";
  }
  return null;
};

const run = async () => {
  assertAllowed();

  await connectDb({
    uri: process.env.MONGO_URI,
    schemaMode: CONNECTION_SCHEMA_MODE.RUNTIME,
  });

  const db = mongoose.connection.db;
  const fmt = (value) => value.toLocaleString("en-IN");

  const [payments, submissions, schemes, users] = await Promise.all([
    db.collection("payments").find({}, { projection: { _id: 1, scheme: 1 } }).toArray(),
    db.collection("cashsubmissions").find({}, { projection: { _id: 1 } }).toArray(),
    db.collection("schemes").find({}, { projection: { _id: 1 } }).toArray(),
    db.collection("users").find({}, { projection: { _id: 1 } }).toArray(),
  ]);

  const paymentIds = new Set(payments.map((row) => String(row._id)));
  const submissionIds = new Set(submissions.map((row) => String(row._id)));
  const schemeIds = new Set(schemes.map((row) => String(row._id)));
  const userIds = new Set(users.map((row) => String(row._id)));

  const orphanPaymentIds = payments
    .filter((row) => row.scheme && !schemeIds.has(String(row.scheme)))
    .map((row) => row._id);

  const journals = await db.collection("financialjournals").find({}).toArray();
  const orphanJournalIds = [];
  const reasonCounts = {};

  for (const entry of journals) {
    const reason = isOrphanJournal(entry, { paymentIds, submissionIds, schemeIds, userIds });
    if (reason) {
      orphanJournalIds.push(entry._id);
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }

  console.log("Orphan journal entries to delete:", orphanJournalIds.length);
  console.log("Reason counts:", reasonCounts);
  console.log("Orphan payments on deleted schemes:", orphanPaymentIds.length);

  const journalResult = orphanJournalIds.length
    ? await db.collection("financialjournals").deleteMany({ _id: { $in: orphanJournalIds } })
    : { deletedCount: 0 };

  const paymentCorrectionResult = orphanPaymentIds.length
    ? await db.collection("paymentcorrections").deleteMany({ payment: { $in: orphanPaymentIds } })
    : { deletedCount: 0 };

  const paymentResult = orphanPaymentIds.length
    ? await db.collection("payments").deleteMany({ _id: { $in: orphanPaymentIds } })
    : { deletedCount: 0 };

  const ambiguousResult = await db.collection("journal_migration_ambiguous").deleteMany({});

  console.log("\nDeleted:");
  console.log("  financialjournals:", journalResult.deletedCount);
  console.log("  payments:", paymentResult.deletedCount);
  console.log("  paymentcorrections:", paymentCorrectionResult.deletedCount);
  console.log("  journal_migration_ambiguous:", ambiguousResult.deletedCount);

  const summary = await buildReconciliationSummary();
  const cash = await getCashPositionSummary();
  const effectiveTotal = await aggregateEffectiveTotal();

  console.log("\nPost-cleanup dashboard numbers:");
  console.log("  Cash in vault:          ", fmt(cash.cashInVault));
  console.log("  Cash with staff:        ", fmt(cash.totalCashWithStaff));
  console.log("  Total collection (net): ", fmt(cash.totalCollectedFromCustomers));
  console.log("  Given to customers:     ", fmt(cash.totalCustomerSettlement));
  console.log("  Effective payments:     ", fmt(effectiveTotal));
  console.log("  Customer liability:     ", fmt(summary.accounts.customerSchemeLiability));
  console.log("  Vault + staff:          ", fmt(summary.liquidPosition));
  console.log(
    "  Balanced (liability = vault + staff):",
    summary.accounts.customerSchemeLiability === summary.liquidPosition
  );
  console.log(
    "  Collection matches effective:",
    cash.totalCollectedFromCustomers === effectiveTotal
  );
  console.log("  Reconciliation exceptions:", summary.exceptions.length);

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error.message || error);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
