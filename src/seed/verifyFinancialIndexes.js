const indexHasShape = (indexes, keyShape, { unique = false, partial = null } = {}) =>
  indexes.some((index) => {
    const keys = Object.keys(index.key || {});
    const shapeKeys = Object.keys(keyShape);
    if (keys.length !== shapeKeys.length) return false;
    if (!shapeKeys.every((key) => index.key[key] === keyShape[key])) return false;
    if (unique && !index.unique) return false;
    if (partial) {
      return JSON.stringify(index.partialFilterExpression || null) === JSON.stringify(partial);
    }
    return true;
  });

const verifyFinancialIndexes = async (db) => {
  const idempotencyIndexes = await db.collection("idempotencyrecords").indexes();
  if (
    !indexHasShape(
      idempotencyIndexes,
      { clientRequestId: 1, operationType: 1 },
      { unique: true }
    )
  ) {
    throw new Error("Missing unique idempotency { clientRequestId, operationType } index.");
  }

  const correctionIndexes = await db.collection("paymentcorrections").indexes();
  if (
    !indexHasShape(
      correctionIndexes,
      { payment: 1 },
      {
        unique: true,
        partial: { status: "PENDING" },
      }
    )
  ) {
    throw new Error("Missing partial unique pending correction index on payment.");
  }

  const paymentIndexes = await db.collection("payments").indexes();
  const paymentExpectations = [
    { scheme: 1, status: 1, paymentDate: -1 },
    { customer: 1, status: 1, paymentDate: -1 },
    { collectedBy: 1, paymentMethod: 1, status: 1, paymentDate: -1 },
  ];
  for (const shape of paymentExpectations) {
    if (!indexHasShape(paymentIndexes, shape)) {
      throw new Error(`Missing payment index ${JSON.stringify(shape)}.`);
    }
  }

  const cashSubmissionIndexes = await db.collection("cashsubmissions").indexes();
  if (!indexHasShape(cashSubmissionIndexes, { staff: 1, submissionDate: -1 })) {
    throw new Error("Missing cash submission staff/date index.");
  }

  const schemeIndexes = await db.collection("schemes").indexes();
  if (!indexHasShape(schemeIndexes, { status: 1, "settlement.settledAt": -1 })) {
    throw new Error("Missing scheme status/settlement date index.");
  }
};

module.exports = {
  verifyFinancialIndexes,
};
