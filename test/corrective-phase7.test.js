const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const backendRoot = path.resolve(__dirname, "..");
const INTERNAL_MANIFEST = "RELEASE_CONTENTS.manifest.json";
const EXPECTED_LOCK_SHA = "fda8dc78331e114fb3c375d565a3ee7cd56dc6e4b4f06a66acdf320ff4411979";
const PACKAGING_FILES = [
  "FINAL_AJ_GOLD_BACKEND_PRODUCTION_AUDIT.md",
  "scripts/package-final-archive.js",
  "test/corrective-phase7.test.js",
  "package.json",
  "src/migrations/versions/012_scheme_settlement_history_indexes.js",
];

const expectedMigrations = [
  "src/migrations/versions/001_one_active_scheme_per_customer.js",
  "src/migrations/versions/002_financial_journal_backfill.js",
  "src/migrations/versions/003_account_lifecycle_indexes.js",
  "src/migrations/versions/004_required_query_indexes.js",
  "src/migrations/versions/005_cash_submission_lifecycle.js",
  "src/migrations/versions/006_unique_employee_code_and_notification_dedupe.js",
  "src/migrations/versions/007_remove_account_deletion_indexes.js",
  "src/migrations/versions/008_payment_correction_version_invariant.js",
  "src/migrations/versions/009_enforce_required_index_options.js",
  "src/migrations/versions/010_audit_legacy_journal_backfill.js",
  "src/migrations/versions/011_payment_correction_version_backfill_batched.js",
  "src/migrations/versions/012_scheme_settlement_history_indexes.js",
];

const expectedRuntimeFiles = [
  "package.json",
  "package-lock.json",
  "server.js",
  "src/app.js",
  "src/migrations/migrate.js",
  "test/scope-freeze.test.js",
  INTERNAL_MANIFEST,
];

const forbiddenEntryPatterns = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\./,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)backups(\/|$)/,
  /\.zip$/,
  /\.sha256\.json$/,
  /(^|\/)archive-manifest\.json$/,
  /AJ_GOLD_BACKEND_7_PHASE_CURSOR_FIX_PROMPTS_2026-08-23\.md$/,
];

const tempRoots = [];

const sha256File = (filePath) => {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const rel = (root, filePath) => path.relative(root, filePath).split(path.sep).join("/");

const walkFiles = (root) => {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const lstat = fs.lstatSync(full);
      if (lstat.isSymbolicLink()) {
        throw new Error(`symlink in extract: ${rel(root, full)}`);
      }
      if (lstat.isDirectory()) visit(full);
      else if (lstat.isFile()) out.push(full);
    }
  };
  visit(root);
  return out;
};

const cleanupTemps = () => {
  while (tempRoots.length) {
    const target = tempRoots.pop();
    fs.rmSync(target, { recursive: true, force: true });
  }
};

after(() => {
  cleanupTemps();
});

