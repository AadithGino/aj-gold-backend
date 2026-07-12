const {
  describe,
  it,
  before,
  after,
  beforeEach,
} = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Payment = require("../src/models/payment.model");
const Scheme = require("../src/models/scheme.model");
const AuditLog = require("../src/models/auditLog.model");
const IdempotencyRecord = require("../src/models/idempotencyRecord.model");
const PaymentCorrection = require("../src/models/paymentCorrection.model");
const CashSubmission = require("../src/models/cashSubmission.model");
const {
  USER_ROLES,
  USER_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
  CORRECTION_TYPES,
  CORRECTION_STATUS,
  AUDIT_ACTIONS,
  IDEMPOTENCY_OPERATIONS,
} = require("../src/constants/enums");
const {
  collectPayment,
  reversePayment,
  getPaymentDetail,
  getPaymentReceipt,
} = require("../src/services/payment.service");
const { createCashSubmission } = require("../src/services/cash.service");
const { updateSchemeStatus, createScheme } = require("../src/services/schemeManagement.service");
const {
  createCorrectionRequest,
  approveCorrection,
  rejectCorrection,
} = require("../src/services/correction.service");
const { createCustomer } = require("../src/services/customer.service");
const { logout, login } = require("../src/services/auth.service");
const { resolveStaffPermissions } = require("../src/constants/staffPermissions");
const { getCashPositionSummary, getSettlementTotals } = require("../src/services/cashPosition.service");
const { parsePositiveRupeeInteger } = require("../src/utils/money");
const { JWT_SECRET } = require("../src/config/env");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const {
  checkIdempotencyReplay,
  hashRequestPayload,
} = require("../src/services/idempotency.service");
const { transactionConflictError } = require("../src/utils/transaction");

const reqId = () => crypto.randomUUID();
const EARLY_PAYMENT_DATE = new Date("2025-02-01");
const POST_SIX_MONTH_DATE = new Date("2025-08-01");

let replSet;

const createAdmin = async () =>
  User.create({
    name: "Test Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async (status = USER_STATUS.ACTIVE) => {
  const staff = await User.create({
    name: "Test Staff",
    phone: `8${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
    status,
  });
  await StaffProfile.create({ user: staff._id });
  return staff;
};

const seedCustomerScheme = async (admin, startDate = new Date("2025-01-01")) => {
  const customer = await createCustomer(
    {
      name: "Test Customer",
      phone: `7${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
      password: "customer1pass",
    },
    admin
  );
  const scheme = await createScheme(
    { customerId: customer._id.toString(), startDate },
    admin
  );
  return { customer, scheme };
};

const pay = (customer, scheme, actor, amount, method = PAYMENT_METHODS.CASH, extras = {}) =>
  collectPayment(
    {
      customer: customer._id.toString(),
      scheme: scheme._id.toString(),
      amount,
      paymentMethod: method,
      paymentDate: extras.paymentDate || EARLY_PAYMENT_DATE,
      clientRequestId: extras.clientRequestId || reqId(),
      ...extras,
    },
    actor
  );

const expectStatus = async (promise, statusCode) => {
  await assert.rejects(promise, (error) => error.statusCode === statusCode);
};

const expectApiError = async (promise, { statusCode, code, retryable }) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode, `Expected status ${statusCode}, got ${error.statusCode}`);
    if (code !== undefined) {
      assert.equal(error.code, code, `Expected code ${code}, got ${error.code}`);
    }
    if (retryable !== undefined) {
      assert.equal(error.retryable, retryable, `Expected retryable ${retryable}, got ${error.retryable}`);
    }
    return true;
  });
};

