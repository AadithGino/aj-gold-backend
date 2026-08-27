const { REQUIRED_INDEXES, indexHasShape } = require("../../ops/requiredIndexes");

const id = "012_scheme_settlement_history_indexes";

const INDEX_NAMES = [
  "schemes_customer_terminal_settledAt",
  "schemes_settledBy_terminal_settledAt",
];

const ensureIndex = async (collection, spec) => {
  const indexes = await collection.indexes().catch(() => []);
  if (
    indexHasShape(indexes, spec.key, {
      unique: spec.unique,
      partial: spec.partial,
      name: spec.name,
    })
  ) {
    return;
  }

  for (const index of indexes) {
    if (index.name === "_id_") continue;
    if (index.name === spec.name) {
      await collection.dropIndex(index.name);
      continue;
    }
    const sameKey =
      JSON.stringify(Object.entries(index.key || {})) ===
      JSON.stringify(Object.entries(spec.key));
    if (sameKey) {
      await collection.dropIndex(index.name);
    }
  }

  const options = { name: spec.name };
  if (spec.unique) options.unique = true;
  if (spec.partial) options.partialFilterExpression = spec.partial;
  await collection.createIndex(spec.key, options);
};

const up = async (db) => {
  const specs = REQUIRED_INDEXES.filter((spec) => INDEX_NAMES.includes(spec.name));
  for (const spec of specs) {
    await ensureIndex(db.collection(spec.collection), spec);
  }
};

const down = async () => {
  // Index rollback is intentionally omitted to avoid dropping production-critical indexes.
};

module.exports = { id, up, down };
