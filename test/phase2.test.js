const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Payment = require("../src/models/payment.model");
const Scheme = require("../src/models/scheme.model");
const PaymentCorrection = require("../src/models/paymentCorrection.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  CORRECTION_TYPES,
  SCHEME_STATUS,
} = require("../src/constants/enums");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const { collectPayment } = require("../src/services/payment.service");
const { createCashSubmission } = require("../src/services/cash.service");
const { createScheme, updateSchemeStatus } = require("../src/services/schemeManagement.service");
const {
  createCorrectionRequest,
  approveCorrection,
} = require("../src/services/correction.service");
const { createCustomer } = require("../src/services/customer.service");
const { FULL_OPERATIONAL_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");
const { runMigrations } = require("../src/migrations/runMigrations");
const { buildSourceSnapshot } = require("../src/utils/paymentLedger");
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
    name: "Phase2 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async () => {
  const staff = await User.create({
    name: "Phase2 Staff",
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
      name: "Phase2 Customer",
      phone: `7${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
      password: "customer1pass",
    },
    admin
  );
  const scheme = await createScheme(
    { customerId: customer._id.toString(), startDate: SCHEME_START, clientRequestId: reqId() },
    admin
  );
  return { customer, scheme };
};

const pay = async (customer, scheme, actor, amount, at = firstPeriodTime(), extras = {}) =>
  withMockedNow(at, () =>
    collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: extras.clientRequestId || reqId(),
      },
      actor
    )
  );

const expectApiError = async (promise, { statusCode, code }) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    if (code) assert.equal(error.code, code);
    return true;
  });
};

describe("phase 2 corrections and idempotency", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_phase2_${process.pid}` });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
  });

  after(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (replSet) await replSet.stop({ doCleanup: true, force: true });
  });

  it("EDIT_AMOUNT above later cap is rejected on approval", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 10000, firstPeriodTime());
    await pay(customer, scheme, staff, 5000, laterPeriodTime());
    const payment = await pay(customer, scheme, staff, 1000, laterPeriodTime());

    const correction = await createCorrectionRequest(
      payment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
        requestedValue: 7000,
        reason: "Increase beyond cap",
      },
      staff
    );

    await expectApiError(
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "approve" },
        admin
      ),
      { statusCode: 409, code: ERROR_CODES.PAYMENT_LIMIT_EXCEEDED }
    );
  });

  it("preserves original payment facts after approved amount correction", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 10000, firstPeriodTime());
    const payment = await pay(customer, scheme, staff, 3000, firstPeriodTime());
    const original = await Payment.findById(payment.payment._id);
    const originalSnapshot = buildSourceSnapshot(original);

    const correction = await createCorrectionRequest(
      payment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
        requestedValue: 5000,
        reason: "Fix amount",
      },
      staff
    );

    await approveCorrection(
      correction._id,
      { reviewClientRequestId: reqId(), reviewNotes: "approve" },
      admin
    );

    const stored = await Payment.findById(payment.payment._id);
    assert.equal(stored.amount, originalSnapshot.amount);
    assert.equal(stored.status, PAYMENT_STATUS.SUCCESS);

    const savedCorrection = await PaymentCorrection.findById(correction._id);
    assert.equal(savedCorrection.appliedSnapshot.amount, 5000);
  });

  it("same payment key retries successfully when effective date is server-assigned", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const clientRequestId = reqId();
    const when = firstPeriodTime();
    const payload = {
      customer: customer._id.toString(),
      scheme: scheme._id.toString(),
      amount: 5000,
      paymentMethod: PAYMENT_METHODS.CASH,
      clientRequestId,
    };
    const first = await withMockedNow(when, () => collectPayment(payload, staff));
    const second = await withMockedNow(new Date(when.getTime() + 60_000), () =>
      collectPayment(payload, staff)
    );
    assert.equal(String(first.payment._id), String(second.payment._id));
  });

  it("same cash-submission key retries without submission date in hash", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, staff, 7000, firstPeriodTime());
    const clientRequestId = reqId();
    const payload = {
      staff: staff._id.toString(),
      submittedAmount: 5000,
      clientRequestId,
    };
    const first = await createCashSubmission(payload, admin);
    const second = await createCashSubmission(payload, admin);
    assert.equal(String(first.submission._id), String(second.submission._id));
  });

  it("two concurrent active-scheme creates leave exactly one active scheme", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "Single Active Customer",
        phone: `7${String(Date.now()).slice(-8)}1`,
        password: "customer1pass",
      },
      admin
    );
    const sharedRequestId = reqId();
    const payload = {
      customerId: customer._id.toString(),
      startDate: SCHEME_START,
      clientRequestId: sharedRequestId,
    };

    const first = await createScheme(payload, admin);
    const second = await createScheme(payload, admin);
    assert.equal(String(first._id), String(second._id));
    assert.equal(await Scheme.countDocuments({ customer: customer._id, status: SCHEME_STATUS.ACTIVE }), 1);
  });

  it("migration is idempotent on clean database", async () => {
    const db = mongoose.connection.db;
    const first = await runMigrations(db);
    const second = await runMigrations(db);
    assert.ok(first.some((row) => row.id === "001_one_active_scheme_per_customer" && row.status === "applied"));
    assert.ok(second.every((row) => row.status === "skipped"));
  });

  it("reversal of first-period payment is rejected when later total would exceed cap", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const firstPayment = await pay(customer, scheme, staff, 10000, firstPeriodTime());
    await pay(customer, scheme, staff, 8000, laterPeriodTime());

    const correction = await createCorrectionRequest(
      firstPayment.payment._id,
      {
        correctionType: CORRECTION_TYPES.REVERSE_PAYMENT,
        reason: "Attempt invalid reversal",
      },
      staff
    );

    await expectApiError(
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "approve" },
        admin
      ),
      { statusCode: 409, code: ERROR_CODES.PAYMENT_LIMIT_EXCEEDED }
    );
  });

  it("correction after settlement is rejected", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 4000, firstPeriodTime());
    await updateSchemeStatus(
      scheme._id,
      {
        status: SCHEME_STATUS.REDEEMED,
        notes: "Settled",
        clientRequestId: reqId(),
        payoutMethod: PAYMENT_METHODS.UPI,
        payoutReference: "PAY-PHASE2-1",
      },
      admin
    );

    await assert.rejects(
      createCorrectionRequest(
        payment.payment._id,
        {
          correctionType: CORRECTION_TYPES.EDIT_REFERENCE,
          requestedValue: "REF-999",
          reason: "Too late",
        },
        staff
      ),
      (error) => error.statusCode === 409
    );
  });
});
