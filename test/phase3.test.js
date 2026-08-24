const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../src/models/user.model");
const StaffProfile = require("../src/models/staffProfile.model");
const Scheme = require("../src/models/scheme.model");
const Payment = require("../src/models/payment.model");
const FinancialJournal = require("../src/models/financialJournal.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  SCHEME_STATUS,
  SETTLEMENT_WORKFLOW_STATUS,
  JOURNAL_EVENT_TYPES,
} = require("../src/constants/enums");
const { ERROR_CODES } = require("../src/constants/errorCodes");
const { ENTITLEMENT_FORMULA_VERSION } = require("../src/constants/settlementContract");
const { collectPayment } = require("../src/services/payment.service");
const { createScheme, updateSchemeStatus } = require("../src/services/schemeManagement.service");
const {
  previewEntitlement,
  getSettlementDetail,
} = require("../src/services/settlement.service");
const { createCustomer } = require("../src/services/customer.service");
const { getSettlementTotals, getCashPositionSummary } = require("../src/services/cashPosition.service");
const { SETTLEMENT_STAFF_PERMISSIONS } = require("./helpers/staffTestPermissions");
const { runMigrations } = require("../src/migrations/runMigrations");
const migration002 = require("../src/migrations/versions/002_financial_journal_backfill");
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

const maturityTime = () => {
  const window = deriveSchemeWindow(calculateSchemeDates(SCHEME_START));
  return new Date(window.maturityDate.getTime() + 24 * 60 * 60 * 1000);
};

const firstPeriodTime = () => {
  const window = deriveSchemeWindow(calculateSchemeDates(SCHEME_START));
  return new Date(window.startDate.getTime() + 24 * 60 * 60 * 1000);
};

const createAdmin = async () =>
  User.create({
    name: "Phase3 Admin",
    phone: `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("adminpass1", 10),
    role: USER_ROLES.ADMIN,
  });

const createStaff = async () => {
  const staff = await User.create({
    name: "Phase3 Staff",
    phone: `8${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
    passwordHash: await bcrypt.hash("staffpass1", 10),
    role: USER_ROLES.STAFF,
  });
  await StaffProfile.create({
    user: staff._id,
    permissions: SETTLEMENT_STAFF_PERMISSIONS,
  });
  return staff;
};

