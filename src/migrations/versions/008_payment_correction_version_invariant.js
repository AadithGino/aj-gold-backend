const id = "008_payment_correction_version_invariant";

const INDEX_NAME = "uniq_payment_correction_version_approved";

const ensureApprovedVersions = async (collection) => {
  const cursor = collection.aggregate([
    { $match: { status: "APPROVED" } },
    { $sort: { payment: 1, reviewedAt: 1, createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: "$payment",
        corrections: {
          $push: {
            _id: "$_id",
            version: "$version",
          },
        },
      },
    },
  ]);

  while (await cursor.hasNext()) {
    const row = await cursor.next();
    const updates = [];
    let nextVersion = 1;

    for (const correction of row.corrections) {
      if (correction.version !== nextVersion) {
        updates.push({
          updateOne: {
            filter: { _id: correction._id },
            update: { $set: { version: nextVersion } },
          },
        });
      }
      nextVersion += 1;
    }

    if (updates.length > 0) {
      await collection.bulkWrite(updates, { ordered: true });
    }
  }
};

const up = async (db) => {
  const paymentCorrections = db.collection("paymentcorrections");
  await ensureApprovedVersions(paymentCorrections);

  const indexes = await paymentCorrections.indexes().catch(() => []);
  const existing = indexes.find((index) => index.name === INDEX_NAME);
  if (existing) {
    await paymentCorrections.dropIndex(INDEX_NAME);
  }

  await paymentCorrections.createIndex(
    { payment: 1, version: 1 },
    {
      name: INDEX_NAME,
      unique: true,
      partialFilterExpression: {
        status: "APPROVED",
        version: { $exists: true, $type: "number", $gt: 0 },
      },
    }
  );
};

const down = async () => {
  // Do not drop production safety indexes in rollback.
};

module.exports = { id, up, down };
