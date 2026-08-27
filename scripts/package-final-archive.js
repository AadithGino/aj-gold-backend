#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const backendRoot = path.resolve(__dirname, "..");
const INTERNAL_MANIFEST = "RELEASE_CONTENTS.manifest.json";
const EXPECTED_LOCK_SHA = "fda8dc78331e114fb3c375d565a3ee7cd56dc6e4b4f06a66acdf320ff4411979";
const PROMPT_PACK = "AJ_GOLD_BACKEND_7_PHASE_CURSOR_FIX_PROMPTS_2026-08-23.md";

const fail = (message) => {
  throw new Error(message);
};

const run = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      cwd: backendRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    const detail = `${error.stderr || error.stdout || error.message || ""}`.slice(0, 2000);
    fail(`${command} ${args.join(" ")} failed: ${detail || "unknown error"}`);
  }
};

const sha256Buffer = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const sha256File = (filePath) => sha256Buffer(fs.readFileSync(filePath));

const rel = (root, filePath) => path.relative(root, filePath).split(path.sep).join("/");

const rmrf = (target) => {
  fs.rmSync(target, { recursive: true, force: true });
};

const walkFiles = (root) => {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      fail(`Unable to read directory ${dir}: ${error.message}`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let lstat;
      try {
        lstat = fs.lstatSync(full);
      } catch (error) {
        fail(`Unable to stat ${full}: ${error.message}`);
      }
      if (lstat.isSymbolicLink()) {
        fail(`Symlinks are not allowed in the release payload: ${rel(root, full)}`);
      }
      if (lstat.isDirectory()) {
        visit(full);
      } else if (lstat.isFile()) {
        out.push(full);
      } else {
        fail(`Unsupported file type in payload: ${rel(root, full)}`);
      }
    }
  };
  visit(root);
  return out.sort((a, b) => rel(root, a).localeCompare(rel(root, b)));
};

const isExcludedRelative = (relative) => {
  if (!relative || relative === ".") return true;
  if (relative === ".env.example") return false;
  if (relative === ".env" || relative.startsWith(".env.")) return true;
  const parts = relative.split("/");
  if (parts.includes(".git") || parts.includes("node_modules")) return true;
  if (relative === "logs" || relative.startsWith("logs/")) return true;
  if (relative === "coverage" || relative.startsWith("coverage/")) return true;
  if (relative === ".nyc_output" || relative.startsWith(".nyc_output/")) return true;
  if (relative === "backups" || relative.startsWith("backups/")) return true;
  if (relative === "archive-manifest.json") return true;
  if (relative === PROMPT_PACK) return true;
  if (relative.endsWith(".log") || relative.includes("npm-debug.log")) return true;
  if (relative.endsWith(".zip") || relative.endsWith(".sha256.json") || relative.endsWith(".manifest.json")) {
    return relative !== INTERNAL_MANIFEST;
  }
  if (
    relative.endsWith(".dump") ||
    relative.endsWith(".archive") ||
    relative.endsWith(".tar") ||
    relative.endsWith(".tar.gz") ||
    relative.endsWith(".tgz") ||
    relative.endsWith(".mongodb")
  ) {
    return true;
  }
  const base = parts[parts.length - 1];
  if (base === ".DS_Store" || base === "Thumbs.db" || base.endsWith(".swp") || base.endsWith("~") || base.endsWith(".tmp")) {
    return true;
  }
  return false;
};

const assertNoPathTraversal = (relative) => {
  if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").includes("..")) {
    fail(`Illegal payload path: ${relative}`);
  }
};

const assertCleanWorkingTree = () => {
  const status = run("git", ["status", "--porcelain"]).trim();
  if (status) {
    fail("Git working tree must be clean before packaging.");
  }
};

const resolveOutputDir = () => {
  const configured = process.env.RELEASE_OUTPUT_DIR;
  const outputDir = path.resolve(configured ? configured : path.join(backendRoot, ".."));
  const repoPrefix = backendRoot.endsWith(path.sep) ? backendRoot : `${backendRoot}${path.sep}`;
  if (outputDir === backendRoot || outputDir.startsWith(repoPrefix)) {
    fail("RELEASE_OUTPUT_DIR must be outside the repository.");
  }
  return outputDir;
};

const pruneEmptyDirectories = (root) => {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
    }
    if (dir !== root && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  };
  visit(root);
};

const packageRelease = () => {
  assertCleanWorkingTree();

  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) {
    fail("Unable to resolve a full HEAD commit.");
  }
  const short = commit.slice(0, 7);
  const outputDir = resolveOutputDir();
  fs.mkdirSync(outputDir, { recursive: true });

  const zipName = `aj-gold-backend-production-release-${short}.zip`;
  const zipPath = path.join(outputDir, zipName);
  const sidecarPath = path.join(outputDir, `${zipName.replace(/\.zip$/, "")}.manifest.json`);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ajg-release-stage-"));
  const tarPath = path.join(os.tmpdir(), `ajg-release-${short}.tar`);

  try {
    run("git", ["archive", commit, "--format=tar", "-o", tarPath]);
    run("tar", ["-x", "-C", staging, "-f", tarPath], { cwd: os.tmpdir() });
    fs.unlinkSync(tarPath);

    for (const filePath of walkFiles(staging)) {
      const relative = rel(staging, filePath);
      assertNoPathTraversal(relative);
      if (isExcludedRelative(relative)) {
        fs.unlinkSync(filePath);
      }
    }
    pruneEmptyDirectories(staging);

    const payloadFiles = walkFiles(staging).filter((filePath) => rel(staging, filePath) !== INTERNAL_MANIFEST);
    const seen = new Set();
    const files = payloadFiles.map((filePath) => {
      const relative = rel(staging, filePath);
      assertNoPathTraversal(relative);
      if (seen.has(relative)) fail(`Duplicate payload path: ${relative}`);
      seen.add(relative);
      if (isExcludedRelative(relative)) fail(`Excluded path remained in payload: ${relative}`);
      const stat = fs.statSync(filePath);
      return {
        path: relative,
        bytes: stat.size,
        sha256: sha256File(filePath),
      };
    });

    const lockFile = payloadFiles.find((filePath) => rel(staging, filePath) === "package-lock.json");
    if (!lockFile) fail("package-lock.json missing from payload.");
    const packageLockSha256 = sha256File(lockFile);
    if (packageLockSha256 !== EXPECTED_LOCK_SHA) {
      fail(`package-lock.json SHA-256 mismatch: ${packageLockSha256}`);
    }

    const internal = {
      commit,
      fileCount: files.length,
      files,
    };
    fs.writeFileSync(path.join(staging, INTERNAL_MANIFEST), `${JSON.stringify(internal, null, 2)}\n`);

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    run("zip", ["-r", "-X", zipPath, "."], { cwd: staging });

    const zipBuffer = fs.readFileSync(zipPath);
    const zipSha = sha256Buffer(zipBuffer);
    const nodeVersion = process.version;
    const npmVersion = run("npm", ["-v"]).trim();

    const sidecar = {
      filename: zipName,
      bytes: zipBuffer.length,
      sha256: zipSha,
      commit,
      createdAtUtc: new Date().toISOString(),
      node: nodeVersion,
      npm: npmVersion,
      packageLockSha256,
      migrationRange: "001–012",
      deploymentOccurred: false,
    };
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

    const confirmSha = sha256File(zipPath);
    if (confirmSha !== zipSha) fail("ZIP changed after external hash calculation.");

    return { zipPath, sidecarPath, sidecar };
  } finally {
    rmrf(staging);
    if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
  }
};

try {
  const result = packageRelease();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
}
