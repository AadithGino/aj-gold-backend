const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const { assertDestructiveOperationAllowed, extractDbName } = require("../src/ops/destructiveGuard");
const { verifyRequiredIndexes, indexHasShape } = require("../src/ops/requiredIndexes");
const {
  runMigrations,
  verifyMigrationsApplied,
  acquireMigrationLock,
  releaseMigrationLock,
  computeChecksum,
  loadMigrationFiles,
} = require("../src/migrations/runMigrations");
const { redactObject } = require("../src/utils/logger");
const { assertReplicaSetTopology, assertTransactionCapability } = require("../src/ops/preflight");
const { scanIntegrity } = require("../src/ops/integrityScanner");

let replSet;

describe("Phase 6 migrations, ops, and safeguards", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_phase6_${process.pid}`,
    });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await mongoose.connection.db.collection("schema_migrations").deleteMany({});
    await mongoose.connection.db.collection("schema_migration_locks").deleteMany({});
  });

  after(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it("migration runner applies, verifies, and reruns idempotently", async () => {
    const db = mongoose.connection.db;
    const first = await runMigrations(db);
    assert.ok(first.some((row) => row.status === "applied"));
    const second = await runMigrations(db);
    assert.ok(second.every((row) => row.status === "skipped"));
    await verifyMigrationsApplied(db);
  });

  it("migration verify mode passes on fully migrated database", async () => {
    const db = mongoose.connection.db;
    await runMigrations(db);
    const report = await runMigrations(db, { verifyOnly: true });
    assert.equal(report[0].status, "verified");
  });

  it("migration checksum drift fails verification", async () => {
    const db = mongoose.connection.db;
    await runMigrations(db);
    const migration = loadMigrationFiles()[0];
    await db.collection("schema_migrations").updateOne(
      { id: migration.id },
      { $set: { checksum: "deadbeef" } }
    );
    await assert.rejects(() => verifyMigrationsApplied(db), /checksum drift/);
  });

  it("concurrent migration lock prevents overlapping runners", async () => {
    const db = mongoose.connection.db;
    await acquireMigrationLock(db, "runner-a");
    await assert.rejects(() => acquireMigrationLock(db, "runner-b"), /holds the lock/);
    await releaseMigrationLock(db, "runner-a");
    await assert.doesNotReject(() => acquireMigrationLock(db, "runner-b"));
    await releaseMigrationLock(db, "runner-b");
  });

  it("required index verifier passes after migrations", async () => {
    const db = mongoose.connection.db;
    await runMigrations(db);
    const result = await verifyRequiredIndexes(db);
    assert.ok(result.verified >= 10);
  });

  it("required index verifier detects missing index", async () => {
    const db = mongoose.connection.db;
    await runMigrations(db);
    await db.collection("loginattempts").dropIndex("uniq_login_attempt_key").catch(() => {});
    await assert.rejects(() => verifyRequiredIndexes(db), /Missing or incorrect required indexes/);
  });

  it("destructive guard refuses production and non-demo databases", () => {
    const originalEnv = process.env.NODE_ENV;
    const originalAllow = process.env.ALLOW_DATABASE_RESET;
    const originalConfirm = process.env.CONFIRM_DATABASE_RESET;

    try {
      process.env.NODE_ENV = "production";
      assert.throws(
        () =>
          assertDestructiveOperationAllowed({
            mongoUri: "mongodb://127.0.0.1:27017/ajgold_dev",
            operationLabel: "reset",
          }),
        /production/
      );

      process.env.NODE_ENV = "test";
      process.env.ALLOW_DATABASE_RESET = "false";
      assert.throws(
        () =>
          assertDestructiveOperationAllowed({
            mongoUri: "mongodb://127.0.0.1:27017/ajgold_dev",
            operationLabel: "reset",
          }),
        /ALLOW_DATABASE_RESET/
      );

      process.env.ALLOW_DATABASE_RESET = "true";
      assert.throws(
        () =>
          assertDestructiveOperationAllowed({
            mongoUri: "mongodb://127.0.0.1:27017/production_main",
            operationLabel: "reset",
          }),
        /dev, demo, or test/
      );

      assert.throws(
        () =>
          assertDestructiveOperationAllowed({
            mongoUri: "mongodb://127.0.0.1:27017/ajgold_dev",
            operationLabel: "reset",
          }),
        /CONFIRM_DATABASE_RESET=ajgold_dev/
      );

      process.env.CONFIRM_DATABASE_RESET = "ajgold_dev";
      assert.equal(
        assertDestructiveOperationAllowed({
          mongoUri: "mongodb://127.0.0.1:27017/ajgold_dev",
          operationLabel: "reset",
        }),
        "ajgold_dev"
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.ALLOW_DATABASE_RESET = originalAllow;
      process.env.CONFIRM_DATABASE_RESET = originalConfirm;
    }
  });

  it("extractDbName rejects ambiguous URIs", () => {
    assert.equal(extractDbName("mongodb://127.0.0.1:27017"), "");
    assert.equal(extractDbName("mongodb://127.0.0.1:27017/ajgold_test"), "ajgold_test");
  });

  it("logger redacts secrets and credentials", () => {
    const redacted = redactObject({
      phone: "9999999999",
      password: "secret-pass",
      token: "abc123",
      nested: { authorization: "Bearer abc" },
    });
    assert.equal(redacted.password, "[REDACTED]");
    assert.equal(redacted.token, "[REDACTED]");
    assert.equal(redacted.nested.authorization, "[REDACTED]");
    assert.equal(redacted.phone, "9999999999");
  });

  it("replica set topology and transactions are available", async () => {
    await assertReplicaSetTopology(mongoose.connection.db);
    await assertTransactionCapability();
  });

  it("integrity scanner returns ok on clean migrated database", async () => {
    await runMigrations(mongoose.connection.db);
    const report = await scanIntegrity({ db: mongoose.connection.db });
    assert.equal(report.ok, true);
    assert.equal(report.criticalCount, 0);
  });

  it("production env rejects demo database name", () => {
    const envPath = require.resolve("../src/config/env");
    const originalEnv = process.env.NODE_ENV;
    const originalCors = process.env.CORS_ORIGINS;
    const originalJwt = process.env.JWT_SECRET;
    const originalMongo = process.env.MONGO_URI;

    try {
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGINS = "https://admin.example.com";
      process.env.JWT_SECRET = "x".repeat(40);
      process.env.MONGO_URI = "mongodb://127.0.0.1:27017/ajgold_demo";
      delete require.cache[envPath];
      assert.throws(() => require(envPath), /must not target demo/);
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.CORS_ORIGINS = originalCors;
      process.env.JWT_SECRET = originalJwt;
      process.env.MONGO_URI = originalMongo;
      delete require.cache[envPath];
      require(envPath);
    }
  });

  it("migration checksum helper is stable", () => {
    const migrations = loadMigrationFiles();
    assert.ok(migrations.length >= 3);
    const checksum = computeChecksum(migrations[0].content);
    assert.match(checksum, /^[a-f0-9]{64}$/);
  });

  it("index shape matcher validates partial unique indexes", () => {
    const indexes = [
      {
        key: { customer: 1 },
        unique: true,
        name: "uniq_customer_active_scheme",
        partialFilterExpression: { status: "ACTIVE" },
      },
    ];
    assert.equal(
      indexHasShape(
        indexes,
        { customer: 1 },
        {
          unique: true,
          name: "uniq_customer_active_scheme",
          partial: { status: "ACTIVE" },
        }
      ),
      true
    );
  });
});
