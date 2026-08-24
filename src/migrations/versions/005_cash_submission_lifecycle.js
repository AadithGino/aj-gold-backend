const { CASH_SUBMISSION_STATUS } = require("../../constants/enums");

const id = "005_cash_submission_lifecycle";

const up = async (db) => {
  const collection = db.collection("cashsubmissions");
  await collection.updateMany(
    { status: { $exists: false } },
    { $set: { status: CASH_SUBMISSION_STATUS.ACTIVE } }
  );

  const indexes = await collection.indexes().catch(() => []);
  const hasStaffActiveIndex = indexes.some((index) => index.name === "staff_active_submissions");
  if (!hasStaffActiveIndex) {
    await collection.createIndex(
      { staff: 1, status: 1, submissionDate: -1 },
      { name: "staff_active_submissions" }
    );
  }
};

const down = async () => {
  // Lifecycle fields are retained to preserve audit history.
};

module.exports = { id, up, down };
