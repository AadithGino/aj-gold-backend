/**
 * Phase 6 smoke test — role-scoped dashboards and cash position fields.
 * Run: npm run smoke:phase6
 */
const http = require("http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const app = require("../app");
const env = require("../config/env");
const { connectDb } = require("../config/db");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const Customer = require("../models/customer.model");
const Payment = require("../models/payment.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
} = require("../constants/enums");
const { createStaff } = require("../services/staff.service");
const { createCustomer } = require("../services/customer.service");
const { createScheme } = require("../services/schemeManagement.service");
const { collectPayment } = require("../services/payment.service");
const {
  getAdminDashboard,
  getStaffDashboard,
  getCustomerDashboard,
} = require("../services/dashboard.service");

const SMOKE_TAG = "SMOKE-P6";

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
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const assertNoPasswordHash = (value, path = "root", seen = new WeakSet()) => {
  if (value == null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPasswordHash(item, `${path}[${index}]`, seen));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, "passwordHash")) {
    throw new Error(`FAIL: passwordHash leaked at ${path}`);
  }
  Object.entries(value).forEach(([key, child]) => assertNoPasswordHash(child, `${path}.${key}`, seen));
};

const ADMIN_CASH_FIELDS = [
  "cashInVault",
  "totalCashInVault",
  "totalCollectedFromCustomers",
  "totalCashCollectedFromCustomers",
  "totalUpiCollectedFromCustomers",
  "totalBankCollectedFromCustomers",
  "totalCardCollectedFromCustomers",
  "totalCashWithStaff",
  "totalCashSubmittedToVault",
  "totalCustomerPayout",
  "totalCashCustomerPayout",
  "totalUpiCustomerPayout",
  "totalBankCustomerPayout",
  "totalCardCustomerPayout",
  "payoutTrackingImplemented",
];

const cleanupP6 = async ({ customerIds = [], staffUserId, staffProfileId }) => {
  if (customerIds.length) {
    await Payment.deleteMany({ customer: { $in: customerIds } });
    const Scheme = require("../models/scheme.model");
    await Scheme.deleteMany({ customer: { $in: customerIds } });
    const customers = await Customer.find({ _id: { $in: customerIds } }).select("user");
    await Customer.deleteMany({ _id: { $in: customerIds } });
    const userIds = customers.map((c) => c.user).filter(Boolean);
    if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
  }
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
  const staffPhone = `5${String(Date.now()).slice(-9)}`;
  let staffUser = null;
  let staffProfile = null;
  let customer = null;

  try {
    ({ user: staffUser, profile: staffProfile } = await createStaff(
      {
        name: "Smoke P6 Staff",
        phone: staffPhone,
        password: "staff123",
        notes: runTag,
      },
      admin
    ));

    customer = await createCustomer(
      {
        name: "Smoke P6 Customer",
        phone: `4${String(Date.now()).slice(-9)}`,
        address: "Smoke P6 Address",
      },
      admin
    );

    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: new Date("2025-01-01") },
      admin
    );

    await collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 12000,
        paymentMethod: PAYMENT_METHODS.CASH,
        paymentDate: new Date("2025-02-01"),
      },
      staffUser
    );

    const customerUser = await User.findById(customer.user);

    const adminDash = await getAdminDashboard();
    ADMIN_CASH_FIELDS.forEach((field) => {
      assert(Object.prototype.hasOwnProperty.call(adminDash, field), `Admin dashboard has ${field}`);
    });
    assert(adminDash.payoutTrackingImplemented === true, "payoutTrackingImplemented is true");
    assert(
      adminDash.cashInVault === adminDash.totalCashInVault,
      "cashInVault equals totalCashInVault on admin dashboard"
    );
    assert(
      adminDash.cashInVault ===
        adminDash.totalCashSubmittedToVault +
          adminDash.totalUpiCollectedFromCustomers +
          adminDash.totalBankCollectedFromCustomers +
          adminDash.totalCardCollectedFromCustomers -
          adminDash.totalCustomerPayout,
      "Admin dashboard cashInVault formula holds"
    );
    assertNoPasswordHash(adminDash, "adminDashboard");

    const staffDash = await getStaffDashboard(staffUser);
    assert(staffDash.staff._id.toString() === staffUser._id.toString(), "Staff dashboard scoped to logged-in staff");
    assert(typeof staffDash.calculatedCashInHand === "number", "Staff dashboard includes calculatedCashInHand");
    assert(
      staffDash.recentPayments.every(
        (p) => !p.collectedBy || p.collectedBy.name === staffUser.name || p.collectedByRole === USER_ROLES.STAFF
      ),
      "Staff dashboard recent payments are staff-scoped"
    );
    assert(
      staffDash.recentPayments.some((p) => p.amount === 12000),
      "Staff dashboard includes staff-owned payment"
    );
    assertNoPasswordHash(staffDash, "staffDashboard");

    const customerDash = await getCustomerDashboard(customerUser);
    assert(customerDash.passbookNumber === customer.passbookNumber, "Customer dashboard shows own passbook");
    assert(
      customerDash.paymentHistory.some((p) => p.amount === 12000),
      "Customer dashboard includes own payment history"
    );
    assertNoPasswordHash(customerDash, "customerDashboard");

    const server = app.listen(0);
    const port = server.address().port;
    const adminToken = jwt.sign({ id: admin._id, role: admin.role }, env.jwtSecret, { expiresIn: "1h" });
    const staffToken = jwt.sign({ id: staffUser._id, role: staffUser.role }, env.jwtSecret, { expiresIn: "1h" });
    const customerToken = jwt.sign({ id: customerUser._id, role: customerUser.role }, env.jwtSecret, {
      expiresIn: "1h",
    });

    try {
      const adminRes = await requestJson(port, { method: "GET", path: "/api/dashboard/admin", token: adminToken });
      assert(adminRes.status === 200, "GET /api/dashboard/admin returns 200 for admin");
      assertNoPasswordHash(adminRes.body, "adminDashboardHttp");

      const staffOwnRes = await requestJson(port, { method: "GET", path: "/api/dashboard/staff", token: staffToken });
      assert(staffOwnRes.status === 200, "GET /api/dashboard/staff returns 200 for staff");
      assertNoPasswordHash(staffOwnRes.body, "staffDashboardHttp");

      const customerOwnRes = await requestJson(port, {
        method: "GET",
        path: "/api/dashboard/customer",
        token: customerToken,
      });
      assert(customerOwnRes.status === 200, "GET /api/dashboard/customer returns 200 for customer");
      assertNoPasswordHash(customerOwnRes.body, "customerDashboardHttp");

      const staffAdminBlock = await requestJson(port, { method: "GET", path: "/api/dashboard/admin", token: staffToken });
      assert(staffAdminBlock.status === 403, "Staff cannot access admin dashboard");

      const customerAdminBlock = await requestJson(port, {
        method: "GET",
        path: "/api/dashboard/admin",
        token: customerToken,
      });
      assert(customerAdminBlock.status === 403, "Customer cannot access admin dashboard");

      const customerStaffBlock = await requestJson(port, {
        method: "GET",
        path: "/api/dashboard/staff",
        token: customerToken,
      });
      assert(customerStaffBlock.status === 403, "Customer cannot access staff dashboard");
    } finally {
      server.close();
    }

    console.log("\nPhase 6 smoke test completed successfully.");
  } finally {
    await cleanupP6({
      customerIds: customer ? [customer._id] : [],
      staffUserId: staffUser?._id,
      staffProfileId: staffProfile?._id,
    });
  }
};

run()
  .catch((error) => {
    console.error("\nPhase 6 smoke test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
