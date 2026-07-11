/**
 * Phase 7 smoke test — reports and maturity calendar.
 * Run: npm run smoke:phase7
 */
const http = require("http");
const jwt = require("jsonwebtoken");
const dayjs = require("dayjs");
const mongoose = require("mongoose");
const app = require("../app");
const env = require("../config/env");
const { connectDb } = require("../config/db");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const Customer = require("../models/customer.model");
const Payment = require("../models/payment.model");
const CashSubmission = require("../models/cashSubmission.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
} = require("../constants/enums");
const { createStaff } = require("../services/staff.service");
const { createCustomer } = require("../services/customer.service");
const { createScheme } = require("../services/schemeManagement.service");
const { collectPayment, reversePayment } = require("../services/payment.service");
const { createCashSubmission } = require("../services/cash.service");
const {
  getCollectionReport,
  getStaffPerformanceReport,
  getCashPositionReport,
  getMaturityCalendar,
  getCustomerLedger,
  getSchemeLedger,
} = require("../services/report.service");

const SMOKE_TAG = "SMOKE-P7";
const PASSBOOK_FORMAT = /^\d{4}$/;

const assert = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
};

const requestJson = (port, { method, path, token, body }) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const cleanupP7 = async ({ customerIds = [], staffUserId, staffProfileId, submissionIds = [] }) => {
  if (customerIds.length) {
    await Payment.deleteMany({ customer: { $in: customerIds } });
    const Scheme = require("../models/scheme.model");
    await Scheme.deleteMany({ customer: { $in: customerIds } });
    const customers = await Customer.find({ _id: { $in: customerIds } }).select("user");
    await Customer.deleteMany({ _id: { $in: customerIds } });
    const userIds = customers.map((c) => c.user).filter(Boolean);
    if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
  }
  if (submissionIds.length) await CashSubmission.deleteMany({ _id: { $in: submissionIds } });
  if (staffUserId) await Payment.deleteMany({ collectedBy: staffUserId });
  if (staffProfileId) await StaffProfile.deleteOne({ _id: staffProfileId });
  if (staffUserId) await User.deleteOne({ _id: staffUserId });
};

