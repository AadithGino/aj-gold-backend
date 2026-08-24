const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Scheme = require("../src/models/scheme.model");
const FinancialJournal = require("../src/models/financialJournal.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  SCHEME_STATUS,
  SETTLEMENT_WORKFLOW_STATUS,
  JOURNAL_EVENT_TYPES,
  CORRECTION_TYPES,
} = require("../src/constants/enums");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const {
  ALLOWED_SETTLEMENT_PAYOUT_METHODS,
  SETTLEMENT_CONTRACT,
} = require("../src/constants/settlementContract");
const { collectPayment, reversePayment } = require("../src/services/payment.service");
const { createScheme, updateSchemeStatus } = require("../src/services/schemeManagement.service");
const { completeSettlement } = require("../src/services/settlement.service");
const { createCustomer } = require("../src/services/customer.service");
const {
  createCorrectionRequest,
  approveCorrection,
} = require("../src/services/correction.service");
const { runMigrations } = require("../src/migrations/runMigrations");
const { calculateSchemeDates } = require("../src/services/scheme.service");
const { deriveSchemeWindow } = require("../src/utils/schemeWindow");
const {
  FULL_OPERATIONAL_STAFF_PERMISSIONS,
  SETTLEMENT_STAFF_PERMISSIONS,
} = require("./helpers/staffTestPermissions");

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

const maturityTime = () => {
  const window = deriveSchemeWindow(calculateSchemeDates(SCHEME_START));
  return new Date(window.maturityDate.getTime() + 24 * 60 * 60 * 1000);
};

