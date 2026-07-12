/**
 * Cash Vault Demo Seed — Post-Phase-8 Cash in Vault formula verification
 *
 * Clears all app collections, resets counters, seeds clean demo data.
 *
 * Run: npm run seed:cash-vault-demo
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const env = require("../config/env");
const User = require("../models/user.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const Payment = require("../models/payment.model");
const CashSubmission = require("../models/cashSubmission.model");
const PaymentCorrection = require("../models/paymentCorrection.model");
const StaffProfile = require("../models/staffProfile.model");
const ReceiptCounter = require("../models/receiptCounter.model");
const AuditLog = require("../models/auditLog.model");
const Notification = require("../models/notification.model");
const {
  USER_ROLES,
  USER_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
} = require("../constants/enums");
const { createStaff } = require("../services/staff.service");
const { createCustomer } = require("../services/customer.service");
const { createScheme, updateSchemeStatus } = require("../services/schemeManagement.service");
const { collectPayment } = require("../services/payment.service");
const { createCashSubmission } = require("../services/cash.service");
const { getStaffCashInHand } = require("../services/staffCash.service");
const { getTotalPaidForScheme } = require("../services/paymentLimit.service");
const { clientRequestId } = require("./smokeHelpers");
const { getCashPositionSummary } = require("../services/cashPosition.service");
const { getAdminDashboard } = require("../services/dashboard.service");
const {
  getCollectionReport,
  getCashPositionReport,
  getStaffPerformanceReport,
  getCustomerLedger,
  getSchemeLedger,
} = require("../services/report.service");

const ADMIN_PHONE = "9999999999";
const ADMIN_PASSWORD = "admin123";
const STAFF_PASSWORD = "agent123";

const STAFF = [
  {
    key: "arun",
    name: "Arun Nair",
    phone: "9847011001",
    submission: 200000,
  },
  {
    key: "sreeshma",
    name: "Sreeshma Menon",
    phone: "9847011002",
    submission: 150000,
  },
];

const CUSTOMERS = [
  {
    key: "anjali",
    name: "Anjali Nambiar",
    phone: "9847110001",
    owner: "arun",
    address: "Pattom, Thiruvananthapuram, Kerala",
    splits: {
      CASH: { total: 40000, count: 4 },
      UPI: { total: 20000, count: 2 },
      BANK: { total: 10000, count: 2 },
      CARD: { total: 10000, count: 2 },
    },
  },
  {
    key: "rahul",
    name: "Rahul Warrier",
    phone: "9847110002",
    owner: "arun",
    address: "Marine Drive, Kochi, Kerala",
    splits: {
      CASH: { total: 70000, count: 5 },
      UPI: { total: 30000, count: 3 },
      BANK: { total: 20000, count: 1 },
      CARD: { total: 10000, count: 1 },
    },
  },
  {
    key: "deepak",
    name: "Deepak Menon",
    phone: "9847110003",
    owner: "arun",
    address: "SM Street, Kozhikode, Kerala",
    splits: {
      CASH: { total: 80000, count: 4 },
      UPI: { total: 30000, count: 2 },
      BANK: { total: 20000, count: 2 },
      CARD: { total: 20000, count: 2 },
    },
  },
  {
    key: "meera",
    name: "Meera Krishnan",
    phone: "9847110004",
    owner: "arun",
    address: "Swaraj Round, Thrissur, Kerala",
    splits: {
      CASH: { total: 90000, count: 5 },
      UPI: { total: 20000, count: 2 },
      BANK: { total: 20000, count: 2 },
      CARD: { total: 10000, count: 1 },
    },
  },
  {
    key: "suresh",
    name: "Suresh Pillai",
    phone: "9847110005",
    owner: "sreeshma",
    address: "Alappuzha Beach Road, Kerala",
    splits: {
      CASH: { total: 100000, count: 5 },
      UPI: { total: 30000, count: 2 },
      BANK: { total: 20000, count: 2 },
      CARD: { total: 10000, count: 1 },
    },
  },
  {
    key: "fathima",
    name: "Fathima Rahman",
    phone: "9847110006",
    owner: "sreeshma",
    address: "Kozhikode Beach, Kerala",
    splits: {
      CASH: { total: 50000, count: 4 },
      UPI: { total: 20000, count: 2 },
      BANK: { total: 10000, count: 2 },
      CARD: { total: 10000, count: 2 },
    },
  },
  {
    key: "joseph",
    name: "Joseph Varghese",
    phone: "9847110007",
    owner: "sreeshma",
    address: "Pala, Kottayam, Kerala",
    splits: {
      CASH: { total: 70000, count: 4 },
      UPI: { total: 30000, count: 2 },
      BANK: { total: 20000, count: 2 },
      CARD: { total: 10000, count: 2 },
    },
  },
];

const PAYMENT_DATES = [
  "2024-04-05T10:00:00.000Z",
  "2024-04-20T10:00:00.000Z",
  "2024-05-05T10:00:00.000Z",
  "2024-05-20T10:00:00.000Z",
  "2024-06-05T10:00:00.000Z",
  "2024-06-20T10:00:00.000Z",
  "2024-07-05T10:00:00.000Z",
  "2024-07-20T10:00:00.000Z",
  "2025-03-05T10:00:00.000Z",
  "2025-03-20T10:00:00.000Z",
];

const EXPECTED = {
  paymentCount: 70,
  totalCollectedFromCustomers: 880000,
  totalCashCollectedFromCustomers: 500000,
  totalUpiCollectedFromCustomers: 180000,
  totalBankCollectedFromCustomers: 120000,
  totalCardCollectedFromCustomers: 80000,
  totalCashSubmittedToVault: 350000,
  totalCashWithStaff: 150000,
  totalCustomerSettlement: 580000,
  cashInVault: 150000,
};

const REDEMPTION_CUSTOMER_KEYS = ["meera", "deepak", "suresh", "joseph"];

const log = (msg) => console.log(msg);
const fail = (msg) => {
  throw new Error(`FAIL: ${msg}`);
};
const assertEq = (actual, expected, label) => {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
  log(`PASS: ${label} = ${actual}`);
};

const formatINR = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

const splitEqual = (total, count) => {
  const base = Math.floor(total / count);
  const rem = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
};

const buildPaymentPlan = (splits) => {
  const payments = [];
  let dateIdx = 0;
  for (const method of ["CASH", "UPI", "BANK", "CARD"]) {
    const cfg = splits[method];
    if (!cfg) continue;
    const amounts = splitEqual(cfg.total, cfg.count);
    for (const amount of amounts) {
      payments.push({
        amount,
        paymentMethod: PAYMENT_METHODS[method],
        paymentDate: new Date(PAYMENT_DATES[dateIdx]),
        transactionReference:
          method === "CASH" ? "" : `${method}-CVD-${dateIdx + 1}`,
        notes: `Cash vault demo — ${method}`,
      });
      dateIdx += 1;
    }
  }
  return payments;
};

const clearDatabase = async () => {
  log("\nClearing all app collections...");
  await Promise.all([
    PaymentCorrection.deleteMany({}),
    Payment.deleteMany({}),
    CashSubmission.deleteMany({}),
    Scheme.deleteMany({}),
    Customer.deleteMany({}),
    StaffProfile.deleteMany({}),
    User.deleteMany({}),
    AuditLog.deleteMany({}),
    Notification.deleteMany({}),
    ReceiptCounter.deleteMany({}),
  ]);
  log("✓ Database cleared and counters reset");
};

const ensureAdmin = async () => {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const admin = await User.create({
    name: "Admin",
    phone: ADMIN_PHONE,
    passwordHash,
    role: USER_ROLES.ADMIN,
    status: USER_STATUS.ACTIVE,
  });
  log(`✓ Admin created (${ADMIN_PHONE} / ${ADMIN_PASSWORD})`);
  return admin;
};

const verifyCashPosition = async (cash) => {
  assertEq(await Payment.countDocuments({ status: PAYMENT_STATUS.SUCCESS }), EXPECTED.paymentCount, "payment count");
  assertEq(cash.totalCollectedFromCustomers, EXPECTED.totalCollectedFromCustomers, "totalCollectedFromCustomers");
  assertEq(cash.totalCashCollectedFromCustomers, EXPECTED.totalCashCollectedFromCustomers, "totalCashCollectedFromCustomers");
  assertEq(cash.totalUpiCollectedFromCustomers, EXPECTED.totalUpiCollectedFromCustomers, "totalUpiCollectedFromCustomers");
  assertEq(cash.totalBankCollectedFromCustomers, EXPECTED.totalBankCollectedFromCustomers, "totalBankCollectedFromCustomers");
  assertEq(cash.totalCardCollectedFromCustomers, EXPECTED.totalCardCollectedFromCustomers, "totalCardCollectedFromCustomers");
  assertEq(cash.totalCashSubmittedToVault, EXPECTED.totalCashSubmittedToVault, "totalCashSubmittedToVault");
  assertEq(cash.totalCashWithStaff, EXPECTED.totalCashWithStaff, "totalCashWithStaff");
  assertEq(cash.totalCustomerSettlement, EXPECTED.totalCustomerSettlement, "totalCustomerSettlement");
  assertEq(cash.cashInVault, EXPECTED.cashInVault, "cashInVault");
  assertEq(cash.totalCashInVault, EXPECTED.cashInVault, "totalCashInVault");
  if (cash.totalCustomerMoneyHeld != null) {
    assertEq(cash.totalCustomerMoneyHeld, EXPECTED.cashInVault, "totalCustomerMoneyHeld");
  }

  const moneyPosition = cash.cashInVault + cash.totalCashWithStaff;
  assertEq(moneyPosition, 300000, "cashInVault + totalCashWithStaff");
  assertEq(
    cash.totalCollectedFromCustomers - cash.totalCustomerSettlement,
    300000,
    "totalCollectedFromCustomers - totalCustomerSettlement"
  );

  const formula =
    cash.totalCashSubmittedToVault +
    (cash.totalAdminCashCollected || 0) +
    cash.totalUpiCollectedFromCustomers +
    cash.totalBankCollectedFromCustomers +
    cash.totalCardCollectedFromCustomers -
    cash.totalCustomerSettlement;
  assertEq(cash.cashInVault, formula, "cashInVault formula");
};

const run = async () => {
  if (!env.mongoUri) {
    fail("MONGO_URI is required.");
  }

  log("\nAJ Gold — Cash Vault Demo Seed\n");

  await connectDb(env.mongoUri);
  await clearDatabase();
  const admin = await ensureAdmin();

  const staffUsers = {};
  for (const agent of STAFF) {
    const { user } = await createStaff(
      {
        name: agent.name,
        phone: agent.phone,
        password: STAFF_PASSWORD,
        permissions: { canCreateCustomer: true, canCollectPayment: true },
        notes: "Cash vault demo agent",
      },
      admin
    );
    staffUsers[agent.key] = user;
    log(`✓ Staff: ${agent.name} (${agent.phone})`);
  }

  const customerRecords = {};
  const schemeRecords = {};

  for (const c of CUSTOMERS) {
    const customer = await createCustomer(
      {
        name: c.name,
        phone: c.phone,
        address: c.address,
        nominee: { name: `${c.name} Nominee`, phone: c.phone, relationship: "Family" },
      },
      admin
    );
    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: new Date("2024-03-01") },
      admin
    );
    customerRecords[c.key] = customer;
    schemeRecords[c.key] = scheme;
    log(`✓ Customer: ${c.name} — passbook ${customer.passbookNumber}`);
    log(`  ↳ ${scheme.enrollmentNumber}`);
  }

  log("\nCreating 70 payments (10 per customer)...\n");

  for (const c of CUSTOMERS) {
    const plan = buildPaymentPlan(c.splits);
    if (plan.length !== 10) {
      fail(`Expected 10 payments for ${c.key}, got ${plan.length}`);
    }
    const collector = staffUsers[c.owner];
    for (const entry of plan) {
      await collectPayment(
        {
          customer: customerRecords[c.key]._id.toString(),
          scheme: schemeRecords[c.key]._id.toString(),
          amount: entry.amount,
          paymentMethod: entry.paymentMethod,
          paymentDate: entry.paymentDate,
          transactionReference: entry.transactionReference,
          notes: entry.notes,
          clientRequestId: clientRequestId(),
        },
        collector
      );
    }
    const total = plan.reduce((s, p) => s + p.amount, 0);
    log(`✓ ${c.name}: 10 payments — ${formatINR(total)}`);
  }

  log("\nRecording cash submissions...\n");
  for (const agent of STAFF) {
    await createCashSubmission(
      {
        staff: staffUsers[agent.key]._id,
        submittedAmount: agent.submission,
        submissionDate: new Date("2026-07-21"),
        receivedBy: "Admin User",
        notes: "Cash vault demo submission",
        clientRequestId: clientRequestId(),
      },
      admin
    );
    const cash = await getStaffCashInHand(staffUsers[agent.key]._id);
    log(`✓ ${agent.name} submitted ${formatINR(agent.submission)} — cash with staff ${formatINR(cash.cashInHand)}`);
  }

  log("\nRedeeming 4 schemes (settlement via status)...\n");
  for (const customerKey of REDEMPTION_CUSTOMER_KEYS) {
    const customer = customerRecords[customerKey];
    const scheme = schemeRecords[customerKey];
    const totalPaid = await getTotalPaidForScheme(scheme._id);
    await updateSchemeStatus(
      scheme._id,
      {
        status: "REDEEMED",
        notes: "Cash vault demo redemption",
        settlementAmount: totalPaid,
        clientRequestId: clientRequestId(),
      },
      admin
    );
    log(`✓ ${customer.name}: scheme ${scheme.enrollmentNumber} marked REDEEMED`);
  }

  log("\n--- Verification ---\n");

  const cashPosition = await getCashPositionSummary();
  await verifyCashPosition(cashPosition);

  const adminDash = await getAdminDashboard();
  assertEq(adminDash.cashInVault, EXPECTED.cashInVault, "admin dashboard cashInVault");
  log("PASS: GET /api/dashboard/admin equivalent (getAdminDashboard)");

  const cashReport = await getCashPositionReport();
  assertEq(cashReport.cashInVault, EXPECTED.cashInVault, "cash-position report cashInVault");
  log("PASS: GET /api/reports/cash-position equivalent");

  const collectionReport = await getCollectionReport({}, admin);
  assertEq(collectionReport.totalCollection, EXPECTED.totalCollectedFromCustomers, "collections report total");
  log("PASS: GET /api/reports/collections equivalent");

  const staffPerf = await getStaffPerformanceReport({});
  assertEq(staffPerf.staff.length, 2, "staff performance staff count");
  log("PASS: GET /api/reports/staff-performance equivalent");

  const meeraLedger = await getCustomerLedger(customerRecords.meera._id);
  assertEq(meeraLedger.totalPaid, 140000, "Meera customer ledger totalPaid");
  assertEq(meeraLedger.totalSettled, 140000, "Meera customer ledger totalSettled");
  assertEq(meeraLedger.netBalance, 0, "Meera customer ledger netBalance");
  log("PASS: customer ledger for Meera");

  const sureshLedger = await getSchemeLedger(schemeRecords.suresh._id);
  assertEq(sureshLedger.totalPaid, 160000, "Suresh scheme ledger totalPaid");
  assertEq(sureshLedger.totalSettled, 160000, "Suresh scheme ledger totalSettled");
  assertEq(sureshLedger.netBalance, 0, "Suresh scheme ledger netBalance");
  log("PASS: scheme ledger for Suresh");

  log("\n--- Login credentials ---\n");
  log(`Admin:  ${ADMIN_PHONE} / ${ADMIN_PASSWORD}`);
  for (const agent of STAFF) {
    log(`${agent.name}: ${agent.phone} / ${STAFF_PASSWORD}`);
  }
  log("\nCustomers (phone / passbook password):");
  for (const c of CUSTOMERS) {
    const rec = customerRecords[c.key];
    log(`  ${rec.name}: ${rec.phone} / ${rec.passbookNumber}`);
  }

  log("\n--- Expected summary ---\n");
  log(`Total Collection:    ${formatINR(EXPECTED.totalCollectedFromCustomers)}`);
  log(`Cash Collection:     ${formatINR(EXPECTED.totalCashCollectedFromCustomers)}`);
  log(`UPI Collection:      ${formatINR(EXPECTED.totalUpiCollectedFromCustomers)}`);
  log(`Bank Collection:     ${formatINR(EXPECTED.totalBankCollectedFromCustomers)}`);
  log(`Card Collection:     ${formatINR(EXPECTED.totalCardCollectedFromCustomers)}`);
  log(`Cash Submitted:      ${formatINR(EXPECTED.totalCashSubmittedToVault)}`);
  log(`Cash With Staff:     ${formatINR(EXPECTED.totalCashWithStaff)}`);
  log(`Cash in Vault:       ${formatINR(EXPECTED.cashInVault)}`);
  log(`Total Settlement:  ${formatINR(EXPECTED.totalCustomerSettlement)}`);

  log("\nCash vault demo seed completed successfully.\n");
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("\nCash vault demo seed failed:", err.message || err);
  mongoose.disconnect().finally(() => process.exit(1));
});
