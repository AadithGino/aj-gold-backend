#!/usr/bin/env node
require("dotenv").config();

const { spawnSync } = require("node:child_process");
const { assertDestructiveOperationAllowed } = require("../src/ops/destructiveGuard");

const main = () => {
  const mongoUri = process.env.MONGO_URI;
  const archivePath = process.env.RESTORE_ARCHIVE;
  if (!archivePath) {
    throw new Error("RESTORE_ARCHIVE is required.");
  }

  assertDestructiveOperationAllowed({
    mongoUri,
    operationLabel: "database restore",
  });

  const drop = process.env.RESTORE_DROP === "true";
  const args = ["--uri", mongoUri, `--archive=${archivePath}`, "--gzip"];
  if (drop) args.push("--drop");

  const result = spawnSync("mongorestore", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("mongorestore failed. Ensure MongoDB Database Tools are installed.");
  }

  console.log(JSON.stringify({ success: true, archivePath, drop }, null, 2));
};

main();
