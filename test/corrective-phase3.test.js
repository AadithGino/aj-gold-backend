const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Scheme = require("../src/models/scheme.model");
const CashSubmission = require("../src/models/cashSubmission.model");
const Payment = require("../src/models/payment.model");
const FinancialJournal = require("../src/models/financialJournal.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  JOURNAL_EVENT_TYPES,
  CASH_SUBMISSION_STATUS,
} = require("../src/constants/enums");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const { CANONICAL_CUSTODY_SOURCE } = require("../src/ops/cashCustodyContract");
const { collectPayment } = require("../src/services/payment.service");
const {
  createCashSubmission,
  reverseCashSubmission,
} = require("../src/services/cash.service");
const { createCustomer } = require("../src/services/customer.service");
const { createScheme } = require("../src/services/schemeManagement.service");
const { getStaffCashInHand } = require("../src/services/staffCash.service");
const { getStaffCustodyBalance, assertJournalImmutable } = require("../src/services/financialJournal.service");
const { buildReconciliationSummary } = require("../src/services/reconciliation.service");
const { scanIntegrity, paginateFindings } = require("../src/ops/integrityScanner");
const { journalBusinessKey } = require("../src/utils/journalRecording");
const { FULL_OPERATIONAL_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");
const { runMigrations } = require("../src/migrations/runMigrations");
const { calculateSchemeDates } = require("../src/services/scheme.service");
const { deriveSchemeWindow } = require("../src/utils/schemeWindow");

const reqId = () => crypto.randomUUID();
const SCHEME_START = "2025-01-01";

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

const firstPeriodTime = () => {
  const window = deriveSchemeWindow(calculateSchemeDates(SCHEME_START));
  return new Date(window.startDate.getTime() + 24 * 60 * 60 * 1000);
};

const pay = async (customer, scheme, actor, amount, method = PAYMENT_METHODS.CASH, at = null) => {
  const schemeDoc = scheme.startDate ? scheme : await Scheme.findById(scheme._id);
  const when = at || firstPeriodTime();
  return withMockedNow(when, () =>
    collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount,
        paymentMethod: method,
        clientRequestId: reqId(),
      },
      actor
    )
  );
};

