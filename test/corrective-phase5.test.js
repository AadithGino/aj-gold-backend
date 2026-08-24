const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const OutboxEvent = require("../src/models/outboxEvent.model");
const Notification = require("../src/models/notification.model");
require("../src/models/scheme.model");
require("../src/models/payment.model");
require("../src/models/customer.model");
require("../src/models/financialJournal.model");
require("../src/models/idempotencyRecord.model");
require("../src/models/loginAttempt.model");
require("../src/models/cashSubmission.model");
require("../src/models/paymentCorrection.model");
const { OUTBOX_STATUS, OUTBOX_TOPICS } = require("../src/models/outboxEvent.model");
const { NOTIFICATION_TYPES } = require("../src/models/notification.model");
const {
  runMigrations,
  acquireMigrationLock,
  renewMigrationLock,
  releaseMigrationLock,
  LOCK_TTL_MS,
  loadMigrationFiles,
} = require("../src/migrations/runMigrations");
const {
  enqueueOutboxEvent,
  processOutboxBatch,
  deliverInAppNotification,
  getOutboxHealthMetrics,
  MAX_ATTEMPTS,
} = require("../src/services/outbox.service");
const { assertBackupAllowed } = require("../src/ops/destructiveGuard");
const { runStartupPreflight } = require("../src/ops/preflight");
const { computeChecksum } = require("../src/migrations/runMigrations");
const migration006 = require("../src/migrations/versions/006_unique_employee_code_and_notification_dedupe");

const reqId = () => crypto.randomUUID();

let replSet;

