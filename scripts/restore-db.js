#!/usr/bin/env node
require("dotenv").config();

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { assertDestructiveOperationAllowed } = require("../src/ops/destructiveGuard");

const main = () => {
  const mongoUri = process.env.MONGO_URI;
  const archivePath = process.env.RESTORE_ARCHIVE;
  if (!archivePath) {
    throw new Error("RESTORE_ARCHIVE is required.");
  }
  if (!fs.existsSync(archivePath)) {
    throw new Error(`RESTORE_ARCHIVE does not exist: ${archivePath}`);
  }

  const sidecarPath = process.env.RESTORE_SIDECAR || `${archivePath}.sha256.json`;
  if (fs.existsSync(sidecarPath)) {
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    const archiveBuffer = fs.readFileSync(archivePath);
    const sha256 = crypto.createHash("sha256").update(archiveBuffer).digest("hex");
    if (sidecar.sha256 !== sha256) {
      throw new Error(
        `Archive SHA-256 mismatch for ${archivePath}. Expected ${sidecar.sha256}, got ${sha256}.`
      );
    }
  }

  assertDestructiveOperationAllowed({
    mongoUri,
    operationLabel: "database restore",
  });

  const drop = process.env.RESTORE_DROP === "true";
  const args = ["--uri", mongoUri, `--archive=${archivePath}`, "--gzip"];
  const nsFrom = process.env.RESTORE_NS_FROM;
  const nsTo = process.env.RESTORE_NS_TO;
  if ((nsFrom && !nsTo) || (!nsFrom && nsTo)) {
    throw new Error("RESTORE_NS_FROM and RESTORE_NS_TO must be provided together.");
  }
  if (nsFrom && nsTo) {
    args.push("--nsInclude", nsFrom);
    args.push("--nsFrom", nsFrom, "--nsTo", nsTo);
  }
  if (drop) args.push("--drop");

  const result = spawnSync("mongorestore", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("mongorestore failed. Ensure MongoDB Database Tools are installed.");
  }

  console.log(JSON.stringify({ success: true, archivePath, drop }, null, 2));
};

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