const createAdmin = async () =>
  User.create({
    name: "CP3 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async () => {
  const staff = await User.create({
    name: "CP3 Staff",
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

describe("Corrective Phase 3 — cash custody, journals, integrity", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_cp3_${process.pid}` });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await runMigrations(mongoose.connection.db);
  });

  after(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  it("documents FinancialJournal as canonical custody source", () => {
    assert.equal(CANONICAL_CUSTODY_SOURCE, "FinancialJournal");
  });

  it("cash collect → submit → reverse returns original custody position", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      { name: "CP3 Customer", phone: `7${String(Date.now()).slice(-8)}1`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 6000);

    assert.equal(await getStaffCustodyBalance(staff._id), 6000);

    const { submission } = await createCashSubmission(
      { staff: staff._id.toString(), submittedAmount: 6000, clientRequestId: reqId() },
      admin
    );
    assert.equal(await getStaffCustodyBalance(staff._id), 0);

    await reverseCashSubmission(
      submission._id,
      { reason: "Wrong submission", clientRequestId: reqId() },
      admin
    );

    assert.equal(await getStaffCustodyBalance(staff._id), 6000);

    const saved = await CashSubmission.findById(submission._id);
    assert.equal(saved.status, CASH_SUBMISSION_STATUS.REVERSED);
  });

  it("second reversal with different idempotency key cannot create another effect", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      { name: "CP3 Customer 2", phone: `7${String(Date.now()).slice(-8)}2`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 4000);

    const { submission } = await createCashSubmission(
      { staff: staff._id.toString(), submittedAmount: 4000, clientRequestId: reqId() },
      admin
    );

    const firstKey = reqId();
    await reverseCashSubmission(
      submission._id,
      { reason: "Reverse once", clientRequestId: firstKey },
      admin
    );

    await assert.rejects(
      reverseCashSubmission(
        submission._id,
        { reason: "Reverse twice", clientRequestId: reqId() },
        admin
      ),
      (error) => error.code === ERROR_CODES.CASH_SUBMISSION_ALREADY_REVERSED
    );

    const reversalEntries = await FinancialJournal.find({
      businessKey: journalBusinessKey.cashSubmissionReversal(submission._id),
    });
    assert.equal(reversalEntries.length, 1);
  });

  it("reversed submissions are excluded from active submitted totals", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      { name: "CP3 Customer 3", phone: `7${String(Date.now()).slice(-8)}3`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 5000);

    const { submission } = await createCashSubmission(
      { staff: staff._id.toString(), submittedAmount: 5000, clientRequestId: reqId() },
      admin
    );

    await reverseCashSubmission(
      submission._id,
      { reason: "Undo submit", clientRequestId: reqId() },
      admin
    );

    const summary = await getStaffCashInHand(staff._id);
    assert.equal(summary.cashSubmitted, 0);
    assert.equal(summary.cashCollected, 5000);
    assert.equal(summary.cashInHand, 5000);
  });

  it("journal entries include staff attribution metadata on collection and submission", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      { name: "CP3 Customer 4", phone: `7${String(Date.now()).slice(-8)}4`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    const payment = await pay(customer, scheme, staff, 2000);

    const collectionEntry = await FinancialJournal.findOne({
      sourceRecordId: payment.payment._id,
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED,
    });
    assert.equal(String(collectionEntry.metadata.staffId), String(staff._id));

    const { submission } = await createCashSubmission(
      { staff: staff._id.toString(), submittedAmount: 1000, clientRequestId: reqId() },
      admin
    );
    const submitEntry = await FinancialJournal.findOne({
      sourceRecordId: submission._id,
      eventType: JOURNAL_EVENT_TYPES.STAFF_CASH_SUBMITTED,
    });
    assert.equal(String(submitEntry.metadata.staffId), String(staff._id));
  });

  it("reconciliation agrees journal custody with derived aggregate on clean fixture", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      { name: "CP3 Customer 5", phone: `7${String(Date.now()).slice(-8)}5`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 3500);

    const summary = await buildReconciliationSummary();
    assert.equal(summary.exceptions.length, 0);
  });

  it("journal update and save attempts are rejected", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      { name: "CP3 Customer 6", phone: `7${String(Date.now()).slice(-8)}6`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 1000);

    const entry = await FinancialJournal.findOne({});
    await assert.rejects(FinancialJournal.updateOne({ _id: entry._id }, { amount: 9999 }), /immutable/i);
    entry.amount = 8888;
    await assert.rejects(entry.save(), /immutable/i);
    assert.throws(() => assertJournalImmutable(), /immutable/i);
  });

  it("integrity scanner detects cap violation and stays clean on valid fixture", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const customer = await createCustomer(
      { name: "CP3 Clean", phone: `7${String(Date.now()).slice(-8)}7`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await pay(customer, scheme, staff, 5000);

    const clean = await scanIntegrity({ db: mongoose.connection.db });
    assert.equal(clean.ok, true);
    assert.equal(clean.criticalCount, 0);
    assert.ok(clean.pagination);

    const window = deriveSchemeWindow(calculateSchemeDates("2025-01-01"));
    await Payment.create({
      customer: customer._id,
      scheme: scheme._id,
      collectedBy: staff._id,
      collectedByRole: USER_ROLES.STAFF,
      amount: 6000,
      paymentMethod: PAYMENT_METHODS.CASH,
      paymentDate: new Date(window.laterPeriodStart.getTime() + 24 * 60 * 60 * 1000),
      receiptNumber: `SEED-${reqId().slice(0, 8)}`,
      status: "SUCCESS",
    });

    const violated = await scanIntegrity({ db: mongoose.connection.db });
    assert.equal(violated.ok, false);
    assert.ok(violated.findings.some((finding) => finding.code === "CAP_VIOLATION"));
  });

  it("integrity scanner paginates findings without silent truncation metadata loss", async () => {
    const findings = Array.from({ length: 25 }, (_, index) => ({
      severity: "warning",
      code: "TEST",
      message: `Finding ${index}`,
    }));
    const page = paginateFindings(findings, { offset: 0, limit: 10 });
    assert.equal(page.findings.length, 10);
    assert.equal(page.pagination.total, 25);
    assert.equal(page.pagination.hasMore, true);
    assert.equal(page.pagination.nextOffset, 10);
  });
});