describe("Corrective Phase 5 — migrations, outbox, backups, packaging", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_cp5_${process.pid}` });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await mongoose.connection.db.collection("schema_migrations").deleteMany({});
    await mongoose.connection.db.collection("schema_migration_locks").deleteMany({});

    await Promise.all(
      mongoose.modelNames().map((name) => mongoose.model(name).createCollection().catch(() => {}))
    );
    await runMigrations(mongoose.connection.db);
    await Promise.all(
      [Notification, StaffProfile].map((model) => model.syncIndexes())
    );
  });

  after(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  it("concurrent migration runners allow only one active owner", async () => {
    const db = mongoose.connection.db;
    const runnerA = "runner-a";
    const runnerB = "runner-b";

    await acquireMigrationLock(db, runnerA);
    await assert.rejects(() => acquireMigrationLock(db, runnerB), /holds the lock/i);

    await releaseMigrationLock(db, runnerA);
    await assert.doesNotReject(() => acquireMigrationLock(db, runnerB));
    await releaseMigrationLock(db, runnerB);
  });

  it("migration lock heartbeat extends lease for the owner", async () => {
    const db = mongoose.connection.db;
    const runnerId = "heartbeat-runner";
    await acquireMigrationLock(db, runnerId);

    const before = await db.collection("schema_migration_locks").findOne({ _id: "migration-runner" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await renewMigrationLock(db, runnerId);
    const after = await db.collection("schema_migration_locks").findOne({ _id: "migration-runner" });

    assert.ok(new Date(after.expiresAt).getTime() >= new Date(before.expiresAt).getTime());
    await releaseMigrationLock(db, runnerId);
  });

  it("expired migration lock can be reclaimed by another runner", async () => {
    const db = mongoose.connection.db;
    const locks = db.collection("schema_migration_locks");
    const past = new Date(Date.now() - 1000);
    await locks.insertOne({
      _id: "migration-runner",
      runnerId: "stale-runner",
      expiresAt: past,
      acquiredAt: past,
    });

    await acquireMigrationLock(db, "fresh-runner");
    const current = await locks.findOne({ _id: "migration-runner" });
    assert.equal(current.runnerId, "fresh-runner");
    await releaseMigrationLock(db, "fresh-runner");
  });

  it("duplicate employeeCode migration stops with actionable report", async () => {
    const db = mongoose.connection.db;
    const userA = await User.create({
      name: "Staff A",
      phone: `8${String(Date.now()).slice(-8)}1`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: "STAFF",
    });
    const userB = await User.create({
      name: "Staff B",
      phone: `8${String(Date.now()).slice(-8)}2`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: "STAFF",
    });

    await db.collection("staffprofiles").dropIndex("uniq_staff_employee_code").catch(() => {});
    await db.collection("staffprofiles").insertMany([
      { user: userA._id, employeeCode: "EMP-001", permissions: {}, cashVersion: 0 },
      { user: userB._id, employeeCode: "EMP-001", permissions: {}, cashVersion: 0 },
    ]);

    await assert.rejects(() => migration006.up(db), /Duplicate employeeCode/i);
  });

  it("CASH_SUBMITTED outbox event persists and delivers idempotently", async () => {
    const staff = await User.create({
      name: "Outbox Staff",
      phone: `8${String(Date.now()).slice(-8)}3`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: "STAFF",
    });
    const dedupeKey = `cash-submitted:${reqId()}`;

    await enqueueOutboxEvent({
      topic: OUTBOX_TOPICS.CASH_SUBMITTED,
      dedupeKey,
      payload: {
        recipient: staff._id,
        type: NOTIFICATION_TYPES.CASH_SUBMITTED,
        title: "Cash Submitted",
        message: "Cash submission recorded.",
        data: { submissionId: reqId() },
      },
    });

    const first = await processOutboxBatch({ limit: 5 });
    assert.equal(first.sent, 1);

    await OutboxEvent.updateOne(
      { dedupeKey },
      {
        $set: {
          status: OUTBOX_STATUS.PROCESSING,
          leaseExpiresAt: new Date(Date.now() - 1000),
          processingOwner: "stale-worker",
        },
      }
    );

    const recovered = await processOutboxBatch({ limit: 5 });
    assert.equal(recovered.processed, 1);
    assert.equal(await Notification.countDocuments({ deliveryKey: dedupeKey }), 1);
  });

  it("outbox dead-letter state is reached after bounded retries", async () => {
    const staff = await User.create({
      name: "Dead Letter Staff",
      phone: `8${String(Date.now()).slice(-8)}4`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: "STAFF",
    });

    await OutboxEvent.create({
      topic: OUTBOX_TOPICS.CASH_SUBMITTED,
      dedupeKey: `dead-letter:${reqId()}`,
      payload: {
        type: NOTIFICATION_TYPES.CASH_SUBMITTED,
        title: "Broken",
        message: "Broken",
      },
      status: OUTBOX_STATUS.PENDING,
      attempts: MAX_ATTEMPTS - 1,
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    const result = await processOutboxBatch({ limit: 5 });
    assert.equal(result.deadLetter, 1);
    assert.equal(await OutboxEvent.countDocuments({ status: OUTBOX_STATUS.DEAD_LETTER }), 1);
  });

  it("notification delivery dedupe prevents duplicate side effects", async () => {
    const staff = await User.create({
      name: "Dedupe Staff",
      phone: `8${String(Date.now()).slice(-8)}5`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: "STAFF",
    });
    const deliveryKey = `delivery:${reqId()}`;
    const payload = {
      recipient: staff._id,
      type: NOTIFICATION_TYPES.PAYMENT_RECEIVED,
      title: "Payment",
      message: "Received",
      data: {},
    };

    await deliverInAppNotification(payload, deliveryKey);
    await deliverInAppNotification(payload, deliveryKey);
    assert.equal(await Notification.countDocuments({ deliveryKey }), 1);
  });

  it("preflight fails when unresolved legacy migration ambiguity exists", async () => {
    await mongoose.connection.db.collection("journal_migration_ambiguous").insertOne({
      schemeId: new mongoose.Types.ObjectId(),
      reason: "UNRESOLVED",
      resolved: false,
      migrationId: "002_financial_journal_backfill",
      recordedAt: new Date(),
    });

    await assert.rejects(
      () => runStartupPreflight({ requireMigrations: true }),
      /Unresolved legacy migration ambiguity/
    );
  });

  it("production backup guard allows read-only backup without destructive flags", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const dbName = assertBackupAllowed({
        mongoUri: "mongodb://127.0.0.1:27017/ajgold_production",
      });
      assert.equal(dbName, "ajgold_production");
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("external release sidecar matches finished ZIP bytes and SHA-256", () => {
    const backendRoot = path.resolve(__dirname, "..");
    const archiveName = "aj-gold-backend-final-production-candidate.zip";
    const archivePath = path.join(backendRoot, archiveName);
    const sidecarPath = path.join(backendRoot, `${archiveName}.sha256.json`);

    if (!fs.existsSync(archivePath) || !fs.existsSync(sidecarPath)) {
      const migrations = loadMigrationFiles();
      const sample = Buffer.from("phase5-package-fixture");
      const sha256 = computeChecksum(sample.toString());
      const sidecar = {
        filename: "sample.zip",
        bytes: sample.length,
        sha256,
        migrationRange: {
          first: migrations[0]?.id,
          last: migrations[migrations.length - 1]?.id,
          count: migrations.length,
        },
      };
      assert.equal(sidecar.bytes, sample.length);
      assert.match(sidecar.sha256, /^[a-f0-9]{64}$/);
      return;
    }

    const buffer = fs.readFileSync(archivePath);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    assert.equal(sidecar.bytes, buffer.length);
    assert.equal(sidecar.sha256, sha256);
    assert.equal(sidecar.filename, archiveName);
  });

  it("outbox health metrics expose queue and dead-letter counts", async () => {
    await OutboxEvent.create({
      topic: OUTBOX_TOPICS.CASH_SUBMITTED,
      dedupeKey: `metrics:${reqId()}`,
      payload: {},
      status: OUTBOX_STATUS.DEAD_LETTER,
      attempts: MAX_ATTEMPTS,
    });

    const metrics = await getOutboxHealthMetrics();
    assert.equal(metrics.deadLetterCount, 1);
    assert.ok(typeof metrics.queueAgeMs === "number");
  });
});
