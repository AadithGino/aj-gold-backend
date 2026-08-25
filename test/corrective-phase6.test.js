const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const http = require("http");
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
  PAYMENT_STATUS,
} = require("../src/constants/enums");
const { collectPayment, listPayments, reversePayment } = require("../src/services/payment.service");
const { createCustomer, getCustomerDetail, updateCustomer } = require("../src/services/customer.service");
const { createScheme } = require("../src/services/schemeManagement.service");
const {
  createCorrectionRequest,
  approveCorrection,
  rejectCorrection,
} = require("../src/services/correction.service");
const { signAccessToken } = require("../src/services/auth.service");
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
const { buildReconciliationSummary } = require("../src/services/reconciliation.service");
const { calculateSchemeDates } = require("../src/services/scheme.service");
const { deriveSchemeWindow } = require("../src/utils/schemeWindow");
const { FULL_OPERATIONAL_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");
const { runMigrations } = require("../src/migrations/runMigrations");
const Payment = require("../src/models/payment.model");

const reqId = () => crypto.randomUUID();
const SCHEME_START = "2025-01-01";

let replSet;
let mockTimerDepth = 0;
let server;
let baseUrl;

const httpRequest = ({ method, path, token, body, headers = {} }) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

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
    process.env.CORS_ORIGINS = "https://admin.example.com";
    delete require.cache[require.resolve("../src/config/env")];
    delete require.cache[require.resolve("../src/app")];
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_cp6_${process.pid}` });
    const app = require("../src/app");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await runMigrations(mongoose.connection.db);
  });

  after(async () => {
    if (server?.closeAllConnections) {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
    delete require.cache[require.resolve("../src/app")];
    delete require.cache[require.resolve("../src/config/env")];
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

  it("method/date corrections drive totals while pending/rejected corrections have no effect", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin, "Corrective");
    const firstPayment = await pay(customer, scheme, staff, 2500, PAYMENT_METHODS.CASH);
    const secondPayment = await pay(customer, scheme, staff, 3200, PAYMENT_METHODS.UPI);

    const approvedMethod = await createCorrectionRequest(
      secondPayment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_METHOD,
        requestedValue: PAYMENT_METHODS.BANK,
        reason: "Bank transfer collected",
      },
      staff
    );
    await approveCorrection(
      approvedMethod._id,
      { reviewClientRequestId: reqId(), reviewNotes: "approved" },
      admin
    );

    const pendingAmount = await createCorrectionRequest(
      firstPayment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
        requestedValue: 9999,
        reason: "Pending should not apply",
      },
      staff
    );
    const rejectedAmount = await createCorrectionRequest(
      secondPayment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
        requestedValue: 1,
        reason: "Rejected should not apply",
      },
      staff
    );
    await rejectCorrection(
      rejectedAmount._id,
      { reviewClientRequestId: reqId(), reviewNotes: "reject" },
      admin
    );

    const [report, schemeLimit, customerLedger] = await Promise.all([
      getCollectionReport({}, admin),
      getSchemeLimitSummary(scheme._id),
      getCustomerLedger(customer._id, admin),
    ]);

    assert.equal(pendingAmount.status, "PENDING");
    assert.equal(report.totalCollection, 5700);
    assert.equal(report.methodTotals.CASH, 2500);
    assert.equal(report.methodTotals.UPI, 0);
    assert.equal(report.methodTotals.BANK, 3200);
    assert.equal(schemeLimit.totalPaid, 5700);
    assert.equal(customerLedger.totalPaid, 5700);

    const storedRaw = await Payment.findById(secondPayment.payment._id).lean();
    assert.equal(storedRaw.paymentMethod, PAYMENT_METHODS.UPI);
  });

  it("effective reversal contributes zero and does not double count", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin, "Reverse");
    const p1 = await pay(customer, scheme, staff, 2000, PAYMENT_METHODS.CASH);
    await pay(customer, scheme, staff, 1000, PAYMENT_METHODS.BANK);
    await reversePayment(
      p1.payment._id,
      { reason: "Wrong entry", notes: "phase6", clientRequestId: reqId() },
      admin
    );

    const [report, customerLedger, reconciliation] = await Promise.all([
      getCollectionReport({}, admin),
      getCustomerLedger(customer._id, admin),
      buildReconciliationSummary(),
    ]);
    assert.equal(report.totalCollection, 1000);
    assert.equal(report.successPaymentCount, 1);
    assert.equal(report.reversedPaymentCount, 1);
    assert.equal(customerLedger.totalPaid, 1000);
    assert.equal(reconciliation.flows.netCustomerCollected >= 1000, true);
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

    const customerSearch = await httpRequest({
      method: "GET",
      path: `/api/customers?search=${encodeURIComponent(" .*^$+?[(\\ ")}&limit=10`,
      token: signAccessToken(admin),
    });
    assert.equal(customerSearch.status, 200);

    const longSearch = await httpRequest({
      method: "GET",
      path: `/api/customers?search=${"A".repeat(300)}`,
      token: signAccessToken(admin),
    });
    assert.equal(longSearch.status, 400);
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

  it("malformed and cross-scope cursors are rejected", async () => {
    const admin = await createAdmin();
    const staffA = await createStaff("Cursor Staff A");
    const staffB = await createStaff("Cursor Staff B");
    const { customer, scheme } = await seedCustomerScheme(admin, "Cursor");
    await pay(customer, scheme, staffA, 1200);
    await pay(customer, scheme, staffA, 1400);
    await pay(customer, scheme, staffB, 1300);

    const staffPage = await listPayments({ limit: 1 }, staffA);
    const tampered = await listPayments(
      {
        limit: 1,
        cursor: "bad-cursor",
      },
      staffA
    ).catch((error) => error);
    assert.equal(tampered.statusCode, 400);

    const crossScope = await listPayments({ limit: 1, cursor: staffPage.pageInfo.nextCursor }, staffB).catch(
      (error) => error
    );
    assert.equal(crossScope.statusCode, 400);
  });

  it("staff cannot enumerate unrelated customer/scheme ledgers (IDOR guard)", async () => {
    const admin = await createAdmin();
    const staffA = await createStaff("IDOR A");
    const staffB = await createStaff("IDOR B");
    const first = await seedCustomerScheme(admin, "IDOR-1");
    const second = await seedCustomerScheme(admin, "IDOR-2");

    await pay(first.customer, first.scheme, staffA, 1100);
    await pay(second.customer, second.scheme, staffB, 2100);

    await assert.rejects(
      () => getCustomerLedger(second.customer._id, staffA),
      (error) => error.statusCode === 403
    );
    await assert.rejects(
      () => getSchemeLedger(second.scheme._id, staffA),
      (error) => error.statusCode === 403
    );
    const ownLedger = await getCustomerLedger(first.customer._id, staffA);
    assert.equal(ownLedger.totalPaid, 1100);
  });

  it("permission independence and removed routes remain enforced at runtime", async () => {
    const admin = await createAdmin();
    const creatorOnly = await createStaff("Creator Only");
    await StaffProfile.updateOne(
      { user: creatorOnly._id },
      { $set: { permissions: { canCreateCustomer: true, canCollectPayment: false, canViewReports: false } } }
    );
    const customer = await createCustomer(
      {
        name: "Phase6 Runtime Customer",
        phone: `7${String(Date.now()).slice(-8)}5`,
        password: "1234",
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: SCHEME_START, clientRequestId: reqId() },
      admin
    );
    const creatorToken = signAccessToken(creatorOnly);
    const adminToken = signAccessToken(admin);
    const customerUser = await User.findById(customer.user);
    const customerToken = signAccessToken(customerUser);

    const reportBlocked = await httpRequest({
      method: "GET",
      path: "/api/reports/collections",
      token: creatorToken,
    });
    assert.equal(reportBlocked.status, 403);

    const updateBlocked = await updateCustomer(customer._id, { nominee: { name: "Nope" } }, creatorOnly).catch(
      (error) => error
    );
    assert.equal(updateBlocked.statusCode, 403);

    const deletedRouteRes = await httpRequest({
      method: "POST",
      path: "/api/auth/mfa/complete-login",
      token: adminToken,
      body: {},
    });
    assert.equal(deletedRouteRes.status, 404);

    const accountDeletionRes = await httpRequest({
      method: "POST",
      path: "/api/account/deletion-requests",
      token: customerToken,
      body: {},
    });
    assert.equal(accountDeletionRes.status, 404);

    const customerPayBlocked = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token: customerToken,
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 1000,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: reqId(),
      },
    });
    assert.equal(customerPayBlocked.status, 403);
  });

  it("cors and no-store protections remain intact", async () => {
    const admin = await createAdmin();
    const token = signAccessToken(admin);
    const noOrigin = await httpRequest({
      method: "GET",
      path: "/api/reports/collections",
      token,
    });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers["cache-control"], "no-store");

    const allowlisted = await httpRequest({
      method: "GET",
      path: "/api/reports/collections",
      token,
      headers: { Origin: "https://admin.example.com" },
    });
    assert.equal(allowlisted.status, 200);

    const blocked = await httpRequest({
      method: "GET",
      path: "/api/reports/collections",
      token,
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(blocked.status, 403);
    assert.notEqual(blocked.status, 500);
  });

  it("equal timestamps paginate deterministically and without omissions", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin, "Tie");
    const sameTime = firstPeriodTime();
    for (let i = 0; i < 6; i += 1) {
      await pay(customer, scheme, staff, 1000 + i, PAYMENT_METHODS.CASH, sameTime);
    }

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 4; page += 1) {
      const result = await listPayments({ limit: 2, cursor }, admin);
      seen.push(...result.items.map((row) => String(row._id)));
      cursor = result.pageInfo.nextCursor;
      if (!cursor) break;
    }
    const canonical = await Payment.find({ status: PAYMENT_STATUS.SUCCESS, scheme: scheme._id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(
      seen,
      canonical.map((row) => String(row._id))
    );
  });
});