describe("Corrective Phase 7 — release packaging and contract freeze", () => {
  it("package script produces the current release ZIP, internal manifest and external sidecar", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajg-p7-out-"));
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajg-p7-extract-"));
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajg-p7-clone-"));
    tempRoots.push(outputDir, extractDir, cloneDir);

    try {
      run("git", ["clone", "--local", "--quiet", backendRoot, cloneDir]);
      for (const relative of PACKAGING_FILES) {
        const from = path.join(backendRoot, relative);
        const to = path.join(cloneDir, relative);
        if (fs.existsSync(from)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        }
      }
      run("git", ["add", "--", ...PACKAGING_FILES], { cwd: cloneDir });
      run(
        "git",
        [
          "-c",
          "user.name=Packaging Test",
          "-c",
          "user.email=packaging-test@local",
          "commit",
          "-m",
          "test: packaging contract",
        ],
        { cwd: cloneDir }
      );

      const cloneHead = run("git", ["rev-parse", "HEAD"], { cwd: cloneDir }).trim();
      const short = cloneHead.slice(0, 7);
      const expectedZipName = `aj-gold-backend-production-release-${short}.zip`;

      run("node", ["scripts/package-final-archive.js"], {
        cwd: cloneDir,
        env: { ...process.env, RELEASE_OUTPUT_DIR: outputDir },
      });

      const zipPath = path.join(outputDir, expectedZipName);
      const sidecarPath = path.join(outputDir, `aj-gold-backend-production-release-${short}.manifest.json`);
      assert.equal(fs.existsSync(zipPath), true, "release zip must exist");
      assert.equal(fs.existsSync(sidecarPath), true, "external manifest must exist");
      assert.equal(fs.existsSync(path.join(cloneDir, expectedZipName)), false, "zip must not be written into the repo");

      const zipBuffer = fs.readFileSync(zipPath);
      const zipSha = crypto.createHash("sha256").update(zipBuffer).digest("hex");
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      assert.equal(sidecar.filename, expectedZipName);
      assert.equal(sidecar.bytes, zipBuffer.length);
      assert.equal(sidecar.sha256, zipSha);
      assert.equal(sidecar.commit, cloneHead);
      assert.equal(sidecar.packageLockSha256, EXPECTED_LOCK_SHA);
      assert.equal(sidecar.migrationRange, "001–012");
      assert.equal(sidecar.deploymentOccurred, false);
      assert.ok(sidecar.createdAtUtc);
      assert.ok(sidecar.node);
      assert.ok(sidecar.npm);

      run("unzip", ["-q", zipPath, "-d", extractDir]);

      const extracted = walkFiles(extractDir).map((filePath) => rel(extractDir, filePath));
      assert.equal(extracted.some((entry) => entry.split("/").includes("..")), false, "path traversal");
      assert.equal(
        extracted.some((entry) => fs.lstatSync(path.join(extractDir, entry)).isSymbolicLink()),
        false,
        "symlinks"
      );

      const internal = JSON.parse(fs.readFileSync(path.join(extractDir, INTERNAL_MANIFEST), "utf8"));
      assert.equal(internal.commit, cloneHead);
      assert.equal(internal.commit, sidecar.commit);
      assert.equal(
        internal.files.some((file) => file.path === INTERNAL_MANIFEST),
        false,
        "internal manifest must not self-hash"
      );

      const diskPaths = extracted.filter((entry) => entry !== INTERNAL_MANIFEST);
      const manifestPaths = internal.files.map((file) => file.path);
      assert.equal(new Set(manifestPaths).size, manifestPaths.length, "duplicate manifest paths");
      assert.equal(internal.fileCount, manifestPaths.length);
      assert.deepEqual([...diskPaths].sort(), [...manifestPaths].sort());

      for (const file of internal.files) {
        const full = path.join(extractDir, file.path);
        assert.equal(fs.existsSync(full), true, `missing ${file.path}`);
        assert.equal(fs.statSync(full).size, file.bytes, `size mismatch ${file.path}`);
        assert.equal(sha256File(full), file.sha256, `hash mismatch ${file.path}`);
      }

      assert.equal(sha256File(path.join(extractDir, "package-lock.json")), EXPECTED_LOCK_SHA);

      for (const file of expectedRuntimeFiles) {
        assert.equal(extracted.includes(file), true, `missing runtime file ${file}`);
      }
      for (const file of expectedMigrations) {
        assert.equal(extracted.includes(file), true, `missing migration ${file}`);
      }

      for (const entry of extracted) {
        for (const pattern of forbiddenEntryPatterns) {
          if (entry === ".env.example") continue;
          assert.equal(pattern.test(entry), false, `forbidden entry ${entry}`);
        }
      }

      const skipContentScan = new Set([
        "package-lock.json",
        "test/corrective-phase5.test.js",
        "test/phase5.test.js",
      ]);
      const textBlob = extracted
        .filter((entry) => !skipContentScan.has(entry))
        .filter((entry) => /\.(js|md|json|yml|yaml|example|txt|gitignore)$/i.test(entry) || entry.startsWith("."))
        .map((entry) => fs.readFileSync(path.join(extractDir, entry), "utf8"))
        .join("\n");
      const obsoleteZipName = ["aj-gold-backend-final-production", "candidate.zip"].join("-");
      const obsoleteCommit = "e2d2243633b3e6de" + "ab8f8877ac6807b3234dfc22";
      const obsoleteMfaKey = "MFA_ENCRYPTION" + "_KEY";
      assert.doesNotMatch(textBlob, /\/Users\//);
      assert.doesNotMatch(textBlob, /\/home\/[A-Za-z0-9._-]+\//);
      assert.doesNotMatch(textBlob, /[A-Za-z]:\\Users\\/);
      assert.equal(textBlob.includes(obsoleteZipName), false);
      assert.equal(textBlob.includes(obsoleteCommit), false);
      assert.equal(textBlob.includes(obsoleteMfaKey), false);
    } finally {
      cleanupTemps();
    }
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
