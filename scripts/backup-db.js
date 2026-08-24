#!/usr/bin/env node
require("dotenv").config();

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertBackupAllowed } = require("../src/ops/destructiveGuard");

const main = () => {
  const mongoUri = process.env.MONGO_URI;
  const dbName = assertBackupAllowed({ mongoUri });

  const backupDir = path.resolve(process.env.BACKUP_DIR || "./backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(backupDir, `${dbName}-${stamp}.archive.gz`);

  const result = spawnSync(
    "mongodump",
    ["--uri", mongoUri, `--archive=${archivePath}`, "--gzip"],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    throw new Error("mongodump failed. Ensure MongoDB Database Tools are installed.");
  }

  const buffer = fs.readFileSync(archivePath);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const sidecarPath = `${archivePath}.sha256.json`;
  const sidecar = {
    archivePath,
    dbName,
    bytes: buffer.length,
    sha256,
    createdAt: new Date().toISOString(),
    readOnly: true,
  };
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

  console.log(JSON.stringify({ success: true, archivePath, sidecarPath, dbName, sha256 }, null, 2));
};

main();