const createAdmin = async () =>
  User.create({
    name: "CP1 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async (permissions = SETTLEMENT_STAFF_PERMISSIONS) => {
  const staff = await User.create({
    name: "CP1 Staff",
    phone: `8${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });
  await StaffProfile.create({ user: staff._id, permissions });
  return staff;
};

const seedCustomerScheme = async (admin, { startDate = SCHEME_START, schemeName } = {}) => {
  const customer = await createCustomer(
    {
      name: "CP1 Customer",
      phone: `7${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
      password: "1234",
    },
    admin
  );
  const scheme = await createScheme(
    {
      customerId: customer._id.toString(),
      startDate,
      clientRequestId: reqId(),
      ...(schemeName ? { schemeName } : {}),
    },
    admin
  );
  return { customer, scheme };
};

const pay = async (customer, scheme, actor, amount, method = PAYMENT_METHODS.CASH, at = null) => {
  const schemeDoc = scheme.startDate ? scheme : await Scheme.findById(scheme._id);
  const when = at || firstPeriodTime();
  return withMockedNow(when, () =>
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
};

const settlePayload = (overrides = {}) => ({
  status: SCHEME_STATUS.REDEEMED,
  notes: "Corrective phase 1 settlement",
  clientRequestId: reqId(),
  payoutMethod: PAYMENT_METHODS.CASH,
  ...overrides,
});

describe("Corrective Phase 1 — owner-approved settlement contract", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_cp1_${process.pid}`,
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
    if (replSet) await replSet.stop();
  });

  it("contract allows only CASH, UPI, BANK with optional reference and no maker/checker", () => {
    assert.deepEqual(ALLOWED_SETTLEMENT_PAYOUT_METHODS, ["CASH", "UPI", "BANK"]);
    assert.equal(SETTLEMENT_CONTRACT.payoutReferenceRequired, false);
    assert.equal(SETTLEMENT_CONTRACT.payoutEvidenceRequired, false);
    assert.equal(SETTLEMENT_CONTRACT.makerCheckerRequired, false);
    assert.equal(SETTLEMENT_CONTRACT.customerAcknowledgementRequired, false);
    assert.equal(SETTLEMENT_CONTRACT.makingChargeAffectsPayout, false);
  });

  it("maturity principal equals effective contributions across months 1-6 and 7-11", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 2000);
    await pay(customer, scheme, admin, 3000);
    await pay(customer, scheme, admin, 1500, PAYMENT_METHODS.UPI, laterPeriodTime());

    const settled = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), admin)
    );
    assert.equal(settled.settlement.amount, 6500);
    assert.equal(settled.status, SCHEME_STATUS.REDEEMED);
  });

  it("early closure uses the same principal-only formula", async () => {
    const admin = await createAdmin();
    const recentStart = new Date();
    const { customer, scheme } = await seedCustomerScheme(admin, { startDate: recentStart });
    await pay(
      customer,
      scheme,
      admin,
      4200,
      PAYMENT_METHODS.CASH,
      new Date(recentStart.getTime() + 24 * 60 * 60 * 1000)
    );

    const settled = await updateSchemeStatus(
      scheme._id,
      settlePayload({ status: SCHEME_STATUS.CLOSED }),
      admin
    );
    assert.equal(settled.settlement.amount, 4200);
    assert.equal(settled.settlement.settlementCategory, "early_closure");
  });

  it("reversed contributions are excluded from entitlement", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 5000);
    await pay(customer, scheme, staff, 2000);
    await reversePayment(
      paymentResult.payment._id,
      { reason: "Duplicate entry", clientRequestId: reqId() },
      admin
    );

    const settled = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), admin)
    );
    assert.equal(settled.settlement.amount, 2000);
  });

  it("approved amount correction changes entitlement exactly once", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    const paymentResult = await pay(customer, scheme, staff, 5000);
    const correction = await createCorrectionRequest(
      paymentResult.payment._id,
      {
        correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
        requestedValue: 4500,
        reason: "Customer paid 4500",
      },
      staff
    );
    await approveCorrection(
      correction._id,
      { reviewNotes: "Approved", reviewClientRequestId: reqId() },
      admin
    );

    const settled = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), admin)
    );
    assert.equal(settled.settlement.amount, 4500);
  });

  for (const method of ALLOWED_SETTLEMENT_PAYOUT_METHODS) {
    it(`${method} settlement succeeds without payout reference or evidence`, async () => {
      const admin = await createAdmin();
      const { customer, scheme } = await seedCustomerScheme(admin);
      await pay(customer, scheme, admin, 1800, method === PAYMENT_METHODS.CASH ? method : PAYMENT_METHODS.UPI);

      const settled = await withMockedNow(maturityTime(), () =>
        updateSchemeStatus(
          scheme._id,
          settlePayload({ payoutMethod: method, payoutReference: undefined }),
          admin
        )
      );
      assert.equal(settled.settlement.amount, 1800);
      assert.equal(settled.settlement.payoutMethod, method);
    });
  }

  for (const method of ALLOWED_SETTLEMENT_PAYOUT_METHODS) {
    it(`${method} settlement succeeds without notes, reference, and evidence`, async () => {
      const admin = await createAdmin();
      const { customer, scheme } = await seedCustomerScheme(admin);
      await pay(customer, scheme, admin, 2600);

      const settled = await withMockedNow(maturityTime(), () =>
        updateSchemeStatus(
          scheme._id,
          settlePayload({
            payoutMethod: method,
            payoutReference: undefined,
            notes: undefined,
            payoutEvidence: undefined,
          }),
          admin
        )
      );
      assert.equal(settled.settlement.amount, 2600);
      assert.equal(settled.settlement.notes, "");
      assert.equal(settled.settlement.payoutMethod, method);
      assert.equal(settled.settlement.payoutReference, "");
      assert.equal(settled.settlement.payoutEvidence, null);
    });
  }

  it("rejects CARD and other non-settlement payout methods", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 1000);

    await assert.rejects(
      withMockedNow(maturityTime(), () =>
        completeSettlement(
          scheme._id,
          settlePayload({ payoutMethod: PAYMENT_METHODS.CARD }),
          admin
        )
      ),
      (error) => error.code === ERROR_CODES.SETTLEMENT_PAYOUT_METHOD_INVALID
    );
  });

  it("admin may settle directly without acknowledgement", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 3300);

    const settled = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), admin)
    );
    assert.equal(settled.settlementWorkflow.status, SETTLEMENT_WORKFLOW_STATUS.FINALIZED);
    assert.equal(settled.settlement.amount, 3300);
    assert.equal(settled.settlementWorkflow.requestedBy, undefined);
    assert.equal(settled.settlementWorkflow.approvedBy, undefined);
    assert.equal(settled.settlementWorkflow.paidBy, undefined);
  });

  it("staff with settlement permission succeeds; staff without permission fails", async () => {
    const admin = await createAdmin();
    const allowed = await createStaff(SETTLEMENT_STAFF_PERMISSIONS);
    const denied = await createStaff(FULL_OPERATIONAL_STAFF_PERMISSIONS);
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, allowed, 2400);

    const settled = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), allowed)
    );
    assert.equal(settled.settlement.amount, 2400);

    const { customer: customer2, scheme: scheme2 } = await seedCustomerScheme(admin);
    await pay(customer2, scheme2, allowed, 1200);
    await assert.rejects(
      withMockedNow(maturityTime(), () =>
        updateSchemeStatus(scheme2._id, settlePayload(), denied)
      ),
      (error) => error.statusCode === 403
    );
  });

  it("caller-supplied settlementAmount cannot change the payout", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 3600);

    await assert.rejects(
      withMockedNow(maturityTime(), () =>
        updateSchemeStatus(
          scheme._id,
          { ...settlePayload(), settlementAmount: 99999 },
          admin
        )
      ),
      (error) => error.code === ERROR_CODES.SETTLEMENT_AMOUNT_NOT_ALLOWED
    );
  });

  it("concurrent settlement attempts produce one journal effect", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 8800);

    const results = await withMockedNow(maturityTime(), () =>
      Promise.allSettled([
        updateSchemeStatus(scheme._id, settlePayload(), admin),
        updateSchemeStatus(scheme._id, settlePayload(), admin),
      ])
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1);

    const paidEntries = await FinancialJournal.find({
      scheme: scheme._id,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
    });
    assert.equal(paidEntries.length, 1);
    assert.equal(paidEntries[0].amount, 8800);
  });

  it("idempotent replay returns the same settlement; conflicting payload is rejected", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 5100);
    const clientRequestId = reqId();
    const payload = settlePayload({ clientRequestId, payoutMethod: PAYMENT_METHODS.UPI });

    const first = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, payload, admin)
    );
    const replay = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, payload, admin)
    );
    assert.equal(replay.settlement.amount, first.settlement.amount);
    assert.equal(replay.settlement.settlementReceiptId, first.settlement.settlementReceiptId);

    const { customer: customer2, scheme: scheme2 } = await seedCustomerScheme(admin);
    await pay(customer2, scheme2, admin, 1000);
    await assert.rejects(
      withMockedNow(maturityTime(), () =>
        updateSchemeStatus(
          scheme2._id,
          settlePayload({
            clientRequestId,
            payoutMethod: PAYMENT_METHODS.BANK,
          }),
          admin
        )
      ),
      (error) => error.code === ERROR_CODES.IDEMPOTENCY_KEY_REUSED
    );
  });

  it("generates a unique internal settlement receipt identifier", async () => {
    const admin = await createAdmin();
    const { customer: c1, scheme: s1 } = await seedCustomerScheme(admin);
    const { customer: c2, scheme: s2 } = await seedCustomerScheme(admin);
    await pay(c1, s1, admin, 1100);
    await pay(c2, s2, admin, 2200);

    const settled1 = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(s1._id, settlePayload(), admin)
    );
    const settled2 = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(s2._id, settlePayload(), admin)
    );

    assert.match(settled1.settlement.settlementReceiptId, /^AJGK-SET-\d{4}-\d{6}$/);
    assert.match(settled2.settlement.settlementReceiptId, /^AJGK-SET-\d{4}-\d{6}$/);
    assert.notEqual(settled1.settlement.settlementReceiptId, settled2.settlement.settlementReceiptId);
  });

  it("making-charge scheme metadata does not change payout amount", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin, {
      schemeName: "Making Charge Benefit Scheme — 15% off jewellery",
    });
    await pay(customer, scheme, admin, 7500);

    const settled = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), admin)
    );
    assert.equal(settled.schemeName, "Making Charge Benefit Scheme — 15% off jewellery");
    assert.equal(settled.settlement.amount, 7500);
  });

  it("does not write settlement authorization self-debit/self-credit journal entries", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 2500);

    await withMockedNow(maturityTime(), () => updateSchemeStatus(scheme._id, settlePayload(), admin));

    const authorizedEntries = await FinancialJournal.find({
      scheme: scheme._id,
      eventType: "SETTLEMENT_AUTHORIZED",
    });
    assert.equal(authorizedEntries.length, 0);
  });
});
