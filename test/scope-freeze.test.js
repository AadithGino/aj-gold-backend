const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC_DIRS = [
  "app.js",
  "routes",
  "controllers",
  "services",
  "middleware",
  "models",
  "config",
  "constants",
  "utils",
].map((segment) => path.join(__dirname, "../src", segment));

const walkFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
};

describe("Scope freeze protections", () => {
  it("does not reintroduce out-of-scope product workflows", () => {
    const jsFiles = SRC_DIRS.flatMap((targetPath) => {
      if (!fs.existsSync(targetPath)) return [];
      const stat = fs.statSync(targetPath);
      if (stat.isFile() && targetPath.endsWith(".js")) {
        return [targetPath];
      }
      return walkFiles(targetPath);
    });
    const source = jsFiles
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");

    const disallowedPatterns = [
      /\/mfa\//i,
      /mfaEnrollment|adminMfa|mfaSecret|mfaRecoveryCode|mfaChallenge/i,
      /accountDeletion|deletion-requests|deletion-status|anonymiz/i,
      /\/register\b|self[-_\s]?register|public[-_\s]?registration/i,
      /payment.?gateway|razorpay|stripe|paypal/i,
      /gold.?rate|gold.?weight|purity|jewellery.?inventory|gold.?price/i,
      /settlement.?acknowledg(e)?ment/i,
    ];

    for (const pattern of disallowedPatterns) {
      assert.equal(pattern.test(source), false, `Disallowed pattern found: ${pattern}`);
    }
  });
});
