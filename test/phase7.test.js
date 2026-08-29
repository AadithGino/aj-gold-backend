const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const { login } = require("../src/services/auth.service");
const { createCustomer } = require("../src/services/customer.service");
const { collectPayment } = require("../src/services/payment.service");
const { createScheme } = require("../src/services/schemeManagement.service");
const { assertCallerPaymentDateNotAllowed } = require("../src/utils/schemeWindow");
const { resolveStaffPermissions } = require("../src/constants/staffPermissions");
const { PAYMENT_METHODS, USER_ROLES } = require("../src/constants/enums");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const { runMigrations, verifyMigrationsApplied } = require("../src/migrations/runMigrations");
const { verifyRequiredIndexes } = require("../src/ops/requiredIndexes");
const { scanIntegrity } = require("../src/ops/integrityScanner");
const { ENTITLEMENT_FORMULA_VERSION } = require("../src/constants/settlementContract");
const { BUSINESS_TIMEZONE } = require("../src/utils/date");
const ApiError = require("../src/utils/ApiError");

const reqId = () => require("crypto").randomUUID();

let replSet;

describe("Phase 7 production contract regression proofs", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_phase7_${process.pid}`,
    });
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }
    await mongoose.connection.db.collection("schema_migrations").deleteMany({});
    await mongoose.connection.db.collection("schema_migration_locks").deleteMany({});
    await runMigrations(mongoose.connection.db);
  });

  after(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it("P0-1 rejects caller-supplied paymentDate on collection", () => {
    assert.throws(
      () => assertCallerPaymentDateNotAllowed({ paymentDate: "2025-01-01" }),
      (error) => error instanceof ApiError && error.code === ERROR_CODES.PAYMENT_DATE_NOT_ALLOWED
    );
  });

  it("P0-7 settlementAmount is rejected at service boundary", async () => {
    const { completeSettlement } = require("../src/services/settlement.service");
    await assert.rejects(
      () =>
        completeSettlement(
          new mongoose.Types.ObjectId(),
          { status: "REDEEMED", notes: "n", payoutMethod: PAYMENT_METHODS.CASH, settlementAmount: 1 },
          { _id: new mongoose.Types.ObjectId(), role: USER_ROLES.ADMIN }
        ),
      (error) => error.code === ERROR_CODES.SETTLEMENT_AMOUNT_NOT_ALLOWED
    );
  });

  it("P1-2 staff permissions are deny-by-default", () => {
    const resolved = resolveStaffPermissions({});
    assert.equal(resolved.canCollectPayment, false);
    assert.equal(resolved.canFinalizeSettlement, false);
  });

  it("passbook credential login remains compatible", async () => {
    const admin = await User.create({
      name: "P7 Admin",
      phone: `9${String(Date.now()).slice(-9)}`,
      passwordHash: await bcrypt.hash("adminpass1", 10),
      role: USER_ROLES.ADMIN,
    });
    const customer = await createCustomer(
      { name: "P7 Customer", phone: `7${String(Date.now()).slice(-9)}` },
      admin
    );
    const user = await User.findById(customer.user);
    const result = await login({ phone: user.phone, password: customer.passbookNumber });
    assert.ok(result.token);
  });

  it("public customer registration route exists in route sources", () => {
    const routesDir = path.join(__dirname, "../src/routes");
    const sources = fs.readdirSync(routesDir).map((file) =>
      fs.readFileSync(path.join(routesDir, file), "utf8")
    );
    assert.match(sources.join("\n"), /\/register/);
  });

  it("P0-9 migration/index/preflight artifacts are present on clean DB", async () => {
    const db = mongoose.connection.db;
    await verifyMigrationsApplied(db);
    const indexes = await verifyRequiredIndexes(db);
    assert.ok(indexes.verified >= 10);
    const scan = await scanIntegrity({ db });
    assert.equal(scan.ok, true);
  });

  it("frozen contract constants remain unchanged", () => {
    assert.equal(BUSINESS_TIMEZONE, "Asia/Kolkata");
    assert.equal(ENTITLEMENT_FORMULA_VERSION, "principal-v1");
  });

  it("customer role cannot hit payment collection route middleware chain", () => {
    const paymentRoutes = fs.readFileSync(
      path.join(__dirname, "../src/routes/payment.routes.js"),
      "utf8"
    );
    assert.match(paymentRoutes, /adminOrStaffMiddleware/);
    assert.doesNotMatch(paymentRoutes, /CUSTOMER/);
  });
});
