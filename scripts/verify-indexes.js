#!/usr/bin/env node
process.env.AJ_MIGRATION_CLI = "1";
require("dotenv").config();

const mongoose = require("mongoose");
const { connectDb } = require("../src/config/db");
const { verifyRequiredIndexes } = require("../src/ops/requiredIndexes");

const main = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required.");
  }

  await connectDb(process.env.MONGO_URI);
  const result = await verifyRequiredIndexes(mongoose.connection.db);
  console.log(JSON.stringify({ success: true, ...result }, null, 2));
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message || error);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
