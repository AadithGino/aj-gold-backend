const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
require("../src/models/scheme.model");
require("../src/models/payment.model");
require("../src/models/customer.model");
require("../src/models/financialJournal.model");
require("../src/models/paymentCorrection.model");
require("../src/models/cashSubmission.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  CORRECTION_TYPES,
} = require("../src/constants/enums");
const { collectPayment, listPayments } = require("../src/services/payment.service");
const { createCustomer, getCustomerDetail } = require("../src/services/customer.service");
const { createScheme } = require("../src/services/schemeManagement.service");
const {
  createCorrectionRequest,
  approveCorrection,
} = require("../src/services/correction.service");
const { getReceiptDisplayData } = require("../src/services/cash.service");
const {
  getCollectionReport,
  getSchemeReport,
  getCustomerLedger,
  getSchemeLedger,
  getStaffPerformanceReport,
} = require("../src/services/report.service");
const { getSchemeLimitSummary } = require("../src/services/paymentLimit.service");
const { listStaff } = require("../src/services/staff.service");
const { calculateSchemeDates } = require("../src/services/scheme.service");
const { deriveSchemeWindow } = require("../src/utils/schemeWindow");
const { FULL_OPERATIONAL_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");
const { runMigrations } = require("../src/migrations/runMigrations");

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

const createAdmin = async () =>
  User.create({
    name: "CP6 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async (label = "CP6 Staff", uniqueSeed = crypto.randomUUID()) => {
  const staff = await User.create({
    name: label,
    phone: `8${String(uniqueSeed).replace(/\D/g, "").slice(-9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });
  await StaffProfile.create({
    user: staff._id,
    permissions: FULL_OPERATIONAL_STAFF_PERMISSIONS,
  });
  return staff;
};

const seedCustomerScheme = async (admin, label = "CP6") => {
  const customer = await createCustomer(
    {
      name: `${label} Customer`,
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

describe("Corrective Phase 6 — read-model consistency, pagination, safe search", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_cp6_${process.pid}` });
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

  it("approved amount correction yields identical effective totals across read surfaces", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 3000);
    const paymentId = paymentResult.payment._id;

    const correction = await createCorrectionRequest(
      paymentId,
      { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 5000, reason: "Fix amount" },
      staff
    );
    await approveCorrection(
      correction._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    const expectedTotal = 5000;
    const [
      receipt,
      schemeLimit,
      collectionReport,
      customerDetail,
      customerLedger,
      schemeLedger,
      listPage,
    ] = await Promise.all([
      getReceiptDisplayData(paymentId),
      getSchemeLimitSummary(scheme._id),
      getCollectionReport({}, admin),
      getCustomerDetail(customer._id, admin),
      getCustomerLedger(customer._id, admin),
      getSchemeLedger(scheme._id),
      listPayments({}, admin),
    ]);

    assert.equal(receipt.amount, expectedTotal);
    assert.equal(receipt.totalPaidTillNow, expectedTotal);
    assert.equal(schemeLimit.totalPaid, expectedTotal);
    assert.equal(collectionReport.totalCollection, expectedTotal);
    assert.equal(customerDetail.activeScheme.totalPaid, expectedTotal);
    assert.equal(customerLedger.totalPaid, expectedTotal);
    assert.equal(schemeLedger.totalPaid, expectedTotal);
    assert.equal(customerLedger.receipts[0].amount, expectedTotal);
    assert.equal(listPage.items[0].amount, expectedTotal);
  });

  it("staff collection report is scoped to the acting staff member", async () => {
    const admin = await createAdmin();
    const staffA = await createStaff("Staff A");
    const staffB = await createStaff("Staff B");
    const { customer, scheme } = await seedCustomerScheme(admin);

    await pay(customer, scheme, staffA, 2000);
    await pay(customer, scheme, staffB, 4000);

    const staffReport = await getCollectionReport({}, staffA);
    assert.equal(staffReport.totalCollection, 2000);
    assert.equal(staffReport.payments.length, 1);
    assert.equal(String(staffReport.payments[0].collectedBy._id), String(staffA._id));
  });

  it("cursor pagination returns stable pages without duplicates", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);

    for (let index = 0; index < 5; index += 1) {
      await pay(
        customer,
        scheme,
        staff,
        1000 + index,
        PAYMENT_METHODS.CASH,
        new Date(firstPeriodTime().getTime() + index * 60 * 60 * 1000)
      );
    }

    const firstPage = await listPayments({ limit: 2 }, admin);
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.pageInfo.hasMore, true);
    assert.ok(firstPage.pageInfo.nextCursor);

    const secondPage = await listPayments(
      { limit: 2, cursor: firstPage.pageInfo.nextCursor },
      admin
    );
    assert.equal(secondPage.items.length, 2);

    const ids = [...firstPage.items, ...secondPage.items].map((row) => String(row._id));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("safe search treats regex metacharacters as literal data", async () => {
    const admin = await createAdmin();
    await createCustomer(
      {
        name: "Regex Meta Customer",
        phone: `7special${String(Date.now()).slice(-4)}`,
        password: "1234",
      },
      admin
    );

    const report = await getSchemeReport({ search: "(special)" });
    assert.equal(report.items.length, 0);

    await createStaff("Meta.Staff+");
    const staffPage = await listStaff({ search: "Meta.Staff+" });
    assert.equal(staffPage.items.length, 1);
  });

  it("collection report exposes pageInfo instead of silent truncation", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);

    for (let index = 0; index < 4; index += 1) {
      await pay(customer, scheme, staff, 1000);
    }

    const report = await getCollectionReport({ limit: 2 }, admin);
    assert.equal(report.payments.length, 2);
    assert.equal(report.pageInfo.limit, 2);
    assert.equal(report.pageInfo.hasMore, true);
    assert.ok(report.pageInfo.nextCursor);
  });

  it("staff performance report uses batched effective aggregation", async () => {
    const admin = await createAdmin();
    const staffUsers = [];
    for (let index = 0; index < 6; index += 1) {
      staffUsers.push(await createStaff(`Perf Staff ${index}`, `${reqId()}-${index}`));
    }
    const { customer, scheme } = await seedCustomerScheme(admin);

    for (const staff of staffUsers) {
      await pay(customer, scheme, staff, 1500);
    }

    let queryCount = 0;
    const originalExec = mongoose.Query.prototype.exec;
    mongoose.Query.prototype.exec = function patchedExec(...args) {
      queryCount += 1;
      return originalExec.apply(this, args);
    };

    try {
      const report = await getStaffPerformanceReport({});
      assert.equal(report.staff.length, staffUsers.length);
      assert.ok(
        queryCount < staffUsers.length * 4,
        `expected batched queries, saw ${queryCount}`
      );
    } finally {
      mongoose.Query.prototype.exec = originalExec;
    }
  });
});