const run = async () => {
  if (!env.mongoUri || !env.jwtSecret) {
    throw new Error("MONGO_URI and JWT_SECRET are required.");
  }

  await connectDb(env.mongoUri);

  const admin = await User.findOne({ role: USER_ROLES.ADMIN });
  assert(Boolean(admin), "Admin user exists");

  const runTag = `${SMOKE_TAG}-${Date.now()}`;
  const staffPhone = `8${String(Date.now()).slice(-9)}`;
  let staffUser = null;
  let staffProfile = null;
  let customer = null;
  let scheme = null;
  let cashPayment = null;
  let submissionId = null;

  try {
    ({ user: staffUser, profile: staffProfile } = await createStaff(
      {
        name: "Smoke P7 Staff",
        phone: staffPhone,
        password: "staff123",
        notes: runTag,
      },
      admin
    ));

    customer = await createCustomer(
      {
        name: "Smoke P7 Customer",
        phone: `9${String(Date.now()).slice(-9)}`,
        address: "Smoke P7 Address",
      },
      admin
    );

    assert(Boolean(customer.passbookNumber), "Customer created without manual passbook");
    assert(PASSBOOK_FORMAT.test(customer.passbookNumber), "Passbook auto-generated (4-digit)");

    const schemeStart = dayjs().subtract(10, "month").startOf("month").toDate();
    scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: schemeStart },
      admin
    );
    assert(scheme.enrollmentNumber.startsWith("AJGK-ENR-"), "Scheme created with enrollmentNumber");

    cashPayment = (
      await collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 10000,
          paymentMethod: PAYMENT_METHODS.CASH,
          paymentDate: new Date("2025-02-01"),
        },
        staffUser
      )
    ).payment;

    await collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 20000,
        paymentMethod: PAYMENT_METHODS.CASH,
        paymentDate: new Date("2025-03-01"),
      },
      staffUser
    );

    for (const [method, amount] of [
      [PAYMENT_METHODS.UPI, 5000],
      [PAYMENT_METHODS.BANK, 3000],
      [PAYMENT_METHODS.CARD, 2000],
    ]) {
      await collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount,
          paymentMethod: method,
          paymentDate: new Date("2025-04-01"),
          transactionReference: `${runTag}-${method}`,
        },
        staffUser
      );
    }

    await reversePayment(
      cashPayment._id,
      { reason: `${runTag} reversal`, notes: "Smoke reverse" },
      admin
    );

    const { submission } = await createCashSubmission(
      {
        staff: staffUser._id,
        submittedAmount: 5000,
        submissionDate: new Date(),
        receivedBy: "Admin User",
        notes: runTag,
      },
      admin
    );
    submissionId = submission._id;

    const expectedTotals = {
      CASH: 20000,
      UPI: 5000,
      BANK: 3000,
      CARD: 2000,
    };
    const expectedTotal = 30000;

    const collectionReport = await getCollectionReport({ customerId: customer._id.toString() }, admin);
    assert(collectionReport.totalCollection === expectedTotal, "Collection report total excludes reversed payment");
    assert(collectionReport.methodTotals.CASH === expectedTotals.CASH, "Collection CASH total correct");
    assert(collectionReport.methodTotals.UPI === expectedTotals.UPI, "Collection UPI total correct");
    assert(collectionReport.methodTotals.BANK === expectedTotals.BANK, "Collection BANK total correct");
    assert(collectionReport.methodTotals.CARD === expectedTotals.CARD, "Collection CARD total correct");
    assert(collectionReport.reversedPaymentCount >= 1, "Collection report includes reversed count");
    assert(
      collectionReport.payments.every((p) => p.status !== PAYMENT_STATUS.REVERSED),
      "Default collection list excludes reversed payments"
    );
    assert(
      collectionReport.payments.some((p) => p.passbookNumber === customer.passbookNumber),
      "Collection payment list includes passbookNumber"
    );

    const staffCollection = await getCollectionReport({}, staffUser);
    assert(staffCollection.totalCollection === expectedTotal, "Staff collection report scoped to own payments");
    assert(
      staffCollection.payments.every((p) => p.collectedBy?._id?.toString() === staffUser._id.toString()),
      "Staff collection list only own payments"
    );

    const staffPerf = await getStaffPerformanceReport({ staffId: staffUser._id.toString() });
    const smokeStaffRow = staffPerf.staff.find((s) => s.staffUserId.toString() === staffUser._id.toString());
    assert(Boolean(smokeStaffRow), "Staff performance report includes smoke staff");
    assert(smokeStaffRow.totalCollected === expectedTotal, "Staff performance total collected correct");
    assert(smokeStaffRow.cashCollected === expectedTotals.CASH, "Staff performance cash collected correct");
    assert(typeof smokeStaffRow.cashInHand === "number", "Staff performance includes cash in hand");
    assert(smokeStaffRow.submittedCash >= 5000, "Staff performance includes submitted cash");

    const cashPosition = await getCashPositionReport();
    assert(typeof cashPosition.cashInVault === "number", "Cash position has cashInVault");
    assert(typeof cashPosition.totalCollectedFromCustomers === "number", "Cash position has totalCollectedFromCustomers");
    assert(typeof cashPosition.totalCashInVault === "number", "Cash position has totalCashInVault");
    assert(cashPosition.totalCashInVault === cashPosition.cashInVault, "totalCashInVault equals cashInVault");
    assert(cashPosition.settlementTrackingImplemented === true, "Cash position settlementTrackingImplemented is true");
    assert(typeof cashPosition.totalCustomerSettlement === "number", "Cash position has totalCustomerSettlement");
    assert(typeof cashPosition.totalCashCustomerSettlement === "number", "Cash position has totalCashCustomerSettlement");
    assert(
      cashPosition.cashInVault ===
        cashPosition.totalCashSubmittedToVault +
          (cashPosition.totalAdminCashCollected || 0) +
          cashPosition.totalUpiCollectedFromCustomers +
          cashPosition.totalBankCollectedFromCustomers +
          cashPosition.totalCardCollectedFromCustomers -
          cashPosition.totalCustomerSettlement,
      "Cash position cashInVault formula holds"
    );

    const matFrom = dayjs().startOf("day").toISOString();
    const matTo = dayjs().add(3, "month").endOf("day").toISOString();
    const maturity = await getMaturityCalendar({ from: matFrom, to: matTo });
    assert(
      maturity.entries.some((e) => e.enrollmentNumber === scheme.enrollmentNumber),
      "Maturity calendar returns scheme in range"
    );
    assert(Boolean(maturity.groupedByMonth), "Maturity calendar grouped by month");

    const customerLedger = await getCustomerLedger(customer._id);
    assert(customerLedger.passbookNumber === customer.passbookNumber, "Customer ledger includes passbook");
    assert(
      customerLedger.paymentsByScheme.some((g) => g.enrollmentNumber === scheme.enrollmentNumber),
      "Customer ledger includes enrollment per scheme"
    );

    const schemeLedger = await getSchemeLedger(scheme._id);
    assert(schemeLedger.totalPaid > 0, "Scheme ledger includes total paid");
    assert(Array.isArray(schemeLedger.successfulPayments), "Scheme ledger includes successful payments");
    assert(schemeLedger.successfulPayments.length >= 4, "Scheme ledger lists success payments");
    assert(
      schemeLedger.reversedPayments.some((p) => p.receiptNumber === cashPayment.receiptNumber),
      "Scheme ledger lists reversed payments separately"
    );
    assert(Array.isArray(schemeLedger.scheme.statusHistory), "Scheme ledger includes status history");

    const customerUser = await User.findById(customer.user);
    const server = app.listen(0);
    const port = server.address().port;
    const adminToken = jwt.sign({ id: admin._id, role: admin.role }, env.jwtSecret, { expiresIn: "1h" });
    const staffToken = jwt.sign({ id: staffUser._id, role: staffUser.role }, env.jwtSecret, { expiresIn: "1h" });
    const customerToken = jwt.sign({ id: customerUser._id, role: customerUser.role }, env.jwtSecret, {
      expiresIn: "1h",
    });

    try {
      const adminCollections = await requestJson(port, {
        method: "GET",
        path: "/api/reports/collections",
        token: adminToken,
      });
      assert(adminCollections.status === 200, "Admin GET /api/reports/collections returns 200");

      const staffCollectionsHttp = await requestJson(port, {
        method: "GET",
        path: "/api/reports/collections",
        token: staffToken,
      });
      assert(staffCollectionsHttp.status === 200, "Staff GET /api/reports/collections returns 200");

      const staffCashBlock = await requestJson(port, {
        method: "GET",
        path: "/api/reports/cash-position",
        token: staffToken,
      });
      assert(staffCashBlock.status === 403, "Staff blocked from cash-position report");

      const staffPerfBlock = await requestJson(port, {
        method: "GET",
        path: "/api/reports/staff-performance",
        token: staffToken,
      });
      assert(staffPerfBlock.status === 403, "Staff blocked from staff-performance report");

      const staffSchemesBlock = await requestJson(port, {
        method: "GET",
        path: "/api/reports/schemes",
        token: staffToken,
      });
      assert(staffSchemesBlock.status === 403, "Staff blocked from schemes report");

      const staffMaturityBlock = await requestJson(port, {
        method: "GET",
        path: "/api/reports/maturity-calendar",
        token: staffToken,
      });
      assert(staffMaturityBlock.status === 403, "Staff blocked from maturity-calendar report");

      const staffLedgerOk = await requestJson(port, {
        method: "GET",
        path: `/api/reports/customer-ledger/${customer._id}`,
        token: staffToken,
      });
      assert(staffLedgerOk.status === 200, "Staff can access customer ledger");

      const customerReportsBlock = await requestJson(port, {
        method: "GET",
        path: "/api/reports/collections",
        token: customerToken,
      });
      assert(customerReportsBlock.status === 403, "Customer blocked from report routes");
    } finally {
      server.close();
    }

    console.log("\nPhase 7 smoke test completed successfully.");
  } finally {
    await cleanupP7({
      customerIds: customer ? [customer._id] : [],
      staffUserId: staffUser?._id,
      staffProfileId: staffProfile?._id,
      submissionIds: submissionId ? [submissionId] : [],
    });
  }
};

run()
  .catch((error) => {
    console.error("\nPhase 7 smoke test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
