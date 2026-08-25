const { REQUIRED_INDEXES, indexHasShape } = require("../../ops/requiredIndexes");

const id = "009_enforce_required_index_options";

const hasOrderedKeyShape = (indexKey, keyShape) => {
  const indexEntries = Object.entries(indexKey || {});
  const shapeEntries = Object.entries(keyShape || {});
  if (indexEntries.length !== shapeEntries.length) return false;
  return shapeEntries.every(
    ([field, direction], idx) =>
      indexEntries[idx]?.[0] === field && indexEntries[idx]?.[1] === direction
  );
};

const uniqueDuplicateMatchers = {
  staffprofiles: {
    field: "employeeCode",
    match: {
      employeeCode: { $exists: true, $type: "string", $gt: "" },
    },
  },
  notifications: {
    field: "deliveryKey",
    match: {
      deliveryKey: { $exists: true, $type: "string", $gt: "" },
    },
  },
};

const assertNoUniqueDuplicates = async (collection, collectionName) => {
  const config = uniqueDuplicateMatchers[collectionName];
  if (!config) return;
  const duplicates = await collection
    .aggregate([
      { $match: config.match },
      {
        $group: {
          _id: `$${config.field}`,
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  if (duplicates.length === 0) return;

  const details = duplicates.map((row) => ({
    value: row._id,
    count: row.count,
    ids: row.ids,
  }));
  const error = new Error(
    `Duplicate values prevent unique index enforcement on ${collectionName}.${config.field}.`
  );
  error.duplicates = details;
  throw error;
};

const enforceIndexSpec = async (db, spec) => {
  const collection = db.collection(spec.collection);
  const indexes = await collection.indexes().catch(() => []);
  if (
    indexHasShape(indexes, spec.key, {
      unique: spec.unique,
      partial: spec.partial,
      name: spec.name,
      ttl: spec.ttl,
      sparse: spec.sparse,
      collation: spec.collation,
    })
  ) {
    return;
  }

  if (spec.unique) {
    await assertNoUniqueDuplicates(collection, spec.collection);
  }

  for (const index of indexes) {
    if (index.name === "_id_") continue;
    if (!hasOrderedKeyShape(index.key, spec.key)) continue;
    await collection.dropIndex(index.name);
  }

  const options = {};
  if (spec.unique) options.unique = true;
  if (spec.name) options.name = spec.name;
  if (spec.partial) options.partialFilterExpression = spec.partial;
  if (spec.ttl !== undefined) options.expireAfterSeconds = spec.ttl;
  if (spec.sparse !== undefined) options.sparse = spec.sparse;
  if (spec.collation) options.collation = spec.collation;
  await collection.createIndex(spec.key, options);
};

const up = async (db) => {
  for (const spec of REQUIRED_INDEXES) {
    await enforceIndexSpec(db, spec);
  }
};

const down = async () => {
  // No destructive rollback for operational index safety migration.
};

module.exports = { id, up, down };
