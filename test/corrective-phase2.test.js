const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Payment = require("../src/models/payment.model");
const PaymentCorrection = require("../src/models/paymentCorrection.model");
const FinancialJournal = require("../src/models/financialJournal.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  CORRECTION_TYPES,
  SCHEME_STATUS,
  JOURNAL_EVENT_TYPES,
  CORRECTION_STATUS,
} = require("../src/constants/enums");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const { collectPayment } = require("../src/services/payment.service");
const { createScheme, updateSchemeStatus } = require("../src/services/schemeManagement.service");
const {
  createCorrectionRequest,
  approveCorrection,
  rejectCorrection,
} = require("../src/services/correction.service");
const { createCustomer } = require("../src/services/customer.service");
const { computeEntitlement } = require("../src/services/entitlement.service");
const { getEffectiveSnapshotForPayment } = require("../src/utils/effectivePayment");
const { buildSourceSnapshot } = require("../src/utils/paymentLedger");
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

const laterPeriodTime = () => {
  const window = deriveSchemeWindow(calculateSchemeDates(SCHEME_START));
  return new Date(window.laterPeriodStart.getTime() + 24 * 60 * 60 * 1000);
};

const createAdmin = async () =>
  User.create({
    name: "CP2 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async () => {
  const staff = await User.create({
    name: "CP2 Staff",
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

const seedCustomerScheme = async (admin) => {
  const customer = await createCustomer(
    {
      name: "CP2 Customer",
      phone: `7${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
      password: "1234",
    },
    admin
  );
  const scheme = await createScheme(
    { customerId: customer._id.toString(), startDate: SCHEME_START, clientRequestId: reqId() },
    admin
  );
  return { customer, scheme };
};

const pay = async (customer, scheme, actor, amount, method = PAYMENT_METHODS.CASH, at = firstPeriodTime()) =>
  withMockedNow(at, () =>
    collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount,
        paymentMethod: method,
        transactionReference: method === PAYMENT_METHODS.CASH ? undefined : `TXN-${reqId().slice(0, 8)}`,
        clientRequestId: reqId(),
      },
      actor
    )
  );

describe("Corrective Phase 2 — canonical effective payments and corrections", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_cp2_${process.pid}` });
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

  it("preserves immutable original payment facts after sequential corrections", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 3000);
    const original = buildSourceSnapshot(await Payment.findById(paymentResult.payment._id));

    const amountCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 5000, reason: "Fix amount" },
      staff
    );
    await approveCorrection(
      amountCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const notesCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_NOTES, requestedValue: "Corrected note", reason: "Fix notes" },
      staff
    );
    await approveCorrection(
      notesCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const stored = await Payment.findById(paymentResult.payment._id);
    assert.equal(stored.amount, original.amount);
    assert.equal(stored.paymentMethod, original.paymentMethod);

    const effective = await getEffectiveSnapshotForPayment(paymentResult.payment._id);
    assert.equal(effective.amount, 5000);
    assert.equal(effective.notes, "Corrected note");
  });

  it("three-correction chain preserves cumulative effective state", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 4000);

    const steps = [
      { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 4500, reason: "Amount fix" },
      { correctionType: CORRECTION_TYPES.EDIT_REFERENCE, requestedValue: "REF-CP2-1", reason: "Reference fix" },
      { correctionType: CORRECTION_TYPES.EDIT_NOTES, requestedValue: "Final note", reason: "Notes fix" },
    ];

    for (const step of steps) {
      const correction = await createCorrectionRequest(paymentResult.payment._id, step, staff);
      await approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "ok" },
        admin
      );
    }

    const effective = await getEffectiveSnapshotForPayment(paymentResult.payment._id);
    assert.equal(effective.amount, 4500);
    assert.equal(effective.transactionReference, "REF-CP2-1");
    assert.equal(effective.notes, "Final note");
  });

  it("requester cannot approve their own correction", async () => {
    const staff = await createStaff();
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 2000);
    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_NOTES, requestedValue: "x", reason: "Self approve" },
      staff
    );

    await assert.rejects(
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "self" },
        staff
      ),
      (error) => error.statusCode === 403
    );
  });

  it("admin cannot request corrections; only collecting staff can", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 1500);

    await assert.rejects(
      createCorrectionRequest(
        paymentResult.payment._id,
        { correctionType: CORRECTION_TYPES.EDIT_NOTES, requestedValue: "n", reason: "Admin request" },
        admin
      ),
      (error) => error.statusCode === 403
    );
  });

  it("rejects correction after settlement for staff and admin with no override", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 5000);
    await updateSchemeStatus(
      scheme._id,
      {
        status: SCHEME_STATUS.REDEEMED,
        notes: "Settled",
        clientRequestId: reqId(),
        payoutMethod: PAYMENT_METHODS.CASH,
      },
      admin
    );

    await assert.rejects(
      createCorrectionRequest(
        paymentResult.payment._id,
        { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 1000, reason: "Too late" },
        staff
      ),
      (error) => error.code === ERROR_CODES.SCHEME_ALREADY_SETTLED
    );

    await assert.rejects(
      approveCorrection(
        new mongoose.Types.ObjectId(),
        { reviewClientRequestId: reqId() },
        admin
      ),
      (error) => error.statusCode === 404
    );
  });

  it("rejects later-period cap violations using prospective effective ledger", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 10000, PAYMENT_METHODS.CASH, firstPeriodTime());
    await pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH, laterPeriodTime());
    const paymentResult = await pay(customer, scheme, staff, 1000, PAYMENT_METHODS.CASH, laterPeriodTime());

    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 7000, reason: "Over cap" },
      staff
    );

    await assert.rejects(
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "approve" },
        admin
      ),
      (error) => error.code === ERROR_CODES.PAYMENT_LIMIT_EXCEEDED
    );
  });

  it("CASH to UPI without collection reference is rejected; with reference succeeds", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 6000, PAYMENT_METHODS.CASH);

    const badCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_METHOD, requestedValue: PAYMENT_METHODS.UPI, reason: "Switch method" },
      staff
    );
    await assert.rejects(
      approveCorrection(
        badCorrection._id,
        { reviewClientRequestId: reqId(), reviewNotes: "approve" },
        admin
      ),
      (error) => error.statusCode === 400
    );
    await rejectCorrection(
      badCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "reject invalid method change" },
      admin
    );

    const refCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_REFERENCE, requestedValue: "UPI-REF-001", reason: "Add ref" },
      staff
    );
    await approveCorrection(
      refCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const methodCorrection = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_METHOD, requestedValue: PAYMENT_METHODS.UPI, reason: "Switch method" },
      staff
    );
    await approveCorrection(
      methodCorrection._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const effective = await getEffectiveSnapshotForPayment(paymentResult.payment._id);
    assert.equal(effective.paymentMethod, PAYMENT_METHODS.UPI);
    assert.equal(effective.transactionReference, "UPI-REF-001");
  });

  it("approved correction changes entitlement exactly once", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 8000);
    const before = await computeEntitlement(scheme._id);

    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 7000, reason: "Reduce" },
      staff
    );
    await approveCorrection(
      correction._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const after = await computeEntitlement(scheme._id);
    assert.equal(before.finalEntitlement, 8000);
    assert.equal(after.finalEntitlement, 7000);
  });

  it("concurrent approvals apply one final correction status", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 3000, PAYMENT_METHODS.UPI);
    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_NOTES, requestedValue: "Updated", reason: "Notes" },
      staff
    );

    const results = await Promise.allSettled([
      approveCorrection(correction._id, { reviewClientRequestId: reqId(), reviewNotes: "a" }, admin),
      rejectCorrection(correction._id, { reviewClientRequestId: reqId(), reviewNotes: "r" }, admin),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1);

    const saved = await PaymentCorrection.findById(correction._id);
    assert.notEqual(saved.status, CORRECTION_STATUS.PENDING);
  });

  it("method correction posts balanced non-self journal entries", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 2500, PAYMENT_METHODS.CASH);

    await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_REFERENCE, requestedValue: "BANK-REF-9", reason: "Add ref" },
      staff
    ).then((correction) =>
      approveCorrection(correction._id, { reviewClientRequestId: reqId(), reviewNotes: "ok" }, admin)
    );

    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_METHOD, requestedValue: PAYMENT_METHODS.BANK, reason: "Bank method" },
      staff
    );
    await approveCorrection(
      correction._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const adjustments = await FinancialJournal.find({
      sourceRecordId: correction._id,
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_ADJUSTMENT,
    });
    assert.ok(adjustments.length >= 2);
    assert.ok(
      adjustments.every(
        (entry) => entry.debitAccount !== entry.creditAccount || entry.amount === 0
      )
    );
    assert.ok(adjustments.some((entry) => entry.metadata?.phase === "unwind"));
    assert.ok(adjustments.some((entry) => entry.metadata?.phase === "apply"));
  });

  it("idempotent approve replay is stable and conflicting payload is rejected", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 2200, PAYMENT_METHODS.UPI);
    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      { correctionType: CORRECTION_TYPES.EDIT_NOTES, requestedValue: "Stable", reason: "Notes" },
      staff
    );
    const reviewClientRequestId = reqId();
    const payload = { reviewClientRequestId, reviewNotes: "ok", approvedValue: "Stable" };

    await approveCorrection(correction._id, payload, admin);
    await approveCorrection(correction._id, payload, admin);

    await assert.rejects(
      approveCorrection(
        correction._id,
        { ...payload, reviewClientRequestId: reqId(), approvedValue: "Different" },
        admin
      ),
      (error) => error.code === ERROR_CODES.CORRECTION_ALREADY_REVIEWED
    );
  });
});
