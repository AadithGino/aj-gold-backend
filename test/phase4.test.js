const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const OutboxEvent = require("../src/models/outboxEvent.model");
const Notification = require("../src/models/notification.model");
const FinancialJournal = require("../src/models/financialJournal.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  JOURNAL_EVENT_TYPES,
  CORRECTION_TYPES,
} = require("../src/constants/enums");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const { collectPayment } = require("../src/services/payment.service");
const {
  createCashSubmission,
  reverseCashSubmission,
} = require("../src/services/cash.service");
const {
  createCorrectionRequest,
  approveCorrection,
} = require("../src/services/correction.service");
const { createCustomer } = require("../src/services/customer.service");
const { createScheme } = require("../src/services/schemeManagement.service");
const { buildReconciliationSummary } = require("../src/services/reconciliation.service");
const { getStaffCustodyBalance } = require("../src/services/financialJournal.service");
const { appendJournalEntry } = require("../src/services/financialJournal.service");
const { JOURNAL_ACCOUNTS } = require("../src/constants/journalAccounts");
const { scanIntegrity } = require("../src/ops/integrityScanner");
const { processOutboxBatch } = require("../src/services/outbox.service");
const { FULL_OPERATIONAL_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");
const { runMigrations } = require("../src/migrations/runMigrations");
const {
  startOfDay,
  endOfDay,
  startOfWeek,
  BUSINESS_TIMEZONE,
} = require("../src/utils/date");
const { parseSafeSearchTerm } = require("../src/utils/safeSearch");
const { parseCursorPagination, buildCursorPage } = require("../src/utils/pagination");
const { calculateSchemeDates } = require("../src/services/scheme.service");
const { deriveSchemeWindow } = require("../src/utils/schemeWindow");

const reqId = () => crypto.randomUUID();

let replSet;
let mockTimerDepth = 0;

const withMockedNow = async (when, fn) => {
  if (mockTimerDepth === 0) {
    mock.timers.enable({ apis: ["Date"], now: when.getTime() });
  } else {
    mock.timers.setTime(when.getTime());
  }
  mockTimerDepth += 1;
  try {
    return await fn();
  } finally {
    mockTimerDepth -= 1;
    if (mockTimerDepth === 0) {
      mock.timers.reset();
    }
  }
};

const pay = async (customer, scheme, actor, amount, method = PAYMENT_METHODS.CASH) =>
  withMockedNow(firstPeriodTime(), () =>
    collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount,
        paymentMethod: method,
        ...(method === PAYMENT_METHODS.CASH
          ? {}
          : { transactionReference: `TXN-${reqId().slice(0, 8)}` }),
        clientRequestId: reqId(),
      },
      actor
    )
  );

const firstPeriodTime = () => {
  const window = deriveSchemeWindow(calculateSchemeDates("2025-01-01"));
  return new Date(window.startDate.getTime() + 24 * 60 * 60 * 1000);
};

