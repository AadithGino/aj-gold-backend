const {
  PAYMENT_STATUS,
  SCHEME_STATUS,
  JOURNAL_EVENT_TYPES,
  USER_ROLES,
} = require("../../constants/enums");
const { JOURNAL_ACCOUNTS } = require("../../constants/journalAccounts");
const { journalBusinessKey } = require("../../utils/journalRecording");

const SETTLED_STATUSES = [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED];

const collectionAccountsForPayment = (payment) => {
  if (payment.paymentMethod === "CASH" && payment.collectedByRole === USER_ROLES.STAFF) {
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
  const existing = await collection.findOne({ businessKey: entry.businessKey });
  if (existing) {
    return { status: "skipped", entry: existing };
  }
  const result = await collection.insertOne({
    ...entry,
    recordedAt: entry.recordedAt || new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { status: "inserted", entry: { _id: result.insertedId, ...entry } };
};

module.exports = {
  id: "002_financial_journal_backfill",
  description: "Backfill immutable financial journal entries from legacy records.",
  async up(db) {
    const journal = db.collection("financialjournals");
    const payments = db.collection("payments");
    const cashSubmissions = db.collection("cashsubmissions");
    const schemes = db.collection("schemes");

    const ambiguous = [];

    const paymentRows = await payments.find({ status: PAYMENT_STATUS.SUCCESS }).toArray();
    for (const payment of paymentRows) {
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
    }

    const reversedPayments = await payments.find({ status: PAYMENT_STATUS.REVERSED }).toArray();
    for (const payment of reversedPayments) {
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
    }

    const submissions = await cashSubmissions.find({}).toArray();
    for (const submission of submissions) {
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
    }

    const settledSchemes = await schemes
      .find({
        status: { $in: SETTLED_STATUSES },
        "settlement.amount": { $exists: true, $ne: null },
      })
      .toArray();

    for (const scheme of settledSchemes) {
      const settlement = scheme.settlement;
      const paidKey = `scheme:${scheme._id}:paid:legacy`;
      const existingPaid = await journal.findOne({ businessKey: paidKey });
      if (existingPaid) {
        continue;
      }

      if (settlement.overrideReason) {
        ambiguous.push({
          schemeId: scheme._id,
          reason: "Legacy settlement overrideReason present; manual journal review required.",
        });
        continue;
      }

      const successfulPayments = await payments
        .find({ scheme: scheme._id, status: PAYMENT_STATUS.SUCCESS })
        .toArray();
      const computedTotal = successfulPayments.reduce((sum, row) => sum + row.amount, 0);

      if (computedTotal !== settlement.amount) {
        ambiguous.push({
          schemeId: scheme._id,
          reason: "Legacy settlement amount does not match successful payment total.",
          settlementAmount: settlement.amount,
          computedTotal,
        });
        continue;
      }

      const baseAt = settlement.settledAt || scheme.updatedAt || new Date();
      const clientRequestId = settlement.clientRequestId || "legacy";

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

      await insertIfMissing(journal, {
        entryId: `legacy-scheme-authorized-${scheme._id}`,
        businessKey: `scheme:${scheme._id}:authorized:${clientRequestId}`,
        eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_AUTHORIZED,
        amount: settlement.amount,
        debitAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
        creditAccount: JOURNAL_ACCOUNTS.SETTLEMENT_PAYABLE,
        customer: scheme.customer,
        scheme: scheme._id,
        sourceRecordType: "Scheme",
        sourceRecordId: scheme._id,
        actor: settlement.settledBy,
        clientRequestId,
        effectiveAt: baseAt,
        metadata: { migrated: true },
      });

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
        metadata: {
          migrated: true,
          payoutMethod: settlement.payoutMethod || "UPI",
          payoutReference: settlement.payoutReference || "legacy-migration",
        },
      });
    }

    if (ambiguous.length > 0) {
      await db.collection("journal_migration_ambiguous").insertMany(
        ambiguous.map((row) => ({
          ...row,
          migrationId: "002_financial_journal_backfill",
          recordedAt: new Date(),
        }))
      );
    }

    await journal.createIndex({ businessKey: 1 }, { unique: true });
    await journal.createIndex({ entryId: 1 }, { unique: true });
    await journal.createIndex({ scheme: 1, eventType: 1, effectiveAt: -1 });
    await journal.createIndex({ customer: 1, effectiveAt: -1 });
  },
  async down(db) {
    await db.collection("financialjournals").deleteMany({ "metadata.migrated": true });
    await db.collection("journal_migration_ambiguous").deleteMany({
      migrationId: "002_financial_journal_backfill",
    });
  },
};
