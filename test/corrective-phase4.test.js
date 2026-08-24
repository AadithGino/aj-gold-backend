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
const { USER_ROLES } = require("../src/constants/enums");
const { createCustomer } = require("../src/services/customer.service");
const { createScheme } = require("../src/services/schemeManagement.service");
const { signAccessToken } = require("../src/services/auth.service");
const { redactObject } = require("../src/utils/logger");
const { runMigrations } = require("../src/migrations/runMigrations");

const reqId = () => crypto.randomUUID();

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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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

const createAdmin = async () =>
  User.create({
    name: "CP4 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaffWithPermissions = async (permissions) => {
  const staff = await User.create({
    name: "CP4 Staff",
    phone: `8${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });
  await StaffProfile.create({ user: staff._id, permissions });
  return staff;
};

describe("Corrective Phase 4 — authorization, MFA, CORS, privacy", () => {
  before(async () => {
    process.env.CORS_ORIGINS = "https://admin.example.com";
    delete require.cache[require.resolve("../src/config/env")];
    delete require.cache[require.resolve("../src/app")];

    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), { dbName: `aj_gold_cp4_${process.pid}` });

    app = require("../src/app");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await Promise.all(
      mongoose.modelNames().map((name) => mongoose.model(name).createCollection().catch(() => {}))
    );
    await runMigrations(mongoose.connection.db);
    await Promise.all(
      [Notification, StaffProfile].map((model) => model.syncIndexes())
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

  it("staff without canCollectPayment cannot list customers", async () => {
    const staff = await createStaffWithPermissions({ canCreateCustomer: true });
    const token = signAccessToken(staff);
    const res = await httpRequest({ method: "GET", path: "/api/customers?search=test", token });
    assert.equal(res.status, 403);
  });

  it("customer cannot create payments through app routes", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "CP4 Customer Pay Block",
        phone: `7${String(Date.now()).slice(-8)}0`,
        password: "1234",
      },
      admin
    );
    const customerUser = await User.findById(customer.user);
    const customerToken = signAccessToken(customerUser);

    const response = await httpRequest({
      method: "POST",
      path: "/api/payments",
      token: customerToken,
      body: {
        customer: customer._id.toString(),
        scheme: new mongoose.Types.ObjectId().toString(),
        amount: 1000,
        paymentMethod: "CASH",
        clientRequestId: reqId(),
      },
    });

    assert.equal(response.status, 403);
  });

  it("collection staff can search but receives minimal customer payload", async () => {
    const admin = await createAdmin();
    const staff = await createStaffWithPermissions({ canCollectPayment: true });
    const customer = await createCustomer(
      {
        name: "CP4 Search Customer",
        phone: `7${String(Date.now()).slice(-8)}1`,
        password: "1234",
        nominee: { name: "Hidden Nominee", phone: "9999999999" },
      },
      admin
    );

    const token = signAccessToken(staff);
    const res = await httpRequest({
      method: "GET",
      path: `/api/customers?search=${customer.passbookNumber}`,
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    const item = res.body.data.items[0];
    assert.equal(item.name, customer.name);
    assert.equal(item.nominee, undefined);
    assert.equal(item.address, undefined);
  });

  it("collection staff cannot list customers without a search query", async () => {
    const staff = await createStaffWithPermissions({ canCollectPayment: true });
    const token = signAccessToken(staff);
    const res = await httpRequest({ method: "GET", path: "/api/customers", token });
    assert.equal(res.status, 403);
  });

  it("staff cannot update customer identity details", async () => {
    const admin = await createAdmin();
    const staff = await createStaffWithPermissions({ canCollectPayment: true, canCreateCustomer: true });
    const customer = await createCustomer(
      { name: "CP4 Protected", phone: `7${String(Date.now()).slice(-8)}2`, password: "1234" },
      admin
    );
    const token = signAccessToken(staff);
    const res = await httpRequest({
      method: "PATCH",
      path: `/api/customers/${customer._id}`,
      token,
      body: { name: "Changed Name" },
    });
    assert.equal(res.status, 403);
  });

  it("staff with canCollectPayment but not canViewReports cannot access reports", async () => {
    const staff = await createStaffWithPermissions({ canCollectPayment: true });
    const token = signAccessToken(staff);
    const res = await httpRequest({ method: "GET", path: "/api/reports/collections", token });
    assert.equal(res.status, 403);
  });

  it("staff without settlement permissions cannot read scheme detail", async () => {
    const admin = await createAdmin();
    const staff = await createStaffWithPermissions({ canCollectPayment: true });
    const customer = await createCustomer(
      { name: "CP4 Scheme Customer", phone: `7${String(Date.now()).slice(-8)}3`, password: "1234" },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2026-01-01", clientRequestId: reqId() },
      admin
    );

    const token = signAccessToken(staff);
    const res = await httpRequest({ method: "GET", path: `/api/schemes/${scheme._id}`, token });
    assert.equal(res.status, 403);
  });

  it("removed MFA and account-deletion endpoints return 404", async () => {
    const admin = await createAdmin();
    const token = signAccessToken(admin);
    const removedPaths = [
      "/api/auth/mfa/complete-login",
      "/api/auth/mfa/enroll-bootstrap",
      "/api/auth/mfa/confirm-bootstrap",
      "/api/auth/mfa/enroll",
      "/api/auth/mfa/confirm",
      "/api/auth/mfa/disable",
      "/api/account/deletion-status",
      "/api/account/deletion-requests",
      "/api/admin/deletion-requests",
    ];

    for (const path of removedPaths) {
      const response = await httpRequest({ method: "POST", path, token, body: {} });
      assert.equal(response.status, 404);
    }
  });

  it("allows requests with no Origin and rejects disallowed browser origins with 403", async () => {
    const admin = await createAdmin();
    const token = signAccessToken(admin);

    const noOrigin = await httpRequest({
      method: "GET",
      path: "/api/auth/me",
      token,
    });
    assert.equal(noOrigin.status, 200);

    const allowed = await httpRequest({
      method: "GET",
      path: "/api/auth/me",
      token,
      headers: { Origin: "https://admin.example.com" },
    });
    assert.equal(allowed.status, 200);

    const blocked = await httpRequest({
      method: "GET",
      path: "/api/auth/me",
      token,
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(blocked.status, 403);
    assert.notEqual(blocked.status, 500);
  });

  it("redacts secrets and sensitive markers from structured logs", () => {
    const redacted = redactObject({
      password: "secret-pass",
      otp: "123456",
      token: "jwt-token-value",
      transactionReference: "TXN-123",
      phone: "9999999999",
    });
    assert.equal(redacted.password, "[REDACTED]");
    assert.equal(redacted.otp, "[REDACTED]");
    assert.equal(redacted.token, "[REDACTED]");
    assert.equal(redacted.phone, "9999999999");
  });

  it("public health is minimal and metrics are admin-protected", async () => {
    const live = await httpRequest({ method: "GET", path: "/api/health/live" });
    assert.equal(live.status, 200);
    assert.equal(live.body.alive, true);
    assert.equal(live.body.preflight, undefined);

    const metricsPublic = await httpRequest({ method: "GET", path: "/api/health/metrics" });
    assert.equal(metricsPublic.status, 401);

    const admin = await createAdmin();
    const token = signAccessToken(admin);
    const metricsAdmin = await httpRequest({ method: "GET", path: "/api/health/metrics", token });
    assert.equal(metricsAdmin.status, 200);
    assert.equal(metricsAdmin.headers["cache-control"], "no-store");
  });

  it("auth responses expose no MFA or forced-password fields", async () => {
    const admin = await createAdmin();
    const loginRes = await httpRequest({
      method: "POST",
      path: "/api/auth/login",
      body: { phone: admin.phone, password: "adminpass1" },
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.body.data.user.mfaEnabled, undefined);
    assert.equal(loginRes.body.data.user.mustChangePassword, undefined);

    const meRes = await httpRequest({
      method: "GET",
      path: "/api/auth/me",
      token: loginRes.body.data.token,
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.data.user.mfaEnabled, undefined);
    assert.equal(meRes.body.data.user.mustChangePassword, undefined);
  });
});
