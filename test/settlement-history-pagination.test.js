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
const {
  USER_ROLES,
  PAYMENT_METHODS,
  SCHEME_STATUS,
  CORRECTION_TYPES,
} = require("../src/constants/enums");
const { collectPayment } = require("../src/services/payment.service");
const { createCustomer } = require("../src/services/customer.service");
const { createScheme, updateSchemeStatus } = require("../src/services/schemeManagement.service");
const {
  createCorrectionRequest,
} = require("../src/services/correction.service");
const { signAccessToken } = require("../src/services/auth.service");
const { calculateSchemeDates } = require("../src/services/scheme.service");
const { deriveSchemeWindow } = require("../src/utils/schemeWindow");
const { SETTLEMENT_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");
const { runMigrations } = require("../src/migrations/runMigrations");

const reqId = () => crypto.randomUUID();
const SCHEME_START = "2025-01-01";

let replSet;
let mockTimerDepth = 0;
let server;
let baseUrl;

const httpRequest = ({ method, path, token, body }) =>
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
          resolve({ status: res.statusCode, body: json });
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

const afterMaturity = () => {
  const window = deriveSchemeWindow(calculateSchemeDates(SCHEME_START));
  return new Date(window.maturityDate.getTime() + 24 * 60 * 60 * 1000);
};

const createAdmin = async () =>
  User.create({
    name: "History Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async (label = "History Staff") => {
  const staff = await User.create({
    name: label,
    phone: `8${String(crypto.randomUUID()).replace(/\D/g, "").slice(-9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });
  await StaffProfile.create({
    user: staff._id,
    permissions: SETTLEMENT_STAFF_PERMISSIONS,
  });
  return staff;
};

const seedCustomerScheme = async (admin, label = "Hist") => {
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
  const customerUser = await User.findById(customer.user);
  return { customer, scheme, customerUser };
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

const settle = (schemeId, actor, extras = {}) =>
  updateSchemeStatus(
    schemeId,
    {
      status: extras.status || SCHEME_STATUS.REDEEMED,
      notes: extras.notes || "Settled",
      clientRequestId: extras.clientRequestId || reqId(),
      payoutMethod: extras.payoutMethod || PAYMENT_METHODS.UPI,
      ...(extras.payoutMethod === PAYMENT_METHODS.CASH
        ? {}
        : { payoutReference: extras.payoutReference || `PAY-${reqId().slice(0, 8)}` }),
    },
    actor
  );

const walkPages = async ({ path, token, extra = "" }) => {
  const items = [];
  let cursor = null;
  for (let i = 0; i < 20; i += 1) {
    const qs = new URLSearchParams({ limit: "2", ...Object.fromEntries(new URLSearchParams(extra)) });
    if (cursor) qs.set("cursor", cursor);
    const response = await httpRequest({ method: "GET", path: `${path}?${qs}`, token });
    assert.equal(response.status, 200);
    const pageItems = response.body.data.items;
    items.push(...pageItems);
    if (!response.body.pageInfo.hasMore) {
      return { items, last: response.body };
    }
    cursor = response.body.pageInfo.nextCursor;
    assert.ok(cursor);
  }
  throw new Error("pagination did not terminate");
};

describe("Phase 2 — canonical settlement and financial history APIs", () => {
  before(async () => {
    process.env.CORS_ORIGINS = "https://admin.example.com";
    delete require.cache[require.resolve("../src/config/env")];
    delete require.cache[require.resolve("../src/app")];
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_hist_${process.pid}` });
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

  it("customer sees own REDEEMED and CLOSED history with stored principal amount", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const first = await seedCustomerScheme(admin, "OwnA");
    const second = await seedCustomerScheme(admin, "OwnB");

    await pay(first.customer, first.scheme, staff, 4000);
    await pay(second.customer, second.scheme, staff, 2500);

    await withMockedNow(firstPeriodTime(), () =>
      settle(second.scheme._id, staff, {
        status: SCHEME_STATUS.CLOSED,
        notes: "Early close note",
        payoutMethod: PAYMENT_METHODS.CASH,
      })
    );
    await withMockedNow(afterMaturity(), () =>
      settle(first.scheme._id, admin, {
        status: SCHEME_STATUS.REDEEMED,
        notes: "Matured",
        payoutMethod: PAYMENT_METHODS.BANK,
        payoutReference: "BANK-REF-1",
      })
    );

    const token = signAccessToken(first.customerUser);
    const otherToken = signAccessToken(second.customerUser);
    const own = await httpRequest({
      method: "GET",
      path: "/api/dashboard/customer/redemptions?limit=20",
      token,
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.data.items.length, 1);
    const row = own.body.data.items[0];
    assert.equal(row.status, SCHEME_STATUS.REDEEMED);
    assert.equal(row.amount, 4000);
    assert.equal(row.payoutMethod, PAYMENT_METHODS.BANK);
    assert.equal(row.payoutReference, "BANK-REF-1");
    assert.equal(row.settlementCategory, "maturity");
    assert.ok(row.settlementReceiptId);
    assert.equal(row.customer, undefined);
    assert.equal(own.body.data.summary.totalAmount, 4000);
    assert.ok(own.body.pageInfo);

    const closed = await httpRequest({
      method: "GET",
      path: "/api/dashboard/customer/redemptions?limit=20",
      token: otherToken,
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.data.items[0].status, SCHEME_STATUS.CLOSED);
    assert.equal(closed.body.data.items[0].amount, 2500);
    assert.equal(closed.body.data.items[0].settlementCategory, "early_closure");
    assert.equal(closed.body.data.items[0].notes, "Early close note");
    assert.equal(closed.body.data.items[0].payoutReference, undefined);
  });

  it("customer cannot access another customer and staff cannot probe arbitrary history", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const first = await seedCustomerScheme(admin, "IDOR-A");
    const second = await seedCustomerScheme(admin, "IDOR-B");
    await pay(first.customer, first.scheme, staff, 1500);
    await withMockedNow(afterMaturity(), () => settle(first.scheme._id, admin));

    const customerToken = signAccessToken(second.customerUser);
    const staffToken = signAccessToken(staff);
    const adminToken = signAccessToken(admin);

    const asOtherCustomer = await httpRequest({
      method: "GET",
      path: `/api/customers/${first.customer._id}/redemptions`,
      token: customerToken,
    });
    assert.equal(asOtherCustomer.status, 403);

    const asStaff = await httpRequest({
      method: "GET",
      path: `/api/customers/${first.customer._id}/redemptions`,
      token: staffToken,
    });
    assert.equal(asStaff.status, 403);

    const asAdmin = await httpRequest({
      method: "GET",
      path: `/api/customers/${first.customer._id}/redemptions`,
      token: adminToken,
    });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.data.items[0].amount, 1500);
    assert.ok(asAdmin.body.data.items[0].customer);
    assert.equal(asAdmin.body.data.items[0].customer.name, first.customer.name);
  });

  it("staff own activity contains both terminal settlement types", async () => {
    const admin = await createAdmin();
    const staff = await createStaff("Closer");
    const first = await seedCustomerScheme(admin, "StaffA");
    const second = await seedCustomerScheme(admin, "StaffB");
    await pay(first.customer, first.scheme, staff, 3000);
    await pay(second.customer, second.scheme, staff, 1800);
    await withMockedNow(firstPeriodTime(), () =>
      settle(second.scheme._id, staff, { status: SCHEME_STATUS.CLOSED, payoutMethod: PAYMENT_METHODS.CASH })
    );
    await withMockedNow(afterMaturity(), () =>
      settle(first.scheme._id, staff, { status: SCHEME_STATUS.REDEEMED, payoutMethod: PAYMENT_METHODS.UPI })
    );

    const response = await httpRequest({
      method: "GET",
      path: "/api/dashboard/staff/redemptions?limit=20",
      token: signAccessToken(staff),
    });
    assert.equal(response.status, 200);
    const statuses = response.body.data.items.map((row) => row.status).sort();
    assert.deepEqual(statuses, [SCHEME_STATUS.CLOSED, SCHEME_STATUS.REDEEMED].sort());
    assert.equal(response.body.data.summary.count, 2);
    assert.equal(response.body.data.summary.totalAmount, 4800);
  });

  const addSettledScheme = async (admin, staff, customer, amount, extras = {}) => {
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: SCHEME_START, clientRequestId: reqId() },
      admin
    );
    await pay(customer, scheme, staff, amount);
    await withMockedNow(extras.at || afterMaturity(), () =>
      settle(scheme._id, extras.actor || admin, extras)
    );
    return scheme;
  };

  it("pages completely, rejects cross-scope cursors, and binds date filters", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const first = await seedCustomerScheme(admin, "PageA");
    const second = await seedCustomerScheme(admin, "PageB");
    await pay(first.customer, first.scheme, staff, 1000);
    await withMockedNow(afterMaturity(), () => settle(first.scheme._id, staff));
    await addSettledScheme(admin, staff, first.customer, 1100, { actor: staff });
    await addSettledScheme(admin, staff, first.customer, 1200, { actor: staff });
    await addSettledScheme(admin, staff, first.customer, 1300, { actor: staff });
    await pay(second.customer, second.scheme, staff, 1400);
    await withMockedNow(afterMaturity(), () => settle(second.scheme._id, staff));
    const otherStaff = await createStaff("OtherCloser");

    const adminToken = signAccessToken(admin);
    const staffToken = signAccessToken(staff);
    const customerToken = signAccessToken(first.customerUser);

    const customerPages = await walkPages({
      path: "/api/dashboard/customer/redemptions",
      token: customerToken,
    });
    assert.equal(customerPages.items.length, 4);
    assert.equal(new Set(customerPages.items.map((row) => String(row._id))).size, 4);
    assert.equal(customerPages.last.data.summary.count, 4);
    assert.equal(customerPages.last.data.summary.totalAmount, 4600);

    const adminCustomerPages = await walkPages({
      path: `/api/customers/${first.customer._id}/redemptions`,
      token: adminToken,
    });
    assert.equal(adminCustomerPages.items.length, 4);

    const firstPage = await httpRequest({
      method: "GET",
      path: `/api/customers/${first.customer._id}/redemptions?limit=1`,
      token: adminToken,
    });
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.pageInfo.hasMore, true);
    assert.ok(firstPage.body.pageInfo.nextCursor);

    const otherCustomer = await httpRequest({
      method: "GET",
      path: `/api/customers/${second.customer._id}/redemptions?limit=1&cursor=${encodeURIComponent(
        firstPage.body.pageInfo.nextCursor
      )}`,
      token: adminToken,
    });
    assert.equal(otherCustomer.status, 400);

    const staffWithCustomerCursor = await httpRequest({
      method: "GET",
      path: `/api/dashboard/staff/redemptions?limit=1&cursor=${encodeURIComponent(
        firstPage.body.pageInfo.nextCursor
      )}`,
      token: staffToken,
    });
    assert.equal(staffWithCustomerCursor.status, 400);

    const staffList = await httpRequest({
      method: "GET",
      path: "/api/dashboard/staff/redemptions?limit=2",
      token: staffToken,
    });
    assert.equal(staffList.status, 200);
    assert.equal(staffList.body.data.items.length, 2);
    assert.equal(staffList.body.pageInfo.hasMore, true);

    const staffWalk = await walkPages({
      path: "/api/dashboard/staff/redemptions",
      token: staffToken,
    });
    assert.equal(staffWalk.items.length, 5);
    assert.equal(new Set(staffWalk.items.map((row) => String(row._id))).size, 5);

    const adminAll = await httpRequest({
      method: "GET",
      path: `/api/admin/staff/${staff._id}/redeemed-closed-history?limit=2`,
      token: adminToken,
    });
    assert.equal(adminAll.status, 200);
    assert.equal(adminAll.body.data.items.length, 2);
    assert.equal(adminAll.body.pageInfo.hasMore, true);

    const secondPage = await httpRequest({
      method: "GET",
      path: `/api/admin/staff/${staff._id}/redeemed-closed-history?limit=2&cursor=${encodeURIComponent(
        adminAll.body.pageInfo.nextCursor
      )}`,
      token: adminToken,
    });
    assert.equal(secondPage.status, 200);
    const ids = [...adminAll.body.data.items, ...secondPage.body.data.items].map((row) => String(row._id));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 4);

    const crossStaff = await httpRequest({
      method: "GET",
      path: `/api/admin/staff/${otherStaff._id}/redeemed-closed-history?limit=2&cursor=${encodeURIComponent(
        adminAll.body.pageInfo.nextCursor
      )}`,
      token: adminToken,
    });
    assert.equal(crossStaff.status, 400);

    const malformed = await httpRequest({
      method: "GET",
      path: `/api/customers/${first.customer._id}/redemptions?cursor=not-a-cursor`,
      token: adminToken,
    });
    assert.equal(malformed.status, 400);

    const dated = await httpRequest({
      method: "GET",
      path: `/api/customers/${first.customer._id}/redemptions?limit=1&from=2020-01-01&to=2035-01-01`,
      token: adminToken,
    });
    assert.equal(dated.status, 200);
    assert.ok(dated.body.pageInfo.nextCursor);
    const rebound = await httpRequest({
      method: "GET",
      path: `/api/customers/${first.customer._id}/redemptions?limit=1&cursor=${encodeURIComponent(
        dated.body.pageInfo.nextCursor
      )}`,
      token: adminToken,
    });
    assert.equal(rebound.status, 400);

    const leak = await httpRequest({
      method: "GET",
      path: `/api/dashboard/customer/redemptions?customerId=${second.customer._id}&limit=20`,
      token: customerToken,
    });
    assert.equal(leak.status, 200);
    assert.equal(leak.body.data.items.length, 4);
    assert.equal(
      leak.body.data.items.every((row) => !row.customer),
      true
    );
  });

  it("equal settlement timestamps paginate without duplicates or omissions", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const when = afterMaturity();
    const rows = [];
    for (let i = 0; i < 4; i += 1) {
      const seeded = await seedCustomerScheme(admin, `Eq${i}`);
      await pay(seeded.customer, seeded.scheme, staff, 1100);
      await withMockedNow(when, () => settle(seeded.scheme._id, staff));
      rows.push(seeded);
    }

    const token = signAccessToken(staff);
    const { items } = await walkPages({
      path: "/api/dashboard/staff/redemptions",
      token,
    });
    assert.equal(items.length, 4);
    assert.equal(new Set(items.map((row) => String(row._id))).size, 4);
  });

  it("more than 100 customer receipts and later correction pages remain retrievable", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const seeded = await seedCustomerScheme(admin, "Receipts");
    for (let i = 0; i < 101; i += 1) {
      await pay(seeded.customer, seeded.scheme, staff, 100 + (i % 50), PAYMENT_METHODS.CASH, firstPeriodTime());
    }

    const token = signAccessToken(seeded.customerUser);
    const collected = [];
    let cursor = null;
    for (let i = 0; i < 10; i += 1) {
      const qs = new URLSearchParams({ limit: "30" });
      if (cursor) qs.set("cursor", cursor);
      const response = await httpRequest({
        method: "GET",
        path: `/api/dashboard/customer/payments?${qs}`,
        token,
      });
      assert.equal(response.status, 200);
      collected.push(...response.body.data.items);
      if (!response.body.pageInfo.hasMore) break;
      cursor = response.body.pageInfo.nextCursor;
    }
    assert.equal(collected.length, 101);

    const payments = [];
    for (let i = 0; i < 3; i += 1) {
      const extra = await seedCustomerScheme(admin, `Corr${i}`);
      payments.push(await pay(extra.customer, extra.scheme, staff, 500 + i));
    }
    for (const payment of payments) {
      await createCorrectionRequest(
        payment.payment._id,
        { correctionType: CORRECTION_TYPES.EDIT_AMOUNT, requestedValue: 900, reason: "Fix later page" },
        staff
      );
    }

    const first = await httpRequest({
      method: "GET",
      path: "/api/corrections?limit=1&status=PENDING",
      token: signAccessToken(admin),
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.items.length, 1);
    assert.equal(first.body.pageInfo.hasMore, true);
    const next = await httpRequest({
      method: "GET",
      path: `/api/corrections?limit=1&status=PENDING&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`,
      token: signAccessToken(admin),
    });
    assert.equal(next.status, 200);
    assert.equal(next.body.data.items.length, 1);
    assert.notEqual(String(next.body.data.items[0]._id), String(first.body.data.items[0]._id));
  });

  it("settlement history indexes are used for customer and staff queries", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const seeded = await seedCustomerScheme(admin, "Idx");
    await pay(seeded.customer, seeded.scheme, staff, 2000);
    await withMockedNow(afterMaturity(), () => settle(seeded.scheme._id, staff));

    const schemes = mongoose.connection.db.collection("schemes");
    const customerPlan = await schemes
      .find({
        customer: seeded.customer._id,
        status: { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] },
      })
      .sort({ "settlement.settledAt": -1, _id: -1 })
      .explain("queryPlanner");
    const staffPlan = await schemes
      .find({
        "settlement.settledBy": staff._id,
        status: { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] },
      })
      .sort({ "settlement.settledAt": -1, _id: -1 })
      .explain("queryPlanner");

    const indexes = await schemes.indexes();
    assert.ok(indexes.some((index) => index.name === "schemes_customer_terminal_settledAt"));
    assert.ok(indexes.some((index) => index.name === "schemes_settledBy_terminal_settledAt"));

    const hintedCustomer = await schemes
      .find({
        customer: seeded.customer._id,
        status: { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] },
      })
      .sort({ "settlement.settledAt": -1, _id: -1 })
      .hint("schemes_customer_terminal_settledAt")
      .explain("queryPlanner");
    const hintedStaff = await schemes
      .find({
        "settlement.settledBy": staff._id,
        status: { $in: [SCHEME_STATUS.REDEEMED, SCHEME_STATUS.CLOSED] },
      })
      .sort({ "settlement.settledAt": -1, _id: -1 })
      .hint("schemes_settledBy_terminal_settledAt")
      .explain("queryPlanner");

    const customerPlanText = JSON.stringify(hintedCustomer);
    const staffPlanText = JSON.stringify(hintedStaff);
    assert.equal(customerPlanText.includes("COLLSCAN"), false);
    assert.equal(staffPlanText.includes("COLLSCAN"), false);
    assert.equal(customerPlanText.includes("IXSCAN"), true);
    assert.equal(staffPlanText.includes("IXSCAN"), true);
    assert.ok(JSON.stringify(customerPlan));
    assert.ok(JSON.stringify(staffPlan));
  });
});
