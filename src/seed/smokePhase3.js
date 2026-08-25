/**
 * Phase 3 smoke test — staff management + cash submission (services + HTTP admin guard).
 * Run: npm run smoke:phase3
 */
const http = require("http");
const mongoose = require("mongoose");
const app = require("../app");
const env = require("../config/env");
const { connectDb, CONNECTION_SCHEMA_MODE } = require("../config/db");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const Payment = require("../models/payment.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const CashSubmission = require("../models/cashSubmission.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
} = require("../constants/enums");
const { createStaff, listStaff, getStaffDetail } = require("../services/staff.service");
const { createCashSubmission } = require("../services/cash.service");
const { getStaffCashInHand } = require("../services/staffCash.service");
const { collectPayment } = require("../services/payment.service");
const { clientRequestId } = require("./smokeHelpers");
const { generateReceiptNumber } = require("../services/receipt.service");
const { calculateSchemeDates, createEnrollmentNumber } = require("../services/scheme.service");

const SMOKE_TAG = "SMOKE-P3";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
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
    if (payload) {
      req.write(payload);
    }
    req.end();
  });

const run = async () => {
  if (!env.mongoUri || !env.jwtSecret) {
    throw new Error("MONGO_URI and JWT_SECRET are required.");
  }

  await connectDb({ uri: env.mongoUri, schemaMode: CONNECTION_SCHEMA_MODE.RUNTIME });

  const admin = await User.findOne({ role: USER_ROLES.ADMIN });
  assert(Boolean(admin), "Admin user exists");

  assert(
    StaffProfile.schema.path("cashInHand") === undefined,
    "StaffProfile has no stored cashInHand field (ledger-based only)"
  );

  const runTag = `${SMOKE_TAG}-${Date.now()}`;
  const staffPhone = `8${String(Date.now()).slice(-9)}`;
  const { user: staffUser, profile: staffProfile } = await createStaff(
    {
      name: "Smoke Staff",
      phone: staffPhone,
      password: "staff123",
      permissions: { canCollectPayment: true },
      notes: runTag,
    },
    admin
  );

  assert(staffUser.role === USER_ROLES.STAFF, "Created user has STAFF role");
  assert(staffProfile.employeeCode.startsWith("AJGK-STF-"), "Employee code auto-generated");

  const staffList = await listStaff({ search: staffPhone });
  assert(staffList.items.some((item) => item.staffUserId.toString() === staffUser._id.toString()), "Staff appears in list");

  const passbookNumber = `${runTag}-PB`;
  const customer = await Customer.create({
    customerCode: `${runTag}-CUST`,
    passbookNumber,
    name: "Smoke P3 Customer",
    phone: `7${String(Date.now()).slice(-9)}`,
    createdBy: admin._id,
    updatedBy: admin._id,
  });

  const dates = calculateSchemeDates(new Date());
  const scheme = await Scheme.create({
    customer: customer._id,
    enrollmentNumber: await createEnrollmentNumber(),
    startDate: dates.startDate,
    sixMonthDate: dates.sixMonthDate,
    maturityDate: dates.maturityDate,
    status: SCHEME_STATUS.ACTIVE,
    createdBy: admin._id,
  });

  await collectPayment(
    {
      customer: customer._id,
      scheme: scheme._id,
      amount: 15000,
      paymentMethod: PAYMENT_METHODS.CASH,
      receiptNumber: await generateReceiptNumber(),
      clientRequestId: clientRequestId(),
    },
    staffUser
  );

  const beforeSubmission = await getStaffCashInHand(staffUser._id);
  assert(beforeSubmission.cashInHand === 15000, "Staff cash in hand before submission is 15000");

  const { submission, cashSummary } = await createCashSubmission(
    {
      staff: staffUser._id,
      submittedAmount: 5000,
      submissionDate: new Date(),
      receivedBy: "Admin User",
      notes: SMOKE_TAG,
      clientRequestId: clientRequestId(),
    },
    admin
  );

  assert(submission.submittedAmount === 5000, "Cash submission created");
  assert(cashSummary.cashInHand === 10000, "Cash in hand after submission is 10000 (calculated, not stored)");

  const detail = await getStaffDetail(staffUser._id);
  assert(detail.collections.today >= 15000, "Staff detail shows today collection");
  assert(detail.cashInHand === 10000, "Staff detail cash in hand matches calculated value");
  assert(Array.isArray(detail.cashSubmissionHistory), "Staff detail includes cash submission history");

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const adminLogin = await requestJson(port, {
      method: "POST",
      path: "/api/auth/login",
      body: {
        phone: admin.phone,
        password: process.env.DEFAULT_ADMIN_PASSWORD || "admin123",
      },
    });
    assert(adminLogin.status === 200, "Admin login succeeds for HTTP guard checks");
    const adminAuthToken = adminLogin.body?.data?.token;

    const adminList = await requestJson(port, {
      method: "GET",
      path: "/api/admin/staff",
      token: adminAuthToken,
    });
    assert(adminList.status === 200, "GET /api/admin/staff returns 200 for admin");

    const staffLogin = await requestJson(port, {
      method: "POST",
      path: "/api/auth/login",
      body: {
        phone: staffPhone,
        password: "staff123",
      },
    });
    assert(staffLogin.status === 200, "Staff login succeeds for forbidden-route check");

    const forbidden = await requestJson(port, {
      method: "GET",
      path: "/api/admin/staff",
      token: staffLogin.body?.data?.token,
    });
    assert(forbidden.status === 403, "Non-admin blocked from admin routes");

    const cashSubmitHttp = await requestJson(port, {
      method: "POST",
      path: "/api/admin/cash-submissions",
      token: adminAuthToken,
      body: {
        staff: staffUser._id.toString(),
        submittedAmount: 2000,
        submissionDate: new Date().toISOString(),
        receivedBy: "Admin User",
        notes: SMOKE_TAG,
        clientRequestId: clientRequestId(),
      },
    });
    assert(cashSubmitHttp.status === 201, "POST /api/admin/cash-submissions returns 201");
    const afterHttpCash = await getStaffCashInHand(staffUser._id);
    assert(
      afterHttpCash.cashInHand === 8000,
      `Calculated cash in hand after HTTP submission is 8000 (got ${afterHttpCash.cashInHand})`
    );
  } finally {
    server.close();
  }

  // Cleanup
  await CashSubmission.deleteMany({ notes: runTag });
  await Payment.deleteMany({ collectedBy: staffUser._id });
  await Scheme.deleteOne({ _id: scheme._id });
  await Customer.deleteOne({ _id: customer._id });
  await StaffProfile.deleteOne({ _id: staffProfile._id });
  await User.deleteOne({ _id: staffUser._id });

  console.log("\nPhase 3 smoke test completed successfully.");
};

run()
  .catch((error) => {
    console.error("\nPhase 3 smoke test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
