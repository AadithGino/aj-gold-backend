const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const backendRoot = path.resolve(__dirname, "..");
const archiveName = "aj-gold-backend-final-production-candidate.zip";
const archivePath = path.join(backendRoot, archiveName);
const sidecarPath = path.join(backendRoot, `${archiveName}.sha256.json`);

const forbiddenArchivePatterns = [
  /^\.env$/,
  /^\.env\./,
  /node_modules\//,
  /\.git\//,
  /backups\//,
  /\.zip$/,
  /\.sha256\.json$/,
];

describe("Corrective Phase 7 — release packaging and contract freeze", () => {
  it("package script produces sanitized archive and external sidecar manifest", () => {
    execFileSync("node", ["scripts/package-final-archive.js"], {
      cwd: backendRoot,
      stdio: "pipe",
    });

    assert.ok(fs.existsSync(archivePath), "archive zip must exist");
    assert.ok(fs.existsSync(sidecarPath), "external sidecar manifest must exist");

    const listing = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
    const entries = listing.split("\n").filter(Boolean);

    assert.ok(entries.length > 20, "archive must contain source files");
    for (const entry of entries) {
      if (entry === ".env.example") continue;
      for (const pattern of forbiddenArchivePatterns) {
        assert.equal(
          pattern.test(entry),
          false,
          `forbidden archive entry: ${entry}`
        );
      }
    }

    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    const buffer = fs.readFileSync(archivePath);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    assert.equal(sidecar.filename, archiveName);
    assert.equal(sidecar.bytes, buffer.length);
    assert.equal(sidecar.sha256, sha256);
    assert.ok(sidecar.migrationRange?.count >= 6);
    assert.equal(sidecar.testEvidence, "npm test");
  });

  it("frozen business contract markers remain absent from production src", () => {
    const srcRoot = path.join(backendRoot, "src");
    const skipFiles = new Set(["settlementContract.js"]);
    const sources = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith(".js") && !skipFiles.has(entry.name)) {
          sources.push(fs.readFileSync(fullPath, "utf8"));
        }
      }
    };
    walk(srcRoot);

    const combined = sources.join("\n");
    assert.doesNotMatch(combined, /goldRate|goldWeight|inventory|deliverySchedule/i);
    assert.doesNotMatch(combined, /\/register\b|self-registration|registerCustomer/i);

    const settlementContract = fs.readFileSync(
      path.join(backendRoot, "src/constants/settlementContract.js"),
      "utf8"
    );
    assert.match(settlementContract, /makingChargeAffectsPayout:\s*false/);
  });

  it("settlement contract remains principal-only with allowed payout methods", () => {
    const settlementService = fs.readFileSync(
      path.join(backendRoot, "src/services/settlement.service.js"),
      "utf8"
    );
    const settlementContract = fs.readFileSync(
      path.join(backendRoot, "src/constants/settlementContract.js"),
      "utf8"
    );
    assert.match(settlementService, /SETTLEMENT_AMOUNT_NOT_ALLOWED/);
    assert.match(settlementContract, /ALLOWED_SETTLEMENT_PAYOUT_METHODS = \["CASH", "UPI", "BANK"\]/);
    assert.doesNotMatch(settlementService, /\bbonus\b|\bpenalty\b|\bdeduction\b/i);
  });
});
