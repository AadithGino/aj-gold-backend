const mongoose = require("mongoose");
const { ENTITLEMENT_FORMULA_VERSION } = require("../constants/settlementContract");
const { BUSINESS_TIMEZONE } = require("../utils/date");
const { withTransaction } = require("../utils/transaction");
const { verifyRequiredIndexes } = require("./requiredIndexes");
const { verifyMigrationsApplied } = require("../migrations/runMigrations");

const PREFLIGHT_TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS || 10000);

const withTimeout = async (promise, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${PREFLIGHT_TIMEOUT_MS}ms`)),
      PREFLIGHT_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const assertReplicaSetTopology = async (db) => {
  const hello = await db.admin().command({ hello: 1 });
  const isReplicaSet = Boolean(hello.setName) || hello.msg === "isdbgrid";
  if (!isReplicaSet) {
    throw new Error("MongoDB must be a replica set for financial transactions.");
  }
};

const assertTransactionCapability = async () => {
  await withTransaction(async (session) => {
    await mongoose.connection.db
      .collection("schema_migrations")
      .findOne({}, { session });
  });
};

const runStartupPreflight = async ({ requireMigrations = true } = {}) => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB is not connected.");
  }

  await withTimeout(assertReplicaSetTopology(db), "Replica set check");
  await withTimeout(assertTransactionCapability(), "Transaction capability check");

  if (requireMigrations) {
    await withTimeout(verifyMigrationsApplied(db), "Migration verify");
    await withTimeout(verifyRequiredIndexes(db), "Index verify");
    const unresolvedAmbiguous = await db
      .collection("journal_migration_ambiguous")
      .countDocuments({ resolved: { $ne: true } });
    if (unresolvedAmbiguous > 0) {
      throw new Error(
        `Unresolved legacy migration ambiguity rows: ${unresolvedAmbiguous}. Resolve before production start.`
      );
    }
  }

  if (!BUSINESS_TIMEZONE || BUSINESS_TIMEZONE !== "Asia/Kolkata") {
    throw new Error(`Business timezone must be Asia/Kolkata (found ${BUSINESS_TIMEZONE}).`);
  }

  const expectedFormula = process.env.SETTLEMENT_FORMULA_VERSION || ENTITLEMENT_FORMULA_VERSION;
  if (expectedFormula !== ENTITLEMENT_FORMULA_VERSION) {
    throw new Error(
      `Unsupported settlement formula version "${expectedFormula}". Expected ${ENTITLEMENT_FORMULA_VERSION}.`
    );
  }

  return {
    replicaSet: true,
    transactions: true,
    indexes: true,
    migrations: requireMigrations,
    timezone: BUSINESS_TIMEZONE,
    settlementFormulaVersion: ENTITLEMENT_FORMULA_VERSION,
  };
};

module.exports = {
  runStartupPreflight,
  assertReplicaSetTopology,
  assertTransactionCapability,
  withTimeout,
};
