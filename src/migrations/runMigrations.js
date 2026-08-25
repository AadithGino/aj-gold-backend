const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  runMigration002Safe,
  SAFE_EXECUTOR_ID,
  SAFE_EXECUTOR_VERSION,
} = require("./safeRunners/002_financial_journal_backfill.safe");

const MIGRATIONS_DIR = path.join(__dirname, "versions");
const APPLIED_COLLECTION = "schema_migrations";
const LOCK_COLLECTION = "schema_migration_locks";
const LOCK_TTL_MS = Number(process.env.MIGRATION_LOCK_TTL_MS || 5 * 60 * 1000);
const LOCK_DOC_ID = "migration-runner";
const SAFE_MIGRATION_002_PATH = path.join(
  __dirname,
  "safeRunners",
  "002_financial_journal_backfill.safe.js"
);

const computeChecksum = (content) =>
  crypto.createHash("sha256").update(content).digest("hex");

const getMigration002SafeMetadata = () => {
  const executorSource = fs.readFileSync(SAFE_MIGRATION_002_PATH, "utf8");
  return {
    id: SAFE_EXECUTOR_ID,
    version: SAFE_EXECUTOR_VERSION,
    checksum: computeChecksum(executorSource),
  };
};

const ensureMigrationCollections = async (db) => {
  const requiredCollections = [
    "schemes",
    "payments",
    "cashsubmissions",
    "financialjournals",
    "journal_migration_ambiguous",
    "staffprofiles",
    "notifications",
    "paymentcorrections",
    "idempotencyrecords",
    "outboxevents",
    "loginattempts",
  ];
  for (const name of requiredCollections) {
    await db.createCollection(name).catch(() => {});
  }
};

const loadMigrationFiles = () =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const content = fs.readFileSync(fullPath, "utf8");
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const migration = require(fullPath);
      return {
        file,
        fullPath,
        content,
        checksum: computeChecksum(content),
        ...migration,
      };
    });

const acquireMigrationLock = async (db, runnerId) => {
  const locks = db.collection(LOCK_COLLECTION);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  await locks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});

  const claimed = await locks.findOneAndUpdate(
    {
      _id: LOCK_DOC_ID,
      $or: [{ expiresAt: { $lte: now } }, { runnerId }],
    },
    {
      $set: {
        runnerId,
        host: os.hostname(),
        pid: process.pid,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
      },
    },
    { returnDocument: "after" }
  );

  if (claimed) {
    return claimed;
  }

  try {
    await locks.insertOne({
      _id: LOCK_DOC_ID,
      runnerId,
      host: os.hostname(),
      pid: process.pid,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
    });
    return locks.findOne({ _id: LOCK_DOC_ID });
  } catch (error) {
    if (error?.code === 11000) {
      const holder = await locks.findOne({ _id: LOCK_DOC_ID });
      throw new Error(
        `Another migration runner holds the lock (${holder?.runnerId || "unknown"}).`
      );
    }
    throw error;
  }
};

const renewMigrationLock = async (db, runnerId) => {
  const now = new Date();
  const result = await db.collection(LOCK_COLLECTION).updateOne(
    { _id: LOCK_DOC_ID, runnerId },
    {
      $set: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + LOCK_TTL_MS),
      },
    }
  );
  if (result.matchedCount === 0) {
    throw new Error("Migration lock lost or expired for this runner.");
  }
};

const releaseMigrationLock = async (db, runnerId) => {
  await db.collection(LOCK_COLLECTION).deleteOne({ _id: LOCK_DOC_ID, runnerId });
};

const verifyMigrationsApplied = async (db) => {
  const appliedCollection = db.collection(APPLIED_COLLECTION);
  const migrations = loadMigrationFiles();
  const missing = [];
  const drift = [];

  for (const migration of migrations) {
    const existing = await appliedCollection.findOne({ id: migration.id });
    if (!existing) {
      missing.push(migration.id);
      continue;
    }
    if (existing.checksum !== migration.checksum) {
      drift.push(migration.id);
    }
    if (migration.id === "002_financial_journal_backfill" && existing.safeExecutorChecksum) {
      const safeMeta = getMigration002SafeMetadata();
      if (
        existing.safeExecutorChecksum !== safeMeta.checksum ||
        existing.safeExecutorVersion !== safeMeta.version ||
        existing.safeExecutorId !== safeMeta.id
      ) {
        drift.push(`${migration.id}::safe-executor`);
      }
      if (existing.sourceChecksum && existing.sourceChecksum !== migration.checksum) {
        drift.push(`${migration.id}::source`);
      }
    }
    if (existing.status && !["applied", undefined].includes(existing.status)) {
      throw new Error(`Migration ${migration.id} has status ${existing.status}.`);
    }
  }

  if (drift.length) {
    throw new Error(`Migration checksum drift detected: ${drift.join(", ")}`);
  }
  if (missing.length) {
    throw new Error(`Pending migrations not applied: ${missing.join(", ")}`);
  }

  return { verified: migrations.length };
};

