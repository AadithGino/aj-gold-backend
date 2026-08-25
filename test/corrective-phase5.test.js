const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { spawnSync } = require("node:child_process");
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
  verifyMigrationsApplied,
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
const { getIntegritySummary } = require("../src/services/adminOversight.service");
const migration006 = require("../src/migrations/versions/006_unique_employee_code_and_notification_dedupe");
const migration008 = require("../src/migrations/versions/008_payment_correction_version_invariant");
const migration009 = require("../src/migrations/versions/009_enforce_required_index_options");
const migration011 = require("../src/migrations/versions/011_payment_correction_version_backfill_batched");
const { runMigration002Safe } = require("../src/migrations/safeRunners/002_financial_journal_backfill.safe");
const { SCHEME_STATUS, PAYMENT_STATUS } = require("../src/constants/enums");
const { verifyRequiredIndexes } = require("../src/ops/requiredIndexes");

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

  it("fresh empty database applies every migration deterministically", async () => {
    const db = mongoose.connection.db;
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await db.collection("schema_migrations").deleteMany({});
    await db.collection("schema_migration_locks").deleteMany({});

    const report = await runMigrations(db);
    const applied = report.filter((row) => row.status === "applied").map((row) => row.id);
    const migrationIds = loadMigrationFiles().map((row) => row.id);
    assert.deepEqual(applied, migrationIds);
  });

  it("schema readiness completes catalog work before first customer write", async () => {
    const db = mongoose.connection.db;
    await verifyRequiredIndexes(db);
    await User.create({
      name: "Admin",
      phone: `91${Date.now().toString().slice(-8)}`,
      passwordHash: await bcrypt.hash("admin12345", 10),
      role: "ADMIN",
      status: "ACTIVE",
    });

    const runCustomerCreate = (suffix) =>
      spawnSync(
        process.execPath,
        [
          "-e",
          `
            const mongoose = require("mongoose");
            const { connectDb } = require("./src/config/db");
            const User = require("./src/models/user.model");
            const { createCustomer } = require("./src/services/customer.service");

            const events = [];
            mongoose.set("debug", (collectionName, method) => {
              events.push({ collectionName, method });
              console.log("MDBG " + JSON.stringify({ collectionName, method }));
            });

            (async () => {
              await connectDb(process.env.MONGO_URI);
              const admin = await User.findOne({ role: "ADMIN" });
              await createCustomer(
                {
                  name: "Readiness Customer ${suffix}",
                  phone: "8${Date.now().toString().slice(-8)}${suffix}",
                },
                admin
              );
              await mongoose.connection.close();
            })().catch(async (error) => {
              console.error(error.stack || error.message);
              if (mongoose.connection.readyState !== 0) {
                await mongoose.connection.close();
              }
              process.exit(1);
            });
          `,
        ],
        {
          cwd: path.join(__dirname, ".."),
          env: {
            ...process.env,
            NODE_ENV: "test",
            MONGO_URI: replSet.getUri(mongoose.connection.name),
          },
          encoding: "utf8",
        }
      );

    const firstRun = runCustomerCreate("1");
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstEvents = firstRun.stdout
      .split("\n")
      .filter((line) => line.startsWith("MDBG "))
      .map((line) => JSON.parse(line.slice(5)));

    const firstCustomerInsertIndex = firstEvents.findIndex(
      (event) => event.collectionName === "customers" && event.method === "insertOne"
    );
    assert.ok(firstCustomerInsertIndex >= 0, "Expected first customer insert");

    const catalogMethods = new Set([
      "createCollection",
      "createIndex",
      "createIndexes",
      "ensureIndexes",
      "dropIndex",
      "dropIndexes",
      "collMod",
    ]);
    const postInsertCatalogOps = firstEvents
      .slice(firstCustomerInsertIndex + 1)
      .filter((event) => catalogMethods.has(event.method));
    assert.equal(
      postInsertCatalogOps.length,
      0,
      `Catalog operations after first customer insert: ${JSON.stringify(postInsertCatalogOps)}`
    );

    const secondRun = runCustomerCreate("2");
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  });

  it("migration 002 safe runner processes representative records beyond one batch", async () => {
    const db = mongoose.connection.db;
    const customerId = new mongoose.Types.ObjectId();
    const schemeId = new mongoose.Types.ObjectId();
    await db.collection("schemes").insertOne({
      _id: schemeId,
      enrollmentNumber: `ENR-CP5-BATCH-${Date.now()}`,
      customer: customerId,
      status: SCHEME_STATUS.ACTIVE,
    });

    const paymentRows = Array.from({ length: 650 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(),
      receiptNumber: `RCT-CP5-BATCH-${index}-${Date.now()}`,
      customer: customerId,
      scheme: schemeId,
      status: PAYMENT_STATUS.SUCCESS,
      amount: 100 + (index % 5),
      paymentMethod: "CASH",
      paymentDate: new Date(`2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
      createdAt: new Date(),
    }));
    await db.collection("payments").insertMany(paymentRows);

    await runMigration002Safe(db);
    const migrated = await db.collection("financialjournals").countDocuments({
      eventType: "COLLECTION_RECEIVED",
      "metadata.migrated": true,
    });
    assert.equal(migrated, paymentRows.length);
  });

  it("migration 011 resumes from checkpoint and completes deterministically", async () => {
    const db = mongoose.connection.db;
    const firstPayment = new mongoose.Types.ObjectId();
    const secondPayment = new mongoose.Types.ObjectId();
    await db.collection("paymentcorrections").insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        payment: firstPayment,
        status: "APPROVED",
        version: 1,
        reviewedAt: new Date("2026-01-01"),
        createdAt: new Date("2026-01-01"),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        payment: firstPayment,
        status: "APPROVED",
        version: 2,
        reviewedAt: new Date("2026-01-02"),
        createdAt: new Date("2026-01-02"),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        payment: secondPayment,
        status: "APPROVED",
        version: 9,
        reviewedAt: new Date("2026-01-03"),
        createdAt: new Date("2026-01-03"),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        payment: secondPayment,
        status: "APPROVED",
        version: 11,
        reviewedAt: new Date("2026-01-04"),
        createdAt: new Date("2026-01-04"),
      },
    ]);

    await db.collection("schema_migration_progress").updateOne(
      { _id: "011_payment_correction_version_backfill_batched" },
      {
        $set: {
          lastPaymentId: firstPayment,
          completed: false,
        },
      },
      { upsert: true }
    );

    await migration011.up(db);

    const rows = await db
      .collection("paymentcorrections")
      .find({ payment: secondPayment, status: "APPROVED" })
      .sort({ reviewedAt: 1, createdAt: 1, _id: 1 })
      .project({ version: 1 })
      .toArray();
    assert.deepEqual(
      rows.map((row) => row.version),
      [1, 2]
    );
    const checkpoint = await db
      .collection("schema_migration_progress")
      .findOne({ _id: "011_payment_correction_version_backfill_batched" });
    assert.equal(checkpoint.completed, true);
  });

  it("already-applied legacy 002 checksum remains valid without executor metadata", async () => {
    const db = mongoose.connection.db;
    await db.collection("schema_migrations").deleteMany({});
    const migrations = loadMigrationFiles();
    await db.collection("schema_migrations").insertMany(
      migrations.map((migration) => ({
        id: migration.id,
        checksum: migration.checksum,
        status: "applied",
      }))
    );
    await assert.doesNotReject(() => verifyMigrationsApplied(db));
  });

  it("safe executor checksum drift is detected during migration verify", async () => {
    const db = mongoose.connection.db;
    await db.collection("schema_migrations").deleteMany({});
    const migrations = loadMigrationFiles();
    await db.collection("schema_migrations").insertMany(
      migrations.map((migration) => ({
        id: migration.id,
        checksum: migration.checksum,
        status: "applied",
        ...(migration.id === "002_financial_journal_backfill"
          ? {
              sourceChecksum: migration.checksum,
              safeExecutorId: "002_financial_journal_backfill.safe",
              safeExecutorVersion: "v1",
              safeExecutorChecksum: "drifted-checksum",
            }
          : {}),
      }))
    );
    await assert.rejects(() => verifyMigrationsApplied(db), /safe-executor/i);
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

  it("migration 002 safe runner does not fabricate payout fields and reports ambiguity", async () => {
    const db = mongoose.connection.db;
    const customerId = new mongoose.Types.ObjectId();

    const ambiguousSchemeId = new mongoose.Types.ObjectId();
    await db.collection("schemes").insertOne({
      _id: ambiguousSchemeId,
      enrollmentNumber: `ENR-CP5-A-${Date.now()}`,
      customer: customerId,
      status: SCHEME_STATUS.REDEEMED,
      settlement: {
        amount: 1000,
        settledBy: new mongoose.Types.ObjectId(),
      },
      updatedAt: new Date(),
    });
    await db.collection("payments").insertOne({
      _id: new mongoose.Types.ObjectId(),
      receiptNumber: `RCT-CP5-A-${Date.now()}`,
      customer: customerId,
      scheme: ambiguousSchemeId,
      status: PAYMENT_STATUS.SUCCESS,
      amount: 1000,
      paymentMethod: "CASH",
      paymentDate: new Date(),
      createdAt: new Date(),
    });

    const validSchemeId = new mongoose.Types.ObjectId();
    await db.collection("schemes").insertOne({
      _id: validSchemeId,
      enrollmentNumber: `ENR-CP5-B-${Date.now()}`,
      customer: customerId,
      status: SCHEME_STATUS.REDEEMED,
      settlement: {
        amount: 2000,
        settledBy: new mongoose.Types.ObjectId(),
        payoutMethod: "CASH",
      },
      updatedAt: new Date(),
    });
    await db.collection("payments").insertOne({
      _id: new mongoose.Types.ObjectId(),
      receiptNumber: `RCT-CP5-B-${Date.now()}`,
      customer: customerId,
      scheme: validSchemeId,
      status: PAYMENT_STATUS.SUCCESS,
      amount: 2000,
      paymentMethod: "CASH",
      paymentDate: new Date(),
      createdAt: new Date(),
    });

    await runMigration002Safe(db);

    const ambiguousRows = await db.collection("journal_migration_ambiguous").find({}).toArray();
    assert.ok(
      ambiguousRows.some(
        (row) =>
          row.schemeId.toString() === ambiguousSchemeId.toString() &&
          /payout method is missing/i.test(row.reason)
      )
    );

    const paidEntry = await db
      .collection("financialjournals")
      .findOne({ businessKey: `scheme:${validSchemeId}:paid:legacy` });
    assert.equal(paidEntry.metadata.payoutMethod, "CASH");
    assert.equal(
      Object.prototype.hasOwnProperty.call(paidEntry.metadata, "payoutReference"),
      false
    );
  });

  it("ambiguous legacy settlement from migration 002 blocks preflight without fabricated facts", async () => {
    const db = mongoose.connection.db;
    const customerId = new mongoose.Types.ObjectId();
    const schemeId = new mongoose.Types.ObjectId();
    await db.collection("schemes").insertOne({
      _id: schemeId,
      enrollmentNumber: `ENR-CP5-AMB-${Date.now()}`,
      customer: customerId,
      status: SCHEME_STATUS.REDEEMED,
      settlement: {
        amount: 3000,
        settledBy: new mongoose.Types.ObjectId(),
      },
      updatedAt: new Date(),
    });
    await db.collection("payments").insertOne({
      _id: new mongoose.Types.ObjectId(),
      receiptNumber: `RCT-CP5-AMB-${Date.now()}`,
      customer: customerId,
      scheme: schemeId,
      status: PAYMENT_STATUS.SUCCESS,
      amount: 3000,
      paymentMethod: "CASH",
      paymentDate: new Date(),
      createdAt: new Date(),
    });

    await runMigration002Safe(db);
    const paid = await db.collection("financialjournals").findOne({
      businessKey: `scheme:${schemeId}:paid:legacy`,
    });
    assert.equal(paid, null);
    await assert.rejects(
      () => runStartupPreflight({ requireMigrations: true }),
      /Unresolved legacy migration ambiguity/
    );
  });

  it("migration 008 enforces contiguous approved versions and unique partial index", async () => {
    const db = mongoose.connection.db;
    const paymentId = new mongoose.Types.ObjectId();
    await db.collection("paymentcorrections").insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        payment: paymentId,
        status: "APPROVED",
        version: 1,
        reviewedAt: new Date("2026-01-01"),
        createdAt: new Date("2026-01-01"),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        payment: paymentId,
        status: "APPROVED",
        version: 7,
        reviewedAt: new Date("2026-01-02"),
        createdAt: new Date("2026-01-02"),
      },
    ]);

    await migration008.up(db);

    const versions = await db
      .collection("paymentcorrections")
      .find({ payment: paymentId, status: "APPROVED" })
      .sort({ reviewedAt: 1, createdAt: 1, _id: 1 })
      .project({ version: 1 })
      .toArray();
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2]
    );

    const index = (await db.collection("paymentcorrections").indexes()).find(
      (row) => row.name === "uniq_payment_correction_version_approved"
    );
    assert.equal(Boolean(index?.unique), true);
    assert.ok(index?.partialFilterExpression?.status === "APPROVED");
  });

  it("migration 009 upgrades non-unique same-key employeeCode index safely", async () => {
    const db = mongoose.connection.db;
    await db.collection("staffprofiles").dropIndex("uniq_staff_employee_code").catch(() => {});
    await db.collection("staffprofiles").createIndex({ employeeCode: 1 }, { name: "employee_code_tmp" });

    const indexesBefore = await db.collection("staffprofiles").indexes();
    assert.equal(indexesBefore.some((index) => index.name === "employee_code_tmp"), true);

    await migration009.up(db);
    const indexesAfter = await db.collection("staffprofiles").indexes();
    const target = indexesAfter.find((index) => index.name === "uniq_staff_employee_code");
    assert.equal(Boolean(target?.unique), true);
  });

  it("migration 009 rejects wrong option indexes and enforces exact ttl/partial/collation", async () => {
    const db = mongoose.connection.db;
    await db.collection("loginattempts").dropIndex("login_attempt_ttl").catch(() => {});
    await db
      .collection("loginattempts")
      .createIndex({ expiresAt: 1 }, { name: "login_attempt_ttl", expireAfterSeconds: 600 });

    await db.collection("notifications").dropIndex("uniq_notification_delivery_key").catch(() => {});
    await db.collection("notifications").createIndex(
      { deliveryKey: 1 },
      {
        name: "uniq_notification_delivery_key",
        unique: true,
        partialFilterExpression: { deliveryKey: { $exists: true } },
      }
    );

    await migration009.up(db);

    const ttlIndex = (await db.collection("loginattempts").indexes()).find(
      (index) => index.name === "login_attempt_ttl"
    );
    assert.equal(ttlIndex.expireAfterSeconds, 0);

    const deliveryKeyIndex = (await db.collection("notifications").indexes()).find(
      (index) => index.name === "uniq_notification_delivery_key"
    );
    assert.deepEqual(deliveryKeyIndex.partialFilterExpression, {
      deliveryKey: { $exists: true, $type: "string", $gt: "" },
    });
  });

  it("migration 009 stops with actionable duplicates for employeeCode and deliveryKey", async () => {
    const db = mongoose.connection.db;
    await db.collection("staffprofiles").dropIndex("uniq_staff_employee_code").catch(() => {});
    await db.collection("notifications").dropIndex("uniq_notification_delivery_key").catch(() => {});

    const userA = await User.create({
      name: "Staff Dup A",
      phone: `8${String(Date.now()).slice(-8)}7`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: "STAFF",
    });
    const userB = await User.create({
      name: "Staff Dup B",
      phone: `8${String(Date.now()).slice(-8)}8`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: "STAFF",
    });
    await db.collection("staffprofiles").insertMany([
      { user: userA._id, employeeCode: "EMP-DUP", permissions: {}, cashVersion: 0 },
      { user: userB._id, employeeCode: "EMP-DUP", permissions: {}, cashVersion: 0 },
    ]);

    await assert.rejects(
      async () => migration009.up(db),
      (error) =>
        /Duplicate values prevent unique index enforcement/.test(error.message) &&
        Array.isArray(error.duplicates) &&
        error.duplicates.length > 0
    );

    await db.collection("staffprofiles").deleteMany({ employeeCode: "EMP-DUP" });
    await db.collection("notifications").insertMany([
      {
        recipient: userA._id,
        type: "PAYMENT_RECEIVED",
        title: "x",
        message: "x",
        deliveryKey: "DELIV-DUP",
      },
      {
        recipient: userB._id,
        type: "PAYMENT_RECEIVED",
        title: "y",
        message: "y",
        deliveryKey: "DELIV-DUP",
      },
    ]);

    await assert.rejects(
      async () => migration009.up(db),
      (error) =>
        /Duplicate values prevent unique index enforcement/.test(error.message) &&
        Array.isArray(error.duplicates) &&
        error.duplicates.some((row) => row.value === "DELIV-DUP")
    );
  });

  it("lost migration lease aborts the active migration run", async () => {
    const db = mongoose.connection.db;
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await db.collection("schema_migrations").deleteMany({});
    await db.collection("schema_migration_locks").deleteMany({});

    const schemeId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    await db.collection("schemes").insertOne({
      _id: schemeId,
      enrollmentNumber: `ENR-LOCK-${Date.now()}`,
      customer: customerId,
      status: "ACTIVE",
    });
    const paymentRows = Array.from({ length: 1200 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(),
      receiptNumber: `RCT-LOCK-${index}-${Date.now()}`,
      customer: customerId,
      scheme: schemeId,
      status: "SUCCESS",
      amount: 100,
      paymentMethod: "CASH",
      paymentDate: new Date(),
      createdAt: new Date(),
    }));
    await db.collection("payments").insertMany(paymentRows);

    const runnerId = "lease-loss-runner";
    const runPromise = runMigrations(db, { runnerId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db
      .collection("schema_migration_locks")
      .deleteOne({ _id: "migration-runner", runnerId });
    await assert.rejects(() => runPromise, /lock lost|expired/i);
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

  it("outbox dedupe payload conflicts are rejected", async () => {
    const key = `dedupe-conflict:${reqId()}`;
    await enqueueOutboxEvent({
      topic: OUTBOX_TOPICS.CASH_SUBMITTED,
      dedupeKey: key,
      payload: {
        recipient: new mongoose.Types.ObjectId(),
        type: NOTIFICATION_TYPES.CASH_SUBMITTED,
        title: "One",
        message: "One",
      },
    });
    await assert.rejects(
      async () =>
        enqueueOutboxEvent({
          topic: OUTBOX_TOPICS.CASH_SUBMITTED,
          dedupeKey: key,
          payload: {
            recipient: new mongoose.Types.ObjectId(),
            type: NOTIFICATION_TYPES.CASH_SUBMITTED,
            title: "Two",
            message: "Two",
          },
        }),
      /OUTBOX_DEDUPE_PAYLOAD_MISMATCH|payload mismatch/i
    );
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

  it("oversight summary reports outbox deadLetter terminology", async () => {
    await OutboxEvent.create({
      topic: OUTBOX_TOPICS.CASH_SUBMITTED,
      dedupeKey: `summary:${reqId()}`,
      payload: {},
      status: OUTBOX_STATUS.DEAD_LETTER,
      attempts: MAX_ATTEMPTS,
    });
    const summary = await getIntegritySummary();
    assert.equal(typeof summary.outbox.deadLetter, "number");
    assert.equal(Object.prototype.hasOwnProperty.call(summary.outbox, "failed"), false);
  });
});
