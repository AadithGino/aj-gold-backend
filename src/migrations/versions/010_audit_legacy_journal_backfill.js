const { JOURNAL_EVENT_TYPES, PAYMENT_METHODS } = require("../../constants/enums");

const id = "010_audit_legacy_journal_backfill";

const MIGRATION_ID = "010_audit_legacy_journal_backfill";

const recordAmbiguity = async (collection, payload) => {
  await collection.updateOne(
    {
      migrationId: MIGRATION_ID,
      reason: payload.reason,
      schemeId: payload.schemeId || null,
      journalId: payload.journalId || null,
    },
    {
      $set: {
        ...payload,
        migrationId: MIGRATION_ID,
        resolved: false,
        recordedAt: new Date(),
      },
    },
    { upsert: true }
  );
};

const up = async (db) => {
  const journal = db.collection("financialjournals");
  const schemes = db.collection("schemes");
  const ambiguous = db.collection("journal_migration_ambiguous");

  const authorizedRows = await journal
    .find({
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_AUTHORIZED,
      "metadata.migrated": true,
    })
    .project({ _id: 1, scheme: 1, debitAccount: 1, creditAccount: 1, businessKey: 1 })
    .toArray();
  for (const row of authorizedRows) {
    await recordAmbiguity(ambiguous, {
      schemeId: row.scheme || null,
      journalId: row._id,
      businessKey: row.businessKey,
      reason: "Legacy settlement authorization journal entry requires manual resolution.",
      details: {
        debitAccount: row.debitAccount || null,
        creditAccount: row.creditAccount || null,
      },
    });
  }

  const paidRows = await journal
    .find({
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
      "metadata.migrated": true,
    })
    .project({ _id: 1, scheme: 1, metadata: 1, businessKey: 1 })
    .toArray();

  for (const row of paidRows) {
    const payoutMethod = row.metadata?.payoutMethod;
    if (!payoutMethod || !Object.values(PAYMENT_METHODS).includes(payoutMethod)) {
      await recordAmbiguity(ambiguous, {
        schemeId: row.scheme || null,
        journalId: row._id,
        businessKey: row.businessKey,
        reason: "Legacy settlement paid journal has missing or invalid payout method.",
        details: { payoutMethod: payoutMethod || null },
      });
    }
    if (row.metadata?.payoutReference === "legacy-migration") {
      await recordAmbiguity(ambiguous, {
        schemeId: row.scheme || null,
        journalId: row._id,
        businessKey: row.businessKey,
        reason: "Legacy settlement paid journal contains fabricated payout reference placeholder.",
        details: { payoutReference: row.metadata.payoutReference },
      });
    }
  }

  const settledSchemes = await schemes
    .find({
      status: { $in: ["REDEEMED", "CLOSED"] },
      "settlement.amount": { $exists: true, $ne: null },
    })
    .project({ _id: 1, settlement: 1 })
    .toArray();

  for (const scheme of settledSchemes) {
    const settlementPaid = await journal.findOne({
      scheme: scheme._id,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
    });
    if (!settlementPaid) {
      await recordAmbiguity(ambiguous, {
        schemeId: scheme._id,
        reason: "Legacy settled scheme is missing settlement paid journal entry.",
        details: {
          settlementAmount: scheme.settlement?.amount || null,
        },
      });
    }
  }
};

const down = async () => {
  // No rollback for historical ambiguity evidence.
};

module.exports = { id, up, down };