const createAdmin = async () =>
  User.create({
    name: "Phase4 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async () => {
  const staff = await User.create({
    name: "Phase4 Staff",
    phone: `8${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });
  await StaffProfile.create({
    user: staff._id,
    permissions: FULL_OPERATIONAL_STAFF_PERMISSIONS,
  });
  return staff;
};

describe("Phase 4 custody, reconciliation, timezone, outbox", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_phase4_${process.pid}`,
    });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await mongoose.connection.db.collection("journal_migration_ambiguous").deleteMany({});
    await runMigrations(mongoose.connection.db);
  });

  after(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  it("cash collection increases staff journal custody", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Custody Customer",
        phone: `7${String(Date.now()).slice(-8)}1`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH);

    const custody = await getStaffCustodyBalance(staff._id);
    assert.equal(custody, 5000);
  });

  it("submission moves custody from staff to vault exactly once", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Submit Customer",
        phone: `7${String(Date.now()).slice(-8)}2`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 9000, PAYMENT_METHODS.CASH);

    await createCashSubmission(
      {
        staff: staff._id.toString(),
        submittedAmount: 4000,
        clientRequestId: reqId(),
      },
      admin
    );

    const custody = await getStaffCustodyBalance(staff._id);
    assert.equal(custody, 5000);

    const submissionEntries = await FinancialJournal.find({
      eventType: JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED,
    });
    assert.equal(submissionEntries.length, 1);
    assert.equal(submissionEntries[0].amount, 4000);
  });

  it("rejects non-cash collection without transactionReference", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "Ref Customer",
        phone: `7${String(Date.now()).slice(-8)}3`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await assert.rejects(
      collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 1000,
          paymentMethod: PAYMENT_METHODS.UPI,
          clientRequestId: reqId(),
        },
        admin
      ),
      (error) => error.code === ERROR_CODES.NON_CASH_REFERENCE_REQUIRED
    );
  });

  it("cash submission reversal restores staff custody via journal", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Reverse Submit Customer",
        phone: `7${String(Date.now()).slice(-8)}4`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 6000, PAYMENT_METHODS.CASH);

    const { submission } = await createCashSubmission(
      {
        staff: staff._id.toString(),
        submittedAmount: 6000,
        clientRequestId: reqId(),
      },
      admin
    );

    assert.equal(await getStaffCustodyBalance(staff._id), 0);

    await reverseCashSubmission(
      submission._id,
      { reason: "Wrong submission amount", clientRequestId: reqId() },
      admin
    );

    assert.equal(await getStaffCustodyBalance(staff._id), 6000);
  });

  it("repeated reversal (same and different idempotency key) does not create second effect", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Reverse Idempotency Customer",
        phone: `7${String(Date.now()).slice(-8)}9`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );
    await pay(customer, scheme, staff, 4000, PAYMENT_METHODS.CASH);
    const { submission } = await createCashSubmission(
      {
        staff: staff._id.toString(),
        submittedAmount: 4000,
        clientRequestId: reqId(),
      },
      admin
    );

    const reverseKey = reqId();
    await reverseCashSubmission(
      submission._id,
      { reason: "initial reversal", clientRequestId: reverseKey },
      admin
    );
    await reverseCashSubmission(
      submission._id,
      { reason: "initial reversal", clientRequestId: reverseKey },
      admin
    );

    await assert.rejects(
      reverseCashSubmission(
        submission._id,
        { reason: "different key replay", clientRequestId: reqId() },
        admin
      ),
      (error) => error.code === ERROR_CODES.CASH_SUBMISSION_ALREADY_REVERSED
    );

    const reversalEntries = await FinancialJournal.find({
      businessKey: `cash-submission:${submission._id}:reversal`,
    });
    assert.equal(reversalEntries.length, 1);
  });

  it("concurrent submissions cannot overdraw staff custody", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Concurrent Submission Customer",
        phone: `7${String(Date.now()).slice(-8)}8`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );
    await pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH);

    const [first, second] = await Promise.allSettled([
      createCashSubmission(
        {
          staff: staff._id.toString(),
          submittedAmount: 4000,
          clientRequestId: reqId(),
        },
        admin
      ),
      createCashSubmission(
        {
          staff: staff._id.toString(),
          submittedAmount: 4000,
          clientRequestId: reqId(),
        },
        admin
      ),
    ]);

    const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
    const rejected = [first, second].filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, ERROR_CODES.INSUFFICIENT_STAFF_CASH);
    assert.equal(await getStaffCustodyBalance(staff._id), 1000);
  });

  it("correction amount/method chain updates custody with unwind/apply entries", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Correction Custody Customer",
        phone: `7${String(Date.now()).slice(-8)}7`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );
    const paymentResult = await pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH);
    assert.equal(await getStaffCustodyBalance(staff._id), 5000);

    const amountCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 4500, reason: "amount fix" },
      staff
    );
    await approveCorrection(
      amountCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );
    assert.equal(await getStaffCustodyBalance(staff._id), 4500);

    const refCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_REFERENCE, requestedValue: "UPI-CP4-1", reason: "add reference" },
      staff
    );
    await approveCorrection(
      refCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const methodCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_METHOD, requestedValue: PAYMENT_METHODS.UPI, reason: "switch method" },
      staff
    );
    await approveCorrection(
      methodCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const adjustments = await FinancialJournal.find({
      sourceRecordType: "PaymentCorrection",
      sourceRecordId: methodCorrection._id,
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
    }).lean();
    assert.ok(adjustments.some((row) => row.metadata?.phase === "unwind"));
    assert.ok(adjustments.some((row) => row.metadata?.phase === "apply"));
    assert.equal(await getStaffCustodyBalance(staff._id), 0);
  });

  it("reconciliation summary balances after collect and submit", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Recon Customer",
        phone: `7${String(Date.now()).slice(-8)}5`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 3000, PAYMENT_METHODS.CASH);

    const summary = await buildReconciliationSummary();
    assert.equal(summary.flows.netCustomerCollected, 3000);
    assert.equal(summary.accounts.totalStaffCustody, 3000);
    assert.equal(summary.exceptions.length, 0);
  });

  it("all custody journal events include staff attribution", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Staff Attribution Customer",
        phone: `7${String(Date.now()).slice(-8)}0`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );
    const paymentResult = await pay(customer, scheme, staff, 2000, PAYMENT_METHODS.CASH);
    const { submission } = await createCashSubmission(
      {
        staff: staff._id.toString(),
        submittedAmount: 1000,
        clientRequestId: reqId(),
      },
      admin
    );
    await reverseCashSubmission(
      submission._id,
      { reason: "reverse", clientRequestId: reqId() },
      admin
    );

    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 1500, reason: "reduce cash" },
      staff
    );
    await approveCorrection(
      correction._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const custodyEvents = await FinancialJournal.find({
      eventType: {
        $in: [
          JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED,
          JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
          JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED,
          JOURNAL_EVENT_TYPES.VAULT_REVERSAL,
        ],
      },
    }).lean();
    assert.ok(custodyEvents.length > 0);
    assert.ok(
      custodyEvents.every((entry) => entry.metadata?.staffId || entry.actor)
    );
  });

  it("journal mutation APIs reject update/delete/replace/bulkWrite", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      {
        name: "Journal Immutable Customer",
        phone: `7${String(Date.now()).slice(-8)}4`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );
    await pay(customer, scheme, staff, 1000, PAYMENT_METHODS.CASH);
    const entry = await FinancialJournal.findOne({});
    assert.ok(entry);

    await assert.rejects(FinancialJournal.updateOne({ _id: entry._id }, { amount: 99 }), /immutable/i);
    await assert.rejects(FinancialJournal.updateMany({}, { amount: 99 }), /immutable/i);
    await assert.rejects(FinancialJournal.deleteOne({ _id: entry._id }), /immutable/i);
    await assert.rejects(FinancialJournal.deleteMany({}), /immutable/i);
    await assert.rejects(
      FinancialJournal.findOneAndUpdate({ _id: entry._id }, { amount: 99 }),
      /immutable/i
    );
    await assert.rejects(
      FinancialJournal.findOneAndDelete({ _id: entry._id }),
      /immutable/i
    );
    await assert.rejects(
      FinancialJournal.replaceOne({ _id: entry._id }, { ...entry.toObject(), amount: 99 }),
      /immutable/i
    );
    await assert.rejects(
      FinancialJournal.bulkWrite([{ updateOne: { filter: { _id: entry._id }, update: { $set: { amount: 99 } } } }]),
      /immutable/i
    );
  });

  it("business-key payload mismatch is rejected", async () => {
    const admin = await createAdmin();
    const key = `test:business-key:${reqId()}`;
    await appendJournalEntry({
      businessKey: key,
      eventType: JOURNAL_EVENT_TYPES.VAULT_ADJUSTMENT,
      amount: 1000,
      debitAccount: JOURNAL_ACCOUNTS.VAULT,
      creditAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
      sourceRecordType: "Test",
      sourceRecordId: new mongoose.Types.ObjectId(),
      actor: admin._id,
      actorRole: admin.role,
      metadata: { staffId: admin._id.toString() },
    });

    await assert.rejects(
      appendJournalEntry({
        businessKey: key,
        eventType: JOURNAL_EVENT_TYPES.VAULT_ADJUSTMENT,
        amount: 1200,
        debitAccount: JOURNAL_ACCOUNTS.VAULT,
        creditAccount: JOURNAL_ACCOUNTS.CUSTOMER_SCHEME_LIABILITY,
        sourceRecordType: "Test",
        sourceRecordId: new mongoose.Types.ObjectId(),
        actor: admin._id,
        actorRole: admin.role,
      }),
      (error) => error.code === ERROR_CODES.JOURNAL_BUSINESS_KEY_MISMATCH
    );
  });

  it("integrity scanner reports seeded defects", async () => {
    const customerId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("journal_migration_ambiguous").insertOne({
      migrationId: "test",
      reason: "seeded ambiguity",
      recordedAt: new Date(),
    });
    await FinancialJournal.collection.insertOne({
      entryId: reqId(),
      businessKey: `seed:self:${reqId()}`,
      eventType: JOURNAL_EVENT_TYPES.VAULT_ADJUSTMENT,
      amount: 500,
      debitAccount: JOURNAL_ACCOUNTS.VAULT,
      creditAccount: JOURNAL_ACCOUNTS.VAULT,
      sourceRecordType: "Seed",
      sourceRecordId: new mongoose.Types.ObjectId(),
      effectiveAt: new Date(),
      recordedAt: new Date(),
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await FinancialJournal.collection.insertOne({
      entryId: reqId(),
      businessKey: `seed:missing-staff:${reqId()}`,
      eventType: JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED,
      amount: 300,
      debitAccount: JOURNAL_ACCOUNTS.VAULT,
      creditAccount: JOURNAL_ACCOUNTS.STAFF_CASH_CUSTODY,
      customer: customerId,
      scheme: new mongoose.Types.ObjectId(),
      sourceRecordType: "Seed",
      sourceRecordId: new mongoose.Types.ObjectId(),
      effectiveAt: new Date(),
      recordedAt: new Date(),
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const report = await scanIntegrity({ db: mongoose.connection.db, limit: 100 });
    const codes = new Set(report.findings.map((row) => row.code));
    assert.ok(codes.has("MIGRATION_AMBIGUITY"));
    assert.ok(codes.has("JOURNAL_SELF_BALANCE"));
    assert.ok(codes.has("MISSING_STAFF_ATTRIBUTION"));
    assert.equal(report.pagination.hasMore, false);
  });

  it("clean fixture produces no critical integrity findings", async () => {
    const report = await scanIntegrity({ db: mongoose.connection.db, limit: 100 });
    assert.equal(report.ok, true);
    assert.equal(report.criticalCount, 0);
  });

  it("uses Asia/Kolkata day and ISO week boundaries", () => {
    const istMidnightUtc = new Date("2025-01-01T18:30:00.000Z");
    const dayStart = startOfDay(istMidnightUtc);
    const dayEnd = endOfDay(istMidnightUtc);
    assert.equal(dayStart.toISOString(), "2025-01-01T18:30:00.000Z");
    assert.equal(dayEnd.toISOString(), "2025-01-02T18:29:59.999Z");

    const monday = startOfWeek(new Date("2025-01-08T18:30:00.000Z"));
    assert.equal(monday.toISOString(), "2025-01-05T18:30:00.000Z");
    assert.equal(BUSINESS_TIMEZONE, "Asia/Kolkata");
  });

  it("escapes regex-special search input", () => {
    const escaped = parseSafeSearchTerm("a+b(c)?");
    assert.equal(escaped, "a\\+b\\(c\\)\\?");
  });

  it("cursor pagination enforces max page size and stable ordering", () => {
    const { limit } = parseCursorPagination({ limit: 500 }, { maxLimit: 100 });
    assert.equal(limit, 100);

    const rows = [{ _id: "2" }, { _id: "1" }];
    const page = buildCursorPage([...rows, { _id: "0" }], {
      limit: 2,
      getCursorValue: (row) => ({ _id: row._id }),
    });
    assert.equal(page.items.length, 2);
    assert.equal(page.pageInfo.hasMore, true);
    assert.ok(page.pageInfo.nextCursor);
  });

  it("creates outbox event atomically with payment and worker delivers notification", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "Outbox Customer",
        phone: `7${String(Date.now()).slice(-8)}6`,
        password: "customer1pass",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    const activated = await processOutboxBatch({ limit: 10 });
    assert.equal(activated.sent, 1);
    assert.equal(
      await Notification.countDocuments({
        recipient: customer.user,
        type: "SCHEME_ACTIVATED",
      }),
      1
    );

    await withMockedNow(firstPeriodTime(), () =>
      collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 1500,
          paymentMethod: PAYMENT_METHODS.UPI,
          transactionReference: "UTR-123456",
          clientRequestId: reqId(),
        },
        admin
      )
    );

    const pending = await OutboxEvent.countDocuments({ status: "PENDING" });
    assert.equal(pending, 1);

    const result = await processOutboxBatch({ limit: 10 });
    assert.equal(result.sent, 1);

    const notifications = await Notification.find({
      recipient: customer.user,
      type: "PAYMENT_RECEIVED",
    });
    assert.equal(notifications.length, 1);
  });
});
