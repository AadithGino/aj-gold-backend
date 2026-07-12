require("dotenv").config();

const { execSync } = require("node:child_process");
const path = require("node:path");
const mongoose = require("mongoose");
const { NODE_ENV } = require("../config/env");
const { connectDb } = require("../config/db");
const { verifyFinancialIndexes } = require("./verifyFinancialIndexes");

const extractDbName = (uri) => {
  if (!uri) return "";
  const withoutQuery = uri.split("?")[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return last.includes(":") ? "" : last;
};

const assertResetAllowed = (mongoUri) => {
  if (NODE_ENV === "production") {
    throw new Error("Refusing to reset database when NODE_ENV=production.");
  }
  if (process.env.ALLOW_DATABASE_RESET !== "true") {
    throw new Error("Set ALLOW_DATABASE_RESET=true to reset the development database.");
  }

  const dbName = extractDbName(mongoUri).toLowerCase();
  if (!dbName) {
    throw new Error("Could not determine database name from MONGO_URI.");
  }
  if (!/(dev|demo|test)/.test(dbName)) {
    throw new Error(
      `Refusing to reset database "${dbName}". Database name must contain dev, demo, or test.`
    );
  }
  return dbName;
};

const ensureModelIndexes = async () => {
  const models = [
    require("../models/idempotencyRecord.model"),
    require("../models/paymentCorrection.model"),
    require("../models/payment.model"),
    require("../models/cashSubmission.model"),
    require("../models/scheme.model"),
    require("../models/user.model"),
    require("../models/staffProfile.model"),
    require("../models/customer.model"),
    require("../models/auditLog.model"),
    require("../models/receiptCounter.model"),
  ];

  for (const model of models) {
    await model.init();
    await model.syncIndexes();
  }
};

const run = async () => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is required.");
  }

  const dbName = assertResetAllowed(mongoUri);
  console.log(`Resetting demo database: ${dbName}`);

  await connectDb(mongoUri);
  await mongoose.connection.dropDatabase();
  console.log("✓ Database dropped");

  await ensureModelIndexes();
  await verifyFinancialIndexes(mongoose.connection.db);
  console.log("✓ Financial indexes verified");

  await mongoose.disconnect();

  const seedScript = path.join(__dirname, "seedCashVaultDemo.js");
  execSync(`node "${seedScript}"`, {
    stdio: "inherit",
    env: process.env,
  });

  console.log("\n✓ Demo database reset complete");
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
