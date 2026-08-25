const { indexHasShape } = require("../../ops/requiredIndexes");

const id = "011_payment_correction_version_backfill_batched";
const INDEX_NAME = "uniq_payment_correction_version_approved";
const CHECKPOINT_COLLECTION = "schema_migration_progress";
const CHECKPOINT_ID = id;
const BATCH_SIZE = 200;

const ensureApprovedVersionIndex = async (collection) => {
  const expected = {
    key: { payment: 1, version: 1 },
    unique: true,
    name: INDEX_NAME,
    partial: {
      status: "APPROVED",
      version: { $exists: true, $type: "number", $gt: 0 },
    },
  };
  const indexes = await collection.indexes().catch(() => []);
  if (
    indexHasShape(indexes, expected.key, {
      unique: expected.unique,
      name: expected.name,
      partial: expected.partial,
    })
  ) {
    return;
  }
  for (const index of indexes) {
    if (index.name === "_id_") continue;
    const sameKey =
      JSON.stringify(Object.entries(index.key || {})) ===
      JSON.stringify(Object.entries(expected.key));
    if (sameKey) {
      await collection.dropIndex(index.name);
    }
  }
  await collection.createIndex(expected.key, {
    name: expected.name,
    unique: true,
    partialFilterExpression: expected.partial,
  });
};

const getNextPaymentIds = async (collection, lastPaymentId) => {
  const match = { status: "APPROVED" };
  if (lastPaymentId) {
    match.payment = { $gt: lastPaymentId };
  }
  const rows = await collection
    .aggregate([
      { $match: match },
      { $group: { _id: "$payment" } },
      { $sort: { _id: 1 } },
      { $limit: BATCH_SIZE },
    ])
    .toArray();
  return rows.map((row) => row._id);
};

const normalizeVersionsForPayment = async (collection, paymentId) => {
  const rows = await collection
    .find({ payment: paymentId, status: "APPROVED" })
    .sort({ reviewedAt: 1, createdAt: 1, _id: 1 })
    .project({ _id: 1, version: 1 })
    .toArray();

  const updates = [];
  let expectedVersion = 1;
  for (const row of rows) {
    if (row.version !== expectedVersion) {
      updates.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { version: expectedVersion } },
        },
      });
    }
    expectedVersion += 1;
  }
  if (updates.length > 0) {
    await collection.bulkWrite(updates, { ordered: true });
  }
};

const up = async (db) => {
  const corrections = db.collection("paymentcorrections");
  const progress = db.collection(CHECKPOINT_COLLECTION);
  let checkpoint = await progress.findOne({ _id: CHECKPOINT_ID });
  if (!checkpoint) {
    checkpoint = { _id: CHECKPOINT_ID, lastPaymentId: null, completed: false };
    await progress.insertOne(checkpoint);
  }

  while (true) {
    const paymentIds = await getNextPaymentIds(corrections, checkpoint.lastPaymentId || null);
    if (paymentIds.length === 0) break;
    for (const paymentId of paymentIds) {
      await normalizeVersionsForPayment(corrections, paymentId);
      checkpoint.lastPaymentId = paymentId;
      await progress.updateOne(
        { _id: CHECKPOINT_ID },
        {
          $set: {
            lastPaymentId: paymentId,
            updatedAt: new Date(),
          },
        }
      );
    }
  }

  await ensureApprovedVersionIndex(corrections);
  await progress.updateOne(
    { _id: CHECKPOINT_ID },
    {
      $set: {
        completed: true,
        completedAt: new Date(),
      },
    }
  );
};

const down = async () => {
  // No destructive rollback for correction version invariants.
};

module.exports = { id, up, down };
