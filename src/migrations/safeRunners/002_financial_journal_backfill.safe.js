const {
  PAYMENT_STATUS,
  SCHEME_STATUS,
  JOURNAL_EVENT_TYPES,
  USER_ROLES,
  PAYMENT_METHODS,
} = require("../../constants/enums");
const { JOURNAL_ACCOUNTS } = require("../../constants/journalAccounts");
const { journalBusinessKey } = require("../../utils/journalRecording");

const SAFE_EXECUTOR_ID = "002_financial_journal_backfill.safe";
const SAFE_EXECUTOR_VERSION = "v1";
const SETTLED_STATUSES = [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED];
const BATCH_SIZE = 500;

const collectionAccountsForPayment = (payment) => {
  if (payment.paymentMethod === PAYMENT_METHODS.CASH && payment.collectedByRole === USER_ROLES.STAFF) {
    return {
      debitAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY,
      creditAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
    };
  }
  return {
    debitAccount: JOURNAL_ACCOUNTS.VAULT,
    creditAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
  };
};

const insertIfMissing = async (collection, entry) => {
  const existing = await collection.findOne({ businessKey: entry.businessKey }, { projection: { _id: 1 } });
  if (existing) return;
  await collection.insertOne({
    ...entry,
    recordedAt: entry.recordedAt || new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const forEachInBatches = async (collection, filter, onRow) => {
  let lastId = null;
  while (true) {
    const pageFilter = lastId ? { ...filter, _id: { $gt: lastId } } : filter;
    const rows = await collection.find(pageFilter).sort({ _id: 1 }).limit(BATCH_SIZE).toArray();
    if (rows.length === 0) break;
    for (const row of rows) {
      await onRow(row);
    }
    lastId = rows[rows.length - 1]._id;
  }
};

const appendAmbiguous = async (ambiguousCollection, row) => {
  await ambiguousCollection.updateOne(
    {
      migrationId: "002_financial_journal_backfill",
      schemeId: row.schemeId,
      reason: row.reason,
    },
    {
      $set: {
        ...row,
        migrationId: "002_financial_journal_backfill",
        recordedAt: new Date(),
      },
    },
    { upsert: true }
  );
};

const runMigration002Safe = async (db) => {
  const journal = db.collection("financialjournals");
  const payments = db.collection("payments");
  const cashSubmissions = db.collection("cashsubmissions");
  const schemes = db.collection("schemes");
  const ambiguousCollection = db.collection("journal_migration_ambiguous");

  await forEachInBatches(payments, { status: PAYMENT_STATUS.SUCCESS }, async (payment) => {
    const accounts = collectionAccountsForPayment(payment);
    await insertIfMissing(journal, {
      entryId: `legacy-payment-${payment._id}`,
      businessKey: journalBusinessKey.paymentCollection(payment._id),
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED,
      amount: payment.amount,
      ...accounts,
      customer: payment.customer,
      scheme: payment.scheme,
      sourceRecordType: "Payment",
      sourceRecordId: payment._id,
      actor: payment.collectedBy,
      actorRole: payment.collectedByRole || "",
      clientRequestId: "",
      effectiveAt: payment.paymentDate || payment.createdAt || new Date(),
      metadata: { migrated: true },
    });
  });

  await forEachInBatches(payments, { status: PAYMENT_STATUS.REVERSED }, async (payment) => {
    const accounts = collectionAccountsForPayment(payment);
    await insertIfMissing(journal, {
      entryId: `legacy-payment-collection-${payment._id}`,
      businessKey: journalBusinessKey.paymentCollection(payment._id),
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED,
      amount: payment.amount,
      ...accounts,
      customer: payment.customer,
      scheme: payment.scheme,
      sourceRecordType: "Payment",
      sourceRecordId: payment._id,
      actor: payment.collectedBy,
      actorRole: payment.collectedByRole || "",
      clientRequestId: "",
      effectiveAt: payment.paymentDate || payment.createdAt || new Date(),
      metadata: { migrated: true },
    });

    await insertIfMissing(journal, {
      entryId: `legacy-payment-reversal-${payment._id}`,
      businessKey: journalBusinessKey.paymentReversal(payment._id, "legacy"),
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_REVERSAL,
      amount: payment.amount,
      debitAccount: accounts.creditAccount,
      creditAccount: accounts.debitAccount,
      customer: payment.customer,
      scheme: payment.scheme,
      sourceRecordType: "Payment",
      sourceRecordId: payment._id,
      actor: payment.collectedBy,
      actorRole: payment.collectedByRole || "",
      clientRequestId: "legacy",
      effectiveAt: payment.updatedAt || payment.paymentDate || new Date(),
      metadata: { migrated: true },
    });
  });

  await forEachInBatches(cashSubmissions, {}, async (submission) => {
    await insertIfMissing(journal, {
      entryId: `legacy-cash-submission-${submission._id}`,
      businessKey: journalBusinessKey.cashSubmission(submission._id),
      eventType: JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED,
      amount: submission.submittedAmount,
      debitAccount: JOURNAL_ACCOUNTS.VAULT,
      creditAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY,
      sourceRecordType: "CashSubmission",
      sourceRecordId: submission._id,
      actor: submission.createdBy,
      actorRole: USER_ROLES.ADMIN,
      clientRequestId: "",
      effectiveAt: submission.submissionDate || submission.createdAt || new Date(),
      metadata: { migrated: true, staffId: submission.staff },
    });
  });

  await forEachInBatches(
    schemes,
    {
      status: { $in: SETTLED_STATUSES },
      "settlement.amount": { $exists: true, $ne: null },
    },
    async (scheme) => {
      const settlement = scheme.settlement || {};
      const paidKey = `scheme:${scheme._id}:paid:legacy`;
      const existingPaid = await journal.findOne({ businessKey: paidKey }, { projection: { _id: 1 } });
      if (existingPaid) return;

      if (settlement.overrideReason) {
        await appendAmbiguous(ambiguousCollection, {
          schemeId: scheme._id,
          reason: "Legacy settlement overrideReason present; manual journal review required.",
        });
        return;
      }

      if (!settlement.payoutMethod || !Object.values(PAYMENT_METHODS).includes(settlement.payoutMethod)) {
        await appendAmbiguous(ambiguousCollection, {
          schemeId: scheme._id,
          reason: "Legacy settlement payout method is missing or invalid.",
        });
        return;
      }

      const paymentTotals = await payments
        .aggregate([
          {
            $match: {
              scheme: scheme._id,
              status: PAYMENT_STATUS.SUCCESS,
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
            },
          },
        ])
        .toArray();
      const computedTotal = paymentTotals[0]?.total || 0;
      if (computedTotal !== settlement.amount) {
        await appendAmbiguous(ambiguousCollection, {
          schemeId: scheme._id,
          reason: "Legacy settlement amount does not match successful payment total.",
          settlementAmount: settlement.amount,
          computedTotal,
        });
        return;
      }

      const baseAt = settlement.settledAt || scheme.updatedAt || new Date();
      const clientRequestId = settlement.clientRequestId || `legacy-${scheme._id}`;
      await insertIfMissing(journal, {
        entryId: `legacy-scheme-entitlement-${scheme._id}`,
        businessKey: `scheme:${scheme._id}:entitlement:${clientRequestId}`,
        eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_ENTITLEMENT_RECOGNIZED,
        amount: settlement.amount,
        debitAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
        creditAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
        customer: scheme.customer,
        scheme: scheme._id,
        sourceRecordType: "Scheme",
        sourceRecordId: scheme._id,
        actor: settlement.settledBy,
        actorRole: "",
        clientRequestId,
        effectiveAt: baseAt,
        formulaVersion: settlement.formulaVersion || "legacy",
        metadata: { migrated: true, settlementType: scheme.status },
      });

      const paidMetadata = { migrated: true, payoutMethod: settlement.payoutMethod };
      if (settlement.payoutReference) {
        paidMetadata.payoutReference = settlement.payoutReference;
      }
      await insertIfMissing(journal, {
        entryId: `legacy-scheme-paid-${scheme._id}`,
        businessKey: paidKey,
        eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
        amount: settlement.amount,
        debitAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
        creditAccount: JOURNAL_ACCOUNTS.VAULT,
        customer: scheme.customer,
        scheme: scheme._id,
        sourceRecordType: "Scheme",
        sourceRecordId: scheme._id,
        actor: settlement.settledBy,
        clientRequestId,
        effectiveAt: baseAt,
        metadata: paidMetadata,
      });
    }
  );

  await journal.createIndex({ businessKey: 1 }, { unique: true });
  await journal.createIndex({ entryId: 1 }, { unique: true });
  await journal.createIndex({ scheme: 1, eventType: 1, effectiveAt: -1 });
  await journal.createIndex({ customer: 1, effectiveAt: -1 });
};

module.exports = {
  SAFE_EXECUTOR_ID,
  SAFE_EXECUTOR_VERSION,
  runMigration002Safe,
};
