const { REQUIRED_INDEXES } = require("../../ops/requiredIndexes");

const id = "004_required_query_indexes";

const ensureIndex = async (collection, spec) => {
  const indexes = await collection.indexes().catch(() => []);
  const exists = indexes.some((index) => {
    const keys = Object.keys(index.key || {});
    const shapeKeys = Object.keys(spec.key);
    if (keys.length !== shapeKeys.length) return false;
    return shapeKeys.every((key) => index.key[key] === spec.key[key]);
  });
  if (exists) return;

  const options = {};
  if (spec.unique) options.unique = true;
  if (spec.name) options.name = spec.name;
  if (spec.partial) options.partialFilterExpression = spec.partial;
  if (spec.ttl !== undefined) options.expireAfterSeconds = spec.ttl;

  await collection.createIndex(spec.key, options);
};

const up = async (db) => {
  for (const spec of REQUIRED_INDEXES) {
    await ensureIndex(db.collection(spec.collection), spec);
  }
};

const down = async () => {
  // Index rollback is intentionally omitted to avoid dropping production-critical indexes.
};

module.exports = { id, up, down };
