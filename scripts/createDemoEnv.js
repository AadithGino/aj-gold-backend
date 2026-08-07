#!/usr/bin/env node
/**
 * Creates backend/.env.demo from backend/.env with database name ajgold_demo only.
 * Does not print credentials or secrets.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const srcPath = path.join(root, ".env");
const demoPath = path.join(root, ".env.demo");

const extractDbName = (uri) => {
  if (!uri) return "";
  const withoutQuery = uri.split("?")[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return last.includes(":") ? "" : last;
};

const replaceDbName = (uri, nextName) => {
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/]+\/)([^/?]+)(.*)$/);
  if (!match) {
    throw new Error("Could not parse MONGO_URI path segment.");
  }
  return `${match[1]}${nextName}${match[3] || ""}`;
};

if (!fs.existsSync(srcPath)) {
  console.error("Missing backend/.env — copy from .env.example and configure Atlas credentials first.");
  process.exit(1);
}

const raw = fs.readFileSync(srcPath, "utf8");
const lines = raw.split(/\r?\n/);
const out = [];
const seen = new Set();

for (const line of lines) {
  if (!line.trim() || line.trim().startsWith("#")) {
    out.push(line);
    continue;
  }

  const eq = line.indexOf("=");
  if (eq === -1) {
    out.push(line);
    continue;
  }

  const key = line.slice(0, eq);
  const val = line.slice(eq + 1);
  seen.add(key);

  if (key === "MONGO_URI") {
    out.push(`MONGO_URI=${replaceDbName(val.trim(), "ajgold_demo")}`);
  } else if (key === "ALLOW_DATABASE_RESET") {
    out.push("ALLOW_DATABASE_RESET=true");
  } else if (key === "NODE_ENV") {
    out.push("NODE_ENV=development");
  } else if (key === "JWT_SECRET") {
    const secret = val.trim();
    out.push(
      secret.length >= 32
        ? line
        : `JWT_SECRET=${crypto.randomBytes(32).toString("hex")}`
    );
  } else if (key === "JWT_EXPIRES_IN") {
    out.push("JWT_EXPIRES_IN=8h");
  } else if (key === "CORS_ORIGINS") {
    out.push("CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000");
  } else {
    out.push(line);
  }
}

if (!seen.has("ALLOW_DATABASE_RESET")) out.push("ALLOW_DATABASE_RESET=true");
if (!seen.has("NODE_ENV")) out.push("NODE_ENV=development");
if (!seen.has("JWT_EXPIRES_IN")) out.push("JWT_EXPIRES_IN=8h");
if (!seen.has("CORS_ORIGINS")) {
  out.push("CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000");
}
if (!seen.has("PORT")) out.push("PORT=8000");

const mongoLine = out.find((l) => l.startsWith("MONGO_URI="));
if (!mongoLine) {
  console.error("MONGO_URI missing from backend/.env");
  process.exit(1);
}

const mongoUri = mongoLine.slice("MONGO_URI=".length);
const dbName = extractDbName(mongoUri);
if (dbName !== "ajgold_demo") {
  console.error(`Refusing to write .env.demo: expected database ajgold_demo, got "${dbName}".`);
  process.exit(1);
}

fs.writeFileSync(demoPath, `${out.join("\n")}\n`, { mode: 0o600 });
console.log(`Created ${demoPath}`);
console.log(`Confirmed database name: ${dbName}`);
