#!/usr/bin/env node
require("dotenv").config();

const mongoose = require("mongoose");
const { connectDb, CONNECTION_SCHEMA_MODE } = require("../src/config/db");
const { scanIntegrity } = require("../src/ops/integrityScanner");

const main = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required.");
  }

  await connectDb({
    uri: process.env.MONGO_URI,
    schemaMode: CONNECTION_SCHEMA_MODE.RUNTIME,
  });
  const report = await scanIntegrity({ db: mongoose.connection.db });
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();

  if (!report.ok) {
    process.exit(1);
  }
};

main().catch(async (error) => {
  console.error(error.message || error);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
