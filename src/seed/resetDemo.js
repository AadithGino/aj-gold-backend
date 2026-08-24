require("dotenv").config();

const { execSync } = require("node:child_process");
const path = require("node:path");
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const { assertDestructiveOperationAllowed } = require("../ops/destructiveGuard");
const { runMigrations } = require("../migrations/runMigrations");
const { verifyRequiredIndexes } = require("../ops/requiredIndexes");

const run = async () => {
  const mongoUri = process.env.MONGO_URI;
  const dbName = assertDestructiveOperationAllowed({
    mongoUri,
    operationLabel: "demo database reset",
  });

  console.log(`Resetting demo database: ${dbName}`);

  await connectDb(mongoUri);
  await mongoose.connection.dropDatabase();
  console.log("✓ Database dropped");

  const report = await runMigrations(mongoose.connection.db);
  await verifyRequiredIndexes(mongoose.connection.db);
  console.log("✓ Migrations and indexes applied", report.map((row) => row.id).join(", "));

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