const resolveExistingMigration = async (appliedCollection, existing, migration) => {
  if (existing.checksum !== migration.checksum) {
    throw new Error(
      `Migration checksum mismatch for ${migration.id}. Expected ${existing.checksum}, found ${migration.checksum}.`
    );
  }

  if (existing.status === "applied" || !existing.status) {
    return "skipped";
  }

  if (existing.status === "failed") {
    await appliedCollection.deleteOne({ id: migration.id, status: "failed" });
    return "retry";
  }

  if (existing.status === "running") {
    const staleMs = Date.now() - new Date(existing.startedAt || 0).getTime();
    if (staleMs < LOCK_TTL_MS) {
      throw new Error(`Migration ${migration.id} is already running.`);
    }
    await appliedCollection.deleteOne({ id: migration.id, status: "running" });
    return "retry";
  }

  return "skipped";
};

const executeMigrationUp = async (migration, db) => {
  if (migration.id === "002_financial_journal_backfill") {
    await runMigration002Safe(db);
    return;
  }
  await migration.up(db);
};

const buildMigrationRecordMetadata = (migration) => {
  if (migration.id !== "002_financial_journal_backfill") {
    return {};
  }
  const safeMeta = getMigration002SafeMetadata();
  return {
    sourceChecksum: migration.checksum,
    safeExecutorId: safeMeta.id,
    safeExecutorVersion: safeMeta.version,
    safeExecutorChecksum: safeMeta.checksum,
  };
};

const runMigrations = async (db, { dryRun = false, verifyOnly = false, runnerId } = {}) => {
  const appliedCollection = db.collection(APPLIED_COLLECTION);
  const migrations = loadMigrationFiles();
  const report = [];
  const lockOwner = runnerId || `runner-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  let heartbeatTimer = null;
  let heartbeatError = null;

  if (verifyOnly) {
    const verified = await verifyMigrationsApplied(db);
    return [{ id: "*", status: "verified", ...verified }];
  }

  await acquireMigrationLock(db, lockOwner);
  await ensureMigrationCollections(db);
  heartbeatTimer = setInterval(() => {
    renewMigrationLock(db, lockOwner).catch((error) => {
      if (!heartbeatError) {
        heartbeatError = error;
      }
    });
  }, Math.max(Math.floor(LOCK_TTL_MS / 3), 1000));
  if (typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }

  try {
    for (const migration of migrations) {
      if (heartbeatError) {
        throw heartbeatError;
      }
      await renewMigrationLock(db, lockOwner);

      const existing = await appliedCollection.findOne({ id: migration.id });
      if (existing) {
        const action = await resolveExistingMigration(appliedCollection, existing, migration);
        if (action === "skipped") {
          report.push({ id: migration.id, status: "skipped" });
          continue;
        }
      }

      if (dryRun) {
        report.push({ id: migration.id, status: "dry-run" });
        continue;
      }

      const startedAt = new Date();
      await appliedCollection.insertOne({
        id: migration.id,
        checksum: migration.checksum,
        ...buildMigrationRecordMetadata(migration),
        status: "running",
        startedAt,
        runnerId: lockOwner,
      });

      try {
        await executeMigrationUp(migration, db);
        if (heartbeatError) {
          throw heartbeatError;
        }
        const finishedAt = new Date();
        await appliedCollection.updateOne(
          { id: migration.id, status: "running" },
          {
            $set: {
              status: "applied",
              finishedAt,
              appliedAt: finishedAt,
            },
          }
        );
        report.push({ id: migration.id, status: "applied", startedAt, finishedAt });
      } catch (error) {
        await appliedCollection.updateOne(
          { id: migration.id, status: "running" },
          {
            $set: {
              status: "failed",
              finishedAt: new Date(),
              error: error.message,
            },
          }
        );
        throw error;
      }
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await releaseMigrationLock(db, lockOwner);
  }

  return report;
};

module.exports = {
  runMigrations,
  loadMigrationFiles,
  computeChecksum,
  verifyMigrationsApplied,
  acquireMigrationLock,
  renewMigrationLock,
  releaseMigrationLock,
  LOCK_TTL_MS,
};
