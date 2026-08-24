#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadMigrationFiles } = require("../src/migrations/runMigrations");

const backendRoot = path.resolve(__dirname, "..");
const archiveName = "aj-gold-backend-final-production-candidate.zip";
const archivePath = path.join(backendRoot, archiveName);

const excludes = [
  "node_modules/*",
  ".git/*",
  ".env",
  ".env.*",
  "!.env.example",
  "*.log",
  "coverage/*",
  ".nyc_output/*",
  "backups/*",
  "*.zip",
  "*.sha256.json",
  "archive-manifest.json",
  ".DS_Store",
  "npm-debug.log*",
];

if (fs.existsSync(archivePath)) {
  fs.unlinkSync(archivePath);
}

const excludeArgs = excludes.flatMap((pattern) => ["-x", pattern]);
execFileSync("zip", ["-r", archivePath, ".", ...excludeArgs], {
  cwd: backendRoot,
  stdio: "inherit",
});

const buffer = fs.readFileSync(archivePath);
const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
const migrations = loadMigrationFiles();
const sidecarName = `${archiveName}.sha256.json`;
const sidecarPath = path.join(backendRoot, sidecarName);

let gitCommit = "unknown";
try {
  gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: backendRoot,
    encoding: "utf8",
  }).trim();
} catch {
  gitCommit = process.env.GIT_COMMIT || "unknown";
}

const sidecar = {
  filename: archiveName,
  bytes: buffer.length,
  sha256,
  gitCommit,
  createdAt: new Date().toISOString(),
  migrationRange: {
    first: migrations[0]?.id || null,
    last: migrations[migrations.length - 1]?.id || null,
    count: migrations.length,
  },
  testEvidence: "npm test",
};

fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
console.log(JSON.stringify({ archiveName, sidecarName, ...sidecar }, null, 2));