const seedCustomerScheme = async (admin) => {
  const customer = await createCustomer(
    {
      name: "Phase3 Customer",
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

const pay = async (customer, scheme, actor, amount, method = PAYMENT_METHODS.UPI, at = null) => {
  const schemeDoc = scheme.startDate ? scheme : await Scheme.findById(scheme._id);
  const when =
    at ||
    new Date(new Date(schemeDoc.startDate).getTime() + 24 * 60 * 60 * 1000);
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
  notes: "Phase3 settlement",
  clientRequestId: reqId(),
  payoutMethod: PAYMENT_METHODS.UPI,
  payoutReference: `PAYOUT-${reqId().slice(0, 8)}`,
  ...overrides,
});

describe("Phase 3 settlement and journal", () => {
  before(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: `aj_gold_phase3_${process.pid}`,
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

  it("computes principal-only entitlement deterministically", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 5000);
    await pay(customer, scheme, admin, 3000);

    const preview = await previewEntitlement(scheme._id);
    assert.equal(preview.formulaVersion, ENTITLEMENT_FORMULA_VERSION);
    assert.equal(preview.eligibleContributions, 8000);
    assert.equal(preview.bonus, 0);
    assert.equal(preview.deductions, 0);
    assert.equal(preview.finalEntitlement, 8000);
  });

  it("rejects caller-supplied settlementAmount", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 4000);

    await assert.rejects(
      withMockedNow(maturityTime(), () =>
        updateSchemeStatus(
          scheme._id,
          {
            ...settlePayload(),
            settlementAmount: 9999,
          },
          admin
        )
      ),
      (error) => error.code === ERROR_CODES.SETTLEMENT_AMOUNT_NOT_ALLOWED
    );
  });

  it("rejects settlement before maturity for REDEEMED", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "Future Maturity Customer",
        phone: `6${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
        password: "customer1pass",
      },
      admin
    );
    const futureStart = new Date();
    futureStart.setMonth(futureStart.getMonth() + 2);
    const scheme = await createScheme(
      {
        customerId: customer._id.toString(),
        startDate: futureStart,
        clientRequestId: reqId(),
      },
      admin
    );
    await pay(customer, scheme, admin, 2000);

    await assert.rejects(
      updateSchemeStatus(scheme._id, settlePayload(), admin),
      (error) => error.code === ERROR_CODES.SETTLEMENT_NOT_ELIGIBLE
    );
  });

  it("allows early CLOSED settlement with same principal formula", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(
      {
        name: "Early Close Customer",
        phone: `5${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
        password: "customer1pass",
      },
      admin
    );
    const recentStart = new Date();
    const scheme = await createScheme(
      {
        customerId: customer._id.toString(),
        startDate: recentStart,
        clientRequestId: reqId(),
      },
      admin
    );
    await pay(customer, scheme, admin, 6000);

    const settled = await updateSchemeStatus(
      scheme._id,
      settlePayload({ status: SCHEME_STATUS.CLOSED }),
      admin
    );
    assert.equal(settled.settlement.amount, 6000);
    assert.equal(settled.status, SCHEME_STATUS.CLOSED);
  });

  it("direct settlement writes economic journal effects without authorization self-entry", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 7000, PAYMENT_METHODS.UPI);

    await withMockedNow(maturityTime(), async () => {
      await updateSchemeStatus(
        scheme._id,
        settlePayload({
          payoutMethod: PAYMENT_METHODS.UPI,
          payoutReference: "PAY-REF-001",
        }),
        admin
      );

      const totals = await getSettlementTotals();
      assert.equal(totals.totalCustomerSettlement, 7000);

      const paidEntries = await FinancialJournal.find({
        scheme: scheme._id,
        eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
      });
      assert.equal(paidEntries.length, 1);
      assert.equal(paidEntries[0].amount, 7000);

      const authorizedEntries = await FinancialJournal.find({
        scheme: scheme._id,
        eventType: "SETTLEMENT_AUTHORIZED",
      });
      assert.equal(authorizedEntries.length, 0);
    });
  });

  it("allows settlement without payout reference for UPI and BANK", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 3000);

    await withMockedNow(maturityTime(), async () => {
      const settled = await updateSchemeStatus(
        scheme._id,
        settlePayload({ payoutMethod: PAYMENT_METHODS.BANK, payoutReference: undefined }),
        admin
      );
      assert.equal(settled.settlement.amount, 3000);
      assert.equal(settled.settlement.payoutReference, "");
    });
  });

  it("only one concurrent full settlement succeeds", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 9000);

    const results = await withMockedNow(maturityTime(), () =>
      Promise.allSettled([
        updateSchemeStatus(scheme._id, settlePayload(), admin),
        updateSchemeStatus(scheme._id, settlePayload(), admin),
      ])
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const paidEntries = await FinancialJournal.find({
      scheme: scheme._id,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
    });
    assert.equal(paidEntries.length, 1);
  });

  it("staff can execute full settlement workflow without separate approver", async () => {
    const admin = await createAdmin();
    const staff = await createStaff();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, staff, 4500, PAYMENT_METHODS.CASH);

    const settled = await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(
        scheme._id,
        settlePayload({ payoutMethod: PAYMENT_METHODS.CASH, payoutReference: undefined }),
        staff
      )
    );

    assert.equal(settled.settlement.amount, 4500);
    assert.equal(settled.settlementWorkflow.status, SETTLEMENT_WORKFLOW_STATUS.FINALIZED);
  });

  it("FINALIZED without acknowledgement when payout reference exists", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 2500);

    await withMockedNow(maturityTime(), async () => {
      const payload = settlePayload();
      await updateSchemeStatus(scheme._id, payload, admin);

      const saved = await Scheme.findById(scheme._id);
      assert.equal(saved.settlementWorkflow.status, SETTLEMENT_WORKFLOW_STATUS.FINALIZED);
      assert.equal(saved.status, SCHEME_STATUS.REDEEMED);
    });
  });

  it("journal entries are immutable", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 1000);

    const entry = await FinancialJournal.findOne({ scheme: scheme._id });
    assert.ok(entry);

    await assert.rejects(
      FinancialJournal.updateOne({ _id: entry._id }, { amount: 9999 }),
      /immutable/i
    );
  });

  it("payment collection creates journal entry", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 3200);

    const entries = await FinancialJournal.find({
      scheme: scheme._id,
      eventType: JOURNAL_EVENT_TYPES.COLLECTION_RECEIVED,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].amount, 3200);
  });

  it("legacy backfill inserts journal rows for valid settled scheme", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 5500);

    await Scheme.findByIdAndUpdate(scheme._id, {
      status: SCHEME_STATUS.REDEEMED,
      settlement: {
        amount: 5500,
        settledAt: new Date(),
        settledBy: admin._id,
        notes: "Legacy",
        clientRequestId: "legacy-1",
        totalPaidAtSettlement: 5500,
      },
    });

    await migration002.up(mongoose.connection.db);

    const paid = await FinancialJournal.findOne({
      scheme: scheme._id,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
    });
    assert.ok(paid);
    assert.equal(paid.amount, 5500);
  });

  it("legacy backfill skips ambiguous override settlements", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 5500);

    await Scheme.findByIdAndUpdate(scheme._id, {
      status: SCHEME_STATUS.REDEEMED,
      settlement: {
        amount: 6000,
        settledAt: new Date(),
        settledBy: admin._id,
        notes: "Legacy override",
        overrideReason: "Manual override",
        clientRequestId: "legacy-2",
        totalPaidAtSettlement: 5500,
      },
    });

    await migration002.up(mongoose.connection.db);

    const paid = await FinancialJournal.findOne({
      scheme: scheme._id,
      eventType: JOURNAL_EVENT_TYPES.SETTLEMENT_PAID,
    });
    assert.equal(paid, null);

    const ambiguous = await mongoose.connection.db
      .collection("journal_migration_ambiguous")
      .findOne({ schemeId: scheme._id });
    assert.ok(ambiguous);
  });

  it("admin settlement detail includes entitlement and journal references", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 4100);

    await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), admin)
    );

    const detail = await getSettlementDetail(scheme._id);
    assert.equal(detail.entitlement.finalEntitlement, 4100);
    assert.ok(detail.journalEntries.length >= 3);
    assert.match(detail.settlement.settlementReceiptId, /^AJGK-SET-/);
  });

  it("cash position uses journaled settlement totals", async () => {
    const admin = await createAdmin();
    const { customer, scheme } = await seedCustomerScheme(admin);
    await pay(customer, scheme, admin, 8000, PAYMENT_METHODS.UPI);

    await withMockedNow(maturityTime(), () =>
      updateSchemeStatus(scheme._id, settlePayload(), admin)
    );

    const position = await getCashPositionSummary();
    assert.equal(position.totalCustomerSettlement, 8000);
  });
});
