const { SCHEME_STATUS } = require("../../constants/enums");

const ACTIVE_SCHEME_INDEX = "uniq_customer_active_scheme";

module.exports = {
  id: "001_one_active_scheme_per_customer",
  description: "Enforce exactly one ACTIVE scheme per customer.",
  async up(db) {
    const duplicates = await db
      .collection("schemes")
      .aggregate([
        { $match: { status: SCHEME_STATUS.ACTIVE } },
        {
          $group: {
            _id: "$customer",
            count: { $sum: 1 },
            schemeIds: { $push: "$_id" },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicates.length > 0) {
      const details = duplicates.map((row) => ({
        customerId: row._id,
        activeSchemeIds: row.schemeIds,
        count: row.count,
      }));
      throw new Error(
        `Duplicate ACTIVE schemes detected. Resolve manually before migration: ${JSON.stringify(details)}`
      );
    }

    const indexes = await db.collection("schemes").indexes();
    const exists = indexes.some((index) => index.name === ACTIVE_SCHEME_INDEX);
    if (!exists) {
      await db.collection("schemes").createIndex(
        { customer: 1 },
        {
          unique: true,
          name: ACTIVE_SCHEME_INDEX,
          partialFilterExpression: { status: SCHEME_STATUS.ACTIVE },
        }
      );
    }
  },
  async down(db) {
    try {
      await db.collection("schemes").dropIndex(ACTIVE_SCHEME_INDEX);
    } catch (error) {
      if (error?.codeName !== "IndexNotFound") {
        throw error;
      }
    }
  },
};
