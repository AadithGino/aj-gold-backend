const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

require("../src/models/scheme.model");
require("../src/models/payment.model");
require("../src/models/customer.model");
require("../src/models/financialJournal.model");
require("../src/models/idempotencyRecord.model");
require("../src/models/loginAttempt.model");
require("../src/models/cashSubmission.model");
require("../src/models/paymentCorrection.model");
const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Notification = require("../src/models/notification.model");
const { USER_ROLES, PAYMENT_METHODS } = require("../src/constants/enums");
const { createCustomer } = require("../src/services/customer.service");
const { createScheme } = require("../src/services/schemeManagement.service");
const { collectPayment } = require("../src/services/payment.service");
const { signAccessToken } = require("../src/services/auth.service");
const { runMigrations } = require("../src/migrations/runMigrations");

const reqId = () => crypto.randomUUID();
const SCHEME_START = "2026-08-01";

let replSet;
let server;
let baseUrl;
let app;

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
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const createAdmin = async () =>
  User.create({
    name: "P3 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaffWithPermissions = async (permissions) => {
  const staff = await User.create({
    name: "P3 Staff",
    phone: `8${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });
  await StaffProfile.create({ user: staff._id, permissions });
  return staff;
};

describe("Phase 3 — collection references and fail-closed permissions", () => {
  before(async () => {
    process.env.CORS_ORIGINS = "https://admin.example.com";
    delete require.cache[require.resolve("../src/config/env")];
    delete require.cache[require.resolve("../src/app")];

    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_p3_${process.pid}`,
    });

    app = require("../src/app");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await Promise.all(
      mongoose.modelNames().map((name) =>
        mongoose
          .model(name)
          .createCollection()
          .catch(() => {}),
      ),
    );
    await runMigrations(mongoose.connection.db);
    await Promise.all(
      [Notification, StaffProfile].map((model) => model.syncIndexes()),
    );
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
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

  it("staff with canCreateCustomer can search customers without financial history", async () => {
    const admin = await createAdmin();
    const staff = await createStaffWithPermissions({ canCreateCustomer: true });
    const customer = await createCustomer(
      {
        name: "P3 Create Lookup",
        phone: `7${String(Date.now()).slice(-8)}1`,
        password: "1234",
        nominee: { name: "Hidden", phone: "9999999999" },
      },
      admin,
    );

    const token = signAccessToken(staff);
    const search = await httpRequest({
      method: "GET",
      path: `/api/customers?search=${customer.passbookNumber}`,
      token,
    });
    assert.equal(search.status, 200);
    const item = search.body.data.items[0];
    assert.equal(item.name, customer.name);
    assert.equal(item.nominee, undefined);
    assert.equal(item.address, undefined);
    assert.equal(item.paymentHistory, undefined);

    const detail = await httpRequest({
      method: "GET",
      path: `/api/customers/${customer._id}`,
      token,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.paymentHistory, undefined);
    assert.equal(detail.body.data.nominee, undefined);
    assert.equal(detail.body.data.customer.address, undefined);
  });

  it("staff with only canCreateCustomer cannot collect payments or view reports", async () => {
    const admin = await createAdmin();
    const staff = await createStaffWithPermissions({ canCreateCustomer: true });
    const customer = await createCustomer(
      {
        name: "P3 Creator Pay Block",
        phone: `7${String(Date.now()).slice(-8)}2`,
        password: "1234",
      },
      admin,
    );
    const scheme = await createScheme(
      {
        customerId: customer._id.toString(),
        startDate: SCHEME_START,
        clientRequestId: reqId(),
      },
      admin,
    );
    const token = signAccessToken(staff);

    const pay = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token,
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 1000,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: reqId(),
      },
    });
    assert.equal(pay.status, 403);

    const reports = await httpRequest({
      method: "GET",
      path: "/api/reports/collections",
      token,
    });
    assert.equal(reports.status, 403);

    const cash = await httpRequest({
      method: "GET",
      path: "/api/dashboard/staff/cash-submissions",
      token,
    });
    assert.equal(cash.status, 403);
  });

  it("staff without each permission cannot invoke its API; granted staff can", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "P3 Matrix Customer",
        phone: `7${String(Date.now()).slice(-8)}3`,
        password: "1234",
      },
      admin,
    );
    const scheme = await createScheme(
      {
        customerId: customer._id.toString(),
        startDate: SCHEME_START,
        clientRequestId: reqId(),
      },
      admin,
    );

    const collectStaff = await createStaffWithPermissions({
      canCollectPayment: true,
    });
    const deniedCollect = await createStaffWithPermissions({
      canCreateCustomer: true,
    });
    const reportStaff = await createStaffWithPermissions({
      canViewReports: true,
    });
    const cashStaff = await createStaffWithPermissions({ canSubmitCash: true });
    const createStaff = await createStaffWithPermissions({
      canCreateCustomer: true,
    });

    const deniedPay = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token: signAccessToken(deniedCollect),
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 500,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: reqId(),
      },
    });
    assert.equal(deniedPay.status, 403);

    const allowedPay = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token: signAccessToken(collectStaff),
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 500,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: reqId(),
      },
    });
    assert.equal(allowedPay.status, 201);

    const deniedReport = await httpRequest({
      method: "GET",
      path: "/api/reports/collections",
      token: signAccessToken(collectStaff),
    });
    assert.equal(deniedReport.status, 403);

    const allowedReport = await httpRequest({
      method: "GET",
      path: "/api/reports/collections",
      token: signAccessToken(reportStaff),
    });
    assert.equal(allowedReport.status, 200);

    const deniedCash = await httpRequest({
      method: "GET",
      path: "/api/dashboard/staff/cash-submissions",
      token: signAccessToken(collectStaff),
    });
    assert.equal(deniedCash.status, 403);

    const allowedCash = await httpRequest({
      method: "GET",
      path: "/api/dashboard/staff/cash-submissions",
      token: signAccessToken(cashStaff),
    });
    assert.equal(allowedCash.status, 200);

    const createCustomerRes = await httpRequest({
      method: "POST",
      path: "/api/customers",
      token: signAccessToken(createStaff),
      body: {
        name: "P3 Created By Staff",
        phone: `7${String(Date.now()).slice(-8)}4`,
      },
    });
    assert.equal(createCustomerRes.status, 201);

    const deniedCreate = await httpRequest({
      method: "POST",
      path: "/api/customers",
      token: signAccessToken(collectStaff),
      body: {
        name: "P3 Denied Create",
        phone: `7${String(Date.now()).slice(-8)}5`,
      },
    });
    assert.equal(deniedCreate.status, 403);
  });

  it("non-cash collection allows optional transactionReference; payout reference stays optional", async () => {
    const admin = await createAdmin();
    const staff = await createStaffWithPermissions({ canCollectPayment: true });
    const customer = await createCustomer(
      {
        name: "P3 Ref Customer",
        phone: `7${String(Date.now()).slice(-8)}6`,
        password: "1234",
      },
      admin,
    );
    const scheme = await createScheme(
      {
        customerId: customer._id.toString(),
        startDate: SCHEME_START,
        clientRequestId: reqId(),
      },
      admin,
    );
    const token = signAccessToken(staff);

    const missingRef = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token,
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 700,
        paymentMethod: PAYMENT_METHODS.UPI,
        clientRequestId: reqId(),
      },
    });
    assert.equal(missingRef.status, 201);

    const withRef = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token,
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 700,
        paymentMethod: PAYMENT_METHODS.UPI,
        transactionReference: "UPI-REF-1",
        clientRequestId: reqId(),
      },
    });
    assert.equal(withRef.status, 201);

    const cash = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token,
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 800,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: reqId(),
      },
    });
    assert.equal(cash.status, 201);

    const settleStaff = await createStaffWithPermissions({
      canFinalizeSettlement: true,
      canMarkRedeemed: true,
      canMarkClosed: true,
    });
    await collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 900,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: reqId(),
      },
      admin,
    );

    const closeWithoutPayoutRef = await httpRequest({
      method: "PATCH",
      path: `/api/schemes/${scheme._id}/status`,
      token: signAccessToken(settleStaff),
      body: {
        status: "CLOSED",
        payoutMethod: PAYMENT_METHODS.UPI,
        clientRequestId: reqId(),
      },
    });
    assert.equal(closeWithoutPayoutRef.status, 200);
  });

  it("customer payment creation remains denied", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "P3 Customer Role",
        phone: `7${String(Date.now()).slice(-8)}7`,
        password: "1234",
      },
      admin,
    );
    const scheme = await createScheme(
      {
        customerId: customer._id.toString(),
        startDate: SCHEME_START,
        clientRequestId: reqId(),
      },
      admin,
    );
    const customerUser = await User.findById(customer.user);
    const response = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token: signAccessToken(customerUser),
      body: {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 1000,
        paymentMethod: PAYMENT_METHODS.CASH,
        clientRequestId: reqId(),
      },
    });
    assert.equal(response.status, 403);
  });

  it("collection payload exposes backend eligibility flags without payment history", async () => {
    const admin = await createAdmin();
    const staff = await createStaffWithPermissions({ canCollectPayment: true });
    const customer = await createCustomer(
      {
        name: "P3 Eligibility",
        phone: `7${String(Date.now()).slice(-8)}8`,
        password: "1234",
      },
      admin,
    );
    await createScheme(
      {
        customerId: customer._id.toString(),
        startDate: SCHEME_START,
        clientRequestId: reqId(),
      },
      admin,
    );
    const token = signAccessToken(staff);
    const res = await httpRequest({
      method: "GET",
      path: `/api/customers?search=${customer.passbookNumber}`,
      token,
    });
    assert.equal(res.status, 200);
    const scheme = res.body.data.items[0].activeScheme;
    assert.equal(typeof scheme.inFirstSixMonths, "boolean");
    assert.equal(typeof scheme.isMatured, "boolean");
    assert.equal(typeof scheme.limitFullyUsed, "boolean");
    assert.equal(scheme.paymentHistory, undefined);
    assert.equal(scheme.settlement, undefined);
  });
});
