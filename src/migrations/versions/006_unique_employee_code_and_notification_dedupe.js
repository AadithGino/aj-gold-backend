const { REQUIRED_INDEXES } = require("../../ops/requiredIndexes");

const id = "006_unique_employee_code_and_notification_dedupe";

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

  await collection.createIndex(spec.key, options);
};

const up = async (db) => {
  const staffProfiles = db.collection("staffprofiles");
  const duplicates = await staffProfiles
    .aggregate([
      {
        $match: {
          employeeCode: { $exists: true, $type: "string", $gt: "" },
        },
      },
      {
        $group: {
          _id: "$employeeCode",
          count: { $sum: 1 },
          profileIds: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  if (duplicates.length) {
    const error = new Error(
      `Duplicate employeeCode values detected: ${duplicates.map((row) => row._id).join(", ")}`
    );
    error.duplicates = duplicates.map((row) => ({
      employeeCode: row._id,
      profileIds: row.profileIds,
      count: row.count,
    }));
    throw error;
  }

  const newSpecs = REQUIRED_INDEXES.filter(
    (spec) =>
      spec.collection === "staffprofiles" || spec.collection === "notifications"
  );

  for (const spec of newSpecs) {
    await ensureIndex(db.collection(spec.collection), spec);
  }
};

const down = async () => {
  // Intentionally omitted.
};

module.exports = { id, up, down };
