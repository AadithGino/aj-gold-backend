const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const Customer = require("../src/models/customer.model");
const StaffProfile = require("../src/models/staffProfile.model");
const LoginAttempt = require("../src/models/loginAttempt.model");
const AuditLog = require("../src/models/auditLog.model");
const {
  USER_ROLES,
  USER_STATUS,
  PAYMENT_METHODS,
  SCHEME_STATUS,
  AUDIT_ACTIONS,
} = require("../src/constants/enums");
const {
  assertCustomerPassword,
  assertPrivilegedPassword,
} = require("../src/constants/credentialPolicies");
const { resolveStaffPermissions } = require("../src/constants/staffPermissions");
const { login, logout } = require("../src/services/auth.service");
const {
  createCustomer,
  updateCustomer,
  resetCustomerPassword,
} = require("../src/services/customer.service");
const { createStaff } = require("../src/services/staff.service");
const { collectPayment } = require("../src/services/payment.service");
const { createScheme, updateSchemeStatus } = require("../src/services/schemeManagement.service");
const {
  recordFailedAttempt,
  resetAttempts,
  buildKey,
} = require("../src/services/loginRateLimit.service");
const { runMigrations } = require("../src/migrations/runMigrations");
const { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } = require("../src/config/env");
const ApiError = require("../src/utils/ApiError");
const fs = require("fs");
const path = require("path");
const { SETTLEMENT_STAFF_PERMISSIONS, FULL_OPERATIONAL_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");

const reqId = () => crypto.randomUUID();

let replSet;

const createAdmin = async () =>
  User.create({
    name: "Phase5 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const getCustomerUser = async (customer) => User.findById(customer.user);

describe("Phase 5 auth and permission guardrails", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_phase5_${process.pid}`,
    });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await runMigrations(mongoose.connection.db);
  });

  after(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it("passbook customer can log in with four-character passbook password", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      { name: "Passbook Customer", phone: `7${String(Date.now()).slice(-9)}` },
      admin
    );
    assert.match(customer.passbookNumber, /^\d{4}$/);

    const user = await getCustomerUser(customer);
    const result = await login({
      phone: user.phone,
      password: customer.passbookNumber,
    });
    assert.ok(result.token);
    assert.equal(result.user.role, USER_ROLES.CUSTOMER);
  });

  it("admin and staff password login succeed without MFA branches", async () => {
    const admin = await createAdmin();
    const { user: staff } = await createStaff(
      {
        name: "No MFA Staff",
        phone: `8${String(Date.now()).slice(-9)}`,
        password: "staffpass1",
      },
      admin
    );

    const adminLogin = await login({ phone: admin.phone, password: "adminpass1" });
    const staffLogin = await login({ phone: staff.phone, password: "staffpass1" });

    assert.ok(adminLogin.token);
    assert.ok(staffLogin.token);
    assert.equal(adminLogin.mfaRequired, undefined);
    assert.equal(adminLogin.mfaEnrollmentRequired, undefined);
    assert.equal(staffLogin.mfaRequired, undefined);
    assert.equal(staffLogin.mfaEnrollmentRequired, undefined);
  });

  it("explicit customer password validation follows four-character customer policy", () => {
    assert.throws(() => assertCustomerPassword("abc"), ApiError);
    assert.throws(() => assertCustomerPassword("123456789012345678901234567890123"), ApiError);
    assert.doesNotThrow(() => assertCustomerPassword("1234"));
  });

  it("privileged weak password is rejected", () => {
    assert.throws(() => assertPrivilegedPassword("short"), ApiError);
  });

  it("password reset invalidates existing JWT via tokenVersion", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "Reset Customer",
        phone: `7${String(Date.now()).slice(-9)}`,
        password: "9999",
      },
      admin
    );
    const user = await getCustomerUser(customer);
    const { token } = await login({ phone: user.phone, password: "9999" });

    await resetCustomerPassword(customer._id, "8888", admin);

    const decoded = jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    const updatedUser = await User.findById(user._id);
    assert.notEqual(decoded.tokenVersion, updatedUser.tokenVersion);
  });

  it("logout is recorded with LOGOUT audit action", async () => {
    const admin = await createAdmin();
    await logout(admin);
    const audit = await AuditLog.findOne({ actor: admin._id, action: AUDIT_ACTIONS.LOGOUT });
    assert.ok(audit);
  });

  it("persistent login limiter tracks IP and account independently", async () => {
    const phone = `6${String(Date.now()).slice(-9)}`;
    const ip = "203.0.113.10";

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await recordFailedAttempt({ ip, phone: null });
    }

    await assert.rejects(
      () => recordFailedAttempt({ ip, phone: null }),
      (error) => error.statusCode === 429
    );

    await resetAttempts({ ip, phone: null });
    await assert.doesNotReject(() => recordFailedAttempt({ ip, phone: null }));

    await LoginAttempt.deleteMany({});
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await recordFailedAttempt({ phone });
    }
    await assert.rejects(
      () => recordFailedAttempt({ phone }),
      (error) => error.statusCode === 429
    );
    const accountEntry = await LoginAttempt.findOne({ key: buildKey("account", phone) });
    assert.ok(accountEntry.lockedUntil);
  });

  it("missing StaffProfile and missing permission deny staff access", async () => {
    const staff = await User.create({
      name: "No Profile Staff",
      phone: `8${String(Date.now()).slice(-9)}`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: USER_ROLES.STAFF,
    });

    await assert.rejects(
      () =>
        collectPayment(
          {
            customer: new mongoose.Types.ObjectId().toString(),
            scheme: new mongoose.Types.ObjectId().toString(),
            amount: 1000,
            paymentMethod: PAYMENT_METHODS.CASH,
            clientRequestId: reqId(),
          },
          staff
        ),
      (error) => error.statusCode === 403
    );

    await StaffProfile.create({
      user: staff._id,
      permissions: { ...FULL_OPERATIONAL_STAFF_PERMISSIONS, canCollectPayment: false },
    });

    await assert.rejects(
      () =>
        collectPayment(
          {
            customer: new mongoose.Types.ObjectId().toString(),
            scheme: new mongoose.Types.ObjectId().toString(),
            amount: 1000,
            paymentMethod: PAYMENT_METHODS.CASH,
            clientRequestId: reqId(),
          },
          staff
        ),
      (error) => error.statusCode === 403
    );
  });

  it("staff cannot finalize settlement without canFinalizeSettlement", async () => {
    const admin = await createAdmin();
    const { user: staff } = await createStaff(
      {
        name: "Limited Staff",
        phone: `8${String(Date.now()).slice(-9)}`,
        password: "staffpass1",
        permissions: {
          ...SETTLEMENT_STAFF_PERMISSIONS,
          canFinalizeSettlement: false,
        },
      },
      admin
    );

    const customer = await createCustomer(
      { name: "Settle Customer", phone: `7${String(Date.now()).slice(-9)}` },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );

    await assert.rejects(
      () =>
        updateSchemeStatus(
          scheme._id,
          {
            status: SCHEME_STATUS.REDEEMED,
            notes: "Should fail",
            payoutMethod: PAYMENT_METHODS.CASH,
            clientRequestId: reqId(),
          },
          staff
        ),
      (error) => error.statusCode === 403
    );
  });

  it("inactive customer cannot receive new payments", async () => {
    const admin = await createAdmin();
    const staff = await User.create({
      name: "Pay Staff",
      phone: `8${String(Date.now()).slice(-9)}`,
      passwordHash: await bcrypt.hash("staffpass1", 10),
      role: USER_ROLES.STAFF,
    });
    await StaffProfile.create({ user: staff._id, permissions: FULL_OPERATIONAL_STAFF_PERMISSIONS });

    const customer = await createCustomer(
      { name: "Inactive Customer", phone: `7${String(Date.now()).slice(-9)}` },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: "2025-01-01", clientRequestId: reqId() },
      admin
    );
    await Customer.findByIdAndUpdate(customer._id, { status: USER_STATUS.INACTIVE });

    await assert.rejects(
      () =>
        collectPayment(
          {
            customer: customer._id.toString(),
            scheme: scheme._id.toString(),
            amount: 1000,
            paymentMethod: PAYMENT_METHODS.CASH,
            clientRequestId: reqId(),
          },
          staff
        ),
      (error) => error.statusCode === 403
    );
  });

  it("User/Customer update rolls back together on duplicate phone fault", async () => {
    const admin = await createAdmin();
    const first = await createCustomer(
      { name: "First Customer", phone: `7${String(Date.now()).slice(-9)}` },
      admin
    );
    const second = await createCustomer(
      { name: "Second Customer", phone: `7${String(Date.now() + 1).slice(-9)}` },
      admin
    );

    await assert.rejects(
      () => updateCustomer(second._id, { phone: first.phone }, admin),
      (error) => error.statusCode === 409
    );

    const refreshed = await Customer.findById(second._id);
    const refreshedUser = await User.findById(refreshed.user);
    assert.equal(refreshed.phone, refreshedUser.phone);
    assert.notEqual(refreshed.phone, first.phone);
  });

  it("auth login response does not include MFA or forced-password fields", async () => {
    const admin = await createAdmin();
    const loggedIn = await login({ phone: admin.phone, password: "adminpass1" });
    assert.ok(loggedIn.token);
    assert.equal(loggedIn.user.mfaEnabled, undefined);
    assert.equal(loggedIn.user.mustChangePassword, undefined);
  });

  it("public registration route remains absent", () => {
    const routesDir = path.join(__dirname, "../src/routes");
    const routeSources = fs
      .readdirSync(routesDir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => fs.readFileSync(path.join(routesDir, file), "utf8"))
      .join("\n");
    assert.equal(/\/register|registerCustomer|self-registration/i.test(routeSources), false);
  });

  it("production env rejects empty CORS allowlist", () => {
    const envPath = require.resolve("../src/config/env");
    const originalEnv = process.env.NODE_ENV;
    const originalCors = process.env.CORS_ORIGINS;
    const originalJwt = process.env.JWT_SECRET;

    try {
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGINS = "";
      process.env.JWT_SECRET = "x".repeat(40);
      delete require.cache[envPath];
      assert.throws(() => require(envPath), /CORS_ORIGINS must be a non-empty allowlist/);
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.CORS_ORIGINS = originalCors;
      process.env.JWT_SECRET = originalJwt;
      delete require.cache[envPath];
      require(envPath);
    }
  });

  it("production env does not require MFA variables", () => {
    const envPath = require.resolve("../src/config/env");
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCors = process.env.CORS_ORIGINS;
    const originalJwt = process.env.JWT_SECRET;
    const originalMongo = process.env.MONGO_URI;
    const originalMfaKey = process.env.MFA_ENCRYPTION_KEY;
    const originalMfaRequired = process.env.ADMIN_MFA_REQUIRED;

    try {
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGINS = "https://admin.example.com";
      process.env.JWT_SECRET = "x".repeat(40);
      process.env.MONGO_URI = "mongodb://127.0.0.1:27017/ajgold_prod";
      delete process.env.MFA_ENCRYPTION_KEY;
      delete process.env.ADMIN_MFA_REQUIRED;

      delete require.cache[envPath];
      assert.doesNotThrow(() => require(envPath));
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.CORS_ORIGINS = originalCors;
      process.env.JWT_SECRET = originalJwt;
      process.env.MONGO_URI = originalMongo;
      if (originalMfaKey === undefined) {
        delete process.env.MFA_ENCRYPTION_KEY;
      } else {
        process.env.MFA_ENCRYPTION_KEY = originalMfaKey;
      }
      if (originalMfaRequired === undefined) {
        delete process.env.ADMIN_MFA_REQUIRED;
      } else {
        process.env.ADMIN_MFA_REQUIRED = originalMfaRequired;
      }
      delete require.cache[envPath];
      require(envPath);
    }
  });

  it("deny-by-default permission matrix resolves explicit booleans only", () => {
    const resolved = resolveStaffPermissions({ canSubmitCash: true });
    assert.equal(resolved.canSubmitCash, true);
    assert.equal(resolved.canCollectPayment, false);
    assert.equal(resolved.canFinalizeSettlement, false);
  });
});
