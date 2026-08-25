const mongoose = require("mongoose");
process.env.AJ_MIGRATION_CLI = "1";
const env = require("../config/env");
const { connectDb, CONNECTION_SCHEMA_MODE } = require("../config/db");
const { runMigrations } = require("./runMigrations");
const { verifyRequiredIndexes } = require("../ops/requiredIndexes");

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const verifyOnly = process.argv.includes("--verify");
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is required.");
  }

  await connectDb({ uri: env.mongoUri, schemaMode: CONNECTION_SCHEMA_MODE.RUNTIME });
  const db = mongoose.connection.db;

  const report = await runMigrations(db, { dryRun, verifyOnly });
  if (!dryRun && !verifyOnly) {
    await verifyRequiredIndexes(db);
  }

  console.log(JSON.stringify({ dryRun, verifyOnly, report }, null, 2));
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message || error);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