describe("financial hardening", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: "wiredTiger",
      },
    });

    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_test_${process.pid}`,
    });
  });

  beforeEach(async () => {
    const collections = mongoose.connection.collections;
    for (const collection of Object.values(collections)) {
      await collection.deleteMany({});
    }
  });

  after(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    if (replSet) {
      await replSet.stop({
        doCleanup: true,
        force: true,
      });
    }
  });

  it("1. payment collection creates payment, receipt, audit and idempotency records", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const clientRequestId = reqId();

    const result = await pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH, { clientRequestId });

    assert.ok(result.payment.receiptNumber);
    assert.equal(await Payment.countDocuments(), 1);
    assert.equal(
      await AuditLog.countDocuments({
        action: AUDIT_ACTIONS.PAYMENT_COLLECTED,
        targetId: result.payment._id,
      }),
      1
    );
    assert.equal(
      await IdempotencyRecord.countDocuments({
        clientRequestId,
        operationType: IDEMPOTENCY_OPERATIONS.PAYMENT_COLLECT,
      }),
      1
    );
    assert.ok(result.receipt.receiptNumber);
  });

  it("2. duplicate payment retry returns the original payment", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const clientRequestId = reqId();
    const payload = {
      customer: customer._id.toString(),
      scheme: scheme._id.toString(),
      amount: 5000,
      paymentMethod: PAYMENT_METHODS.CASH,
      paymentDate: EARLY_PAYMENT_DATE,
      clientRequestId,
    };
    const first = await collectPayment(payload, staff);
    const second = await collectPayment(payload, staff);
    assert.equal(String(first.payment._id), String(second.payment._id));
    assert.equal(await Payment.countDocuments(), 1);
  });

  it("3. same idempotency key with different payload returns 409", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const clientRequestId = reqId();
    await collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 5000,
        paymentMethod: PAYMENT_METHODS.CASH,
        paymentDate: EARLY_PAYMENT_DATE,
        clientRequestId,
      },
      staff
    );
    await expectStatus(
      collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 6000,
          paymentMethod: PAYMENT_METHODS.CASH,
          paymentDate: EARLY_PAYMENT_DATE,
          clientRequestId,
        },
        staff
      ),
      409
    );
  });

  it("4. two concurrent payments cannot bypass the scheme payment limit", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);

    await pay(customer, scheme, admin, 30000, PAYMENT_METHODS.CASH, {
      paymentDate: EARLY_PAYMENT_DATE,
    });

    const results = await Promise.allSettled([
      collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 20000,
          paymentMethod: PAYMENT_METHODS.CASH,
          paymentDate: POST_SIX_MONTH_DATE,
          clientRequestId: reqId(),
        },
        staff
      ),
      collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 20000,
          paymentMethod: PAYMENT_METHODS.CASH,
          paymentDate: POST_SIX_MONTH_DATE,
          clientRequestId: reqId(),
        },
        staff
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const schemeDoc = await Scheme.findById(scheme._id);
    const postSixMonthTotal = await Payment.aggregate([
      {
        $match: {
          scheme: scheme._id,
          status: PAYMENT_STATUS.SUCCESS,
          paymentDate: { $gt: schemeDoc.sixMonthDate },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    assert.ok((postSixMonthTotal[0]?.total || 0) <= 30000);
  });

  it("5. payment and receipt roll back when audit creation fails", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const originalCreate = AuditLog.create.bind(AuditLog);

    AuditLog.create = async (docs, options) => {
      if (docs[0]?.action === AUDIT_ACTIONS.PAYMENT_COLLECTED) {
        throw new Error("forced audit failure");
      }
      return originalCreate(docs, options);
    };

    try {
      await assert.rejects(
        () =>
          pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH, {
            clientRequestId: reqId(),
          }),
        (error) => Boolean(error)
      );
      assert.equal(await Payment.countDocuments(), 0);
      assert.equal(
        await AuditLog.countDocuments({ action: AUDIT_ACTIONS.PAYMENT_COLLECTED }),
        0
      );
      assert.equal(await IdempotencyRecord.countDocuments(), 0);
    } finally {
      AuditLog.create = originalCreate;
    }
  });

  it("6. cash submission within available cash succeeds", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, staff, 7000);

    const { submission, cashSummary } = await createCashSubmission(
      {
        staff: staff._id.toString(),
        submittedAmount: 5000,
        clientRequestId: reqId(),
      },
      admin
    );

    assert.equal(submission.submittedAmount, 5000);
    assert.equal(cashSummary.cashInHand, 2000);
  });

  it("7. cash submission above cash in hand is rejected", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    await expectStatus(
      createCashSubmission(
        {
          staff: staff._id.toString(),
          submittedAmount: 1000,
          clientRequestId: reqId(),
        },
        admin
      ),
      409
    );
  });

  it("8. two concurrent cash submissions cannot overdraw staff cash", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, staff, 10000);

    const results = await Promise.allSettled([
      createCashSubmission(
        {
          staff: staff._id.toString(),
          submittedAmount: 8000,
          clientRequestId: reqId(),
        },
        admin
      ),
      createCashSubmission(
        {
          staff: staff._id.toString(),
          submittedAmount: 8000,
          clientRequestId: reqId(),
        },
        admin
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1);

    const submissions = await CashSubmission.find({ staff: staff._id });
    const totalSubmitted = submissions.reduce((sum, row) => sum + row.submittedAmount, 0);
    assert.ok(totalSubmitted <= 10000);
  });

  it("9. cash payment reversal succeeds when cash is available", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 5000);

    const reversed = await reversePayment(
      payment.payment._id,
      { reason: "Customer refund", clientRequestId: reqId() },
      admin
    );

    assert.equal(reversed.payment.status, PAYMENT_STATUS.REVERSED);
    const stored = await Payment.findById(payment.payment._id);
    assert.equal(stored.status, PAYMENT_STATUS.REVERSED);
  });

  it("10. cash payment reversal is rejected if it would create negative staff cash", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 5000);
    await createCashSubmission(
      {
        staff: staff._id.toString(),
        submittedAmount: 5000,
        clientRequestId: reqId(),
      },
      admin
    );

    await expectStatus(
      reversePayment(
        payment.payment._id,
        { reason: "Too late", clientRequestId: reqId() },
        admin
      ),
      409
    );
  });

  it("11. only one concurrent scheme settlement succeeds", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 10000, PAYMENT_METHODS.UPI);

    const results = await Promise.allSettled([
      updateSchemeStatus(
        scheme._id,
        {
          status: SCHEME_STATUS.REDEEMED,
          settlementAmount: 10000,
          notes: "Redeem test",
          clientRequestId: reqId(),
        },
        admin
      ),
      updateSchemeStatus(
        scheme._id,
        {
          status: SCHEME_STATUS.REDEEMED,
          settlementAmount: 10000,
          notes: "Redeem test",
          clientRequestId: reqId(),
        },
        admin
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
  });

  it("12. stored settlement amount remains unchanged across later report reads", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 8000, PAYMENT_METHODS.BANK);

    await updateSchemeStatus(
      scheme._id,
      {
        status: SCHEME_STATUS.REDEEMED,
        settlementAmount: 8000,
        notes: "Settled",
        clientRequestId: reqId(),
      },
      admin
    );

    const firstReport = await getSettlementTotals();
    const secondReport = await getSettlementTotals();
    assert.equal(firstReport.totalCustomerSettlement, 8000);
    assert.equal(secondReport.totalCustomerSettlement, 8000);

    const saved = await Scheme.findById(scheme._id);
    assert.equal(saved.settlement.amount, 8000);
  });

  it("13. new payment after redemption/closure is rejected", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin, new Date());
    await pay(customer, scheme, admin, 1000, PAYMENT_METHODS.UPI);
    await updateSchemeStatus(
      scheme._id,
      {
        status: SCHEME_STATUS.CLOSED,
        settlementAmount: 1000,
        notes: "Closed early",
        clientRequestId: reqId(),
      },
      admin
    );

    await expectStatus(() => pay(customer, scheme, staff, 1000), 409);
  });

  it("14. payment correction after scheme settlement is rejected", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 4000, PAYMENT_METHODS.UPI);

    await updateSchemeStatus(
      scheme._id,
      {
        status: SCHEME_STATUS.REDEEMED,
        settlementAmount: 4000,
        notes: "Settled",
        clientRequestId: reqId(),
      },
      admin
    );

    await expectStatus(
      createCorrectionRequest(
        payment.payment._id,
        {
          correctionType: CORRECTION_TYPES.EDIT_REFERENCE,
          requestedValue: "REF-999",
          reason: "Should fail",
        },
        staff
      ),
      409
    );
  });

  it("15. correction cannot be approved twice", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 4000, PAYMENT_METHODS.UPI);
    const correction = await createCorrectionRequest(
      payment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_REFERENCE,
        requestedValue: "REF-123",
        reason: "Fix reference",
      },
      staff
    );
    const reviewId = reqId();
    await approveCorrection(
      correction._id,
      { reviewClientRequestId: reviewId, reviewNotes: "ok" },
      admin
    );
    await expectStatus(
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reviewId, reviewNotes: "again" },
        admin
      ),
      409
    );
  });

  it("16. concurrent approve/reject results in only one final correction status", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 3000, PAYMENT_METHODS.UPI);
    const correction = await createCorrectionRequest(
      payment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_NOTES,
        requestedValue: "Updated note",
        reason: "Fix notes",
      },
      staff
    );

    const results = await Promise.allSettled([
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "approve" },
        admin
      ),
      rejectCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "reject" },
        admin
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1);

    const saved = await PaymentCorrection.findById(correction._id);
    assert.notEqual(saved.status, CORRECTION_STATUS.PENDING);
  });

  it("17. cash correction cannot create a negative staff cash balance", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH);
    await createCashSubmission(
      {
        staff: staff._id.toString(),
        submittedAmount: 5000,
        clientRequestId: reqId(),
      },
      admin
    );

    const correction = await createCorrectionRequest(
      payment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
        requestedValue: 3000,
        reason: "Reduce amount after cash submitted",
      },
      staff
    );

    await expectStatus(
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "approve" },
        admin
      ),
      409
    );
  });

  it("18. inactive staff with outstanding cash remains included in cash-position reporting", async () => {
    const admin = await createAdmin();
    const staff = await createStaff(USER_STATUS.INACTIVE);
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, staff, 6000, PAYMENT_METHODS.CASH);

    const summary = await getCashPositionSummary();
    const inactiveRow = summary.staffCashRows.find(
      (row) => String(row.staffId) === String(staff._id)
    );

    assert.ok(inactiveRow);
    assert.equal(inactiveRow.staffStatus, USER_STATUS.INACTIVE);
    assert.equal(inactiveRow.cashInHand, 6000);
  });

  it("19. explicitly disabled staff permissions remain disabled", () => {
    const resolved = resolveStaffPermissions({
      canCollectPayment: false,
      canCreateCustomer: false,
      canSubmitCash: false,
      canViewReports: false,
      canMarkRedeemed: false,
    });
    assert.equal(resolved.canCollectPayment, false);
    assert.equal(resolved.canViewReports, false);
    assert.equal(resolved.canMarkRedeemed, false);
    assert.equal(resolved.canMarkClosed, false);
  });

  it("19b. staff permissions default to operational access when unset", () => {
    const resolved = resolveStaffPermissions({});
    assert.equal(resolved.canViewReports, true);
    assert.equal(resolved.canMarkRedeemed, true);
    assert.equal(resolved.canSubmitCash, true);
  });

  it("20. staff cannot access another staff member's restricted payment or receipt", async () => {
    const admin = await createAdmin();
    const staffA = await createStaff();
    const staffB = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staffA, 2000);

    await expectStatus(getPaymentDetail(payment.payment._id, staffB), 403);
    await expectStatus(getPaymentReceipt(payment.payment._id, staffB), 403);
  });

  it("21. logout invalidates the previously issued JWT", async () => {
    const admin = await createAdmin();
    admin.passwordHash = await bcrypt.hash("adminpass1", 10);
    await admin.save();
    const { token } = await login({ phone: admin.phone, password: "adminpass1" });
    await logout(admin);
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    assert.notEqual(decoded.tokenVersion ?? 0, user.tokenVersion);
  });

  it("21b. login embeds the current tokenVersion after logout", async () => {
    const admin = await createAdmin();
    admin.passwordHash = await bcrypt.hash("adminpass1", 10);
    await admin.save();
    await logout(admin);
    const userAfterLogout = await User.findById(admin._id);
    const { token } = await login({ phone: admin.phone, password: "adminpass1" });
    const decoded = jwt.verify(token, JWT_SECRET);
    assert.equal(decoded.tokenVersion, userAfterLogout.tokenVersion);
    assert.equal(decoded.tokenVersion, 1);
  });

  it("22. missing clientRequestId returns validation error", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);

    await expectStatus(
      collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 1000,
          paymentMethod: PAYMENT_METHODS.CASH,
          paymentDate: EARLY_PAYMENT_DATE,
        },
        staff
      ),
      400
    );
  });

  it("23. invalid amounts are rejected", async () => {
    const invalidValues = [-100, 10.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "abc"];
    for (const value of invalidValues) {
      try {
        parsePositiveRupeeInteger(value, "amount");
        assert.fail(`Expected invalid amount to throw: ${value}`);
      } catch (error) {
        assert.equal(error.statusCode, 400);
      }
    }

    try {
      parsePositiveRupeeInteger(0, "amount");
      assert.fail("Expected zero amount to throw");
    } catch (error) {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /greater than zero/i);
    }
  });

  it("24. financial transaction rollback leaves no partial audit, payment, settlement, correction or idempotency record", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const originalCreate = AuditLog.create.bind(AuditLog);

    AuditLog.create = async (docs, options) => {
      if (docs[0]?.action === AUDIT_ACTIONS.PAYMENT_COLLECTED) {
        throw new Error("forced audit failure");
      }
      return originalCreate(docs, options);
    };

    try {
      await assert.rejects(() =>
        pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH, { clientRequestId: reqId() })
      );
      assert.equal(await Payment.countDocuments(), 0);
      assert.equal(
        await AuditLog.countDocuments({ action: AUDIT_ACTIONS.PAYMENT_COLLECTED }),
        0
      );
      assert.equal(await IdempotencyRecord.countDocuments(), 0);
      assert.equal(await PaymentCorrection.countDocuments(), 0);
      assert.equal(await Scheme.countDocuments({ "settlement.amount": { $exists: true } }), 0);
    } finally {
      AuditLog.create = originalCreate;
    }
  });

  it("25. idempotency key reused with different payload returns IDEMPOTENCY_KEY_REUSED", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const clientRequestId = reqId();
    await pay(customer, scheme, admin, 1000, PAYMENT_METHODS.CASH, { clientRequestId });

    await expectApiError(
      pay(customer, scheme, admin, 2000, PAYMENT_METHODS.CASH, { clientRequestId }),
      {
        statusCode: 409,
        code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        retryable: false,
      }
    );
  });

  it("26. transaction conflict error is retryable", () => {
    const err = transactionConflictError();
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, ERROR_CODES.TRANSACTION_RETRY_REQUIRED);
    assert.equal(err.retryable, true);
  });

  it("27. insufficient cash submission returns INSUFFICIENT_STAFF_CASH", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, staff, 5000, PAYMENT_METHODS.CASH);

    await expectApiError(
      createCashSubmission(
        {
          staff: staff._id.toString(),
          submittedAmount: 6000,
          clientRequestId: reqId(),
        },
        admin
      ),
      {
        statusCode: 409,
        code: ERROR_CODES.INSUFFICIENT_STAFF_CASH,
        retryable: false,
      }
    );
  });

  it("28. payment after settlement returns PAYMENT_AFTER_SETTLEMENT", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, staff, 4000, PAYMENT_METHODS.CASH);
    await updateSchemeStatus(
      scheme._id,
      {
        status: SCHEME_STATUS.REDEEMED,
        settlementAmount: 4000,
        notes: "Settled",
        clientRequestId: reqId(),
      },
      admin
    );

    await expectApiError(
      pay(customer, scheme, staff, 1000, PAYMENT_METHODS.CASH, { clientRequestId: reqId() }),
      {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_AFTER_SETTLEMENT,
        retryable: false,
      }
    );
  });

  it("29. correction already reviewed returns CORRECTION_ALREADY_REVIEWED", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const payment = await pay(customer, scheme, staff, 3000, PAYMENT_METHODS.UPI);
    const correction = await createCorrectionRequest(
      payment.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_NOTES,
        requestedValue: "Updated note",
        reason: "Fix notes",
      },
      staff
    );
    await approveCorrection(
      correction._id,
      { reviewClientRequestId: reqId(), reviewNotes: "ok" },
      admin
    );

    await expectApiError(
      approveCorrection(
        correction._id,
        { reviewClientRequestId: reqId(), reviewNotes: "again" },
        admin
      ),
      {
        statusCode: 409,
        code: ERROR_CODES.CORRECTION_ALREADY_REVIEWED,
        retryable: false,
      }
    );
  });

  it("30. invalid login returns UNAUTHORIZED", async () => {
    await expectApiError(login({ phone: "9999999999", password: "wrongpass1" }), {
      statusCode: 401,
      code: ERROR_CODES.UNAUTHORIZED,
      retryable: false,
    });
  });

  it("31. in-flight duplicate idempotency returns TRANSACTION_RETRY_REQUIRED", async () => {
    const clientRequestId = reqId();
    const operationType = IDEMPOTENCY_OPERATIONS.PAYMENT_COLLECT;
    const requestPayload = { amount: 100 };

    await IdempotencyRecord.create({
      clientRequestId,
      operationType,
      requestHash: hashRequestPayload(requestPayload),
    });

    await expectApiError(
      checkIdempotencyReplay({
        clientRequestId,
        operationType,
        requestPayload,
        session: null,
      }),
      {
        statusCode: 409,
        code: ERROR_CODES.TRANSACTION_RETRY_REQUIRED,
        retryable: true,
      }
    );
  });
});
