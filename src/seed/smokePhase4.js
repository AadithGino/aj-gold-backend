/**
 * Phase 4 smoke test — customer and scheme management.
 * Run: npm run smoke:phase4
 */
const http = require("http");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const app = require("../app");
const env = require("../config/env");
const { connectDb } = require("../config/db");
const User = require("../models/user.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const { USER_ROLES, SCHEME_STATUS } = require("../constants/enums");
const {
  createCustomer,
  searchCustomers,
  resetCustomerPassword,
} = require("../services/customer.service");
const { createScheme, updateSchemeStatus } = require("../services/schemeManagement.service");
const { assertCustomerCanCreateActiveScheme } = require("../services/scheme.service");
const ApiError = require("../utils/ApiError");

const SMOKE_TAG = "SMOKE-P4";
const PASSBOOK_FORMAT = /^\d{4}$/;

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

  await connectDb(env.mongoUri);
  const admin = await User.findOne({ role: USER_ROLES.ADMIN });
  assert(Boolean(admin), "Admin user exists");

  const phone = `6${String(Date.now()).slice(-9)}`;
  const phone2 = `5${String(Date.now()).slice(-9)}`;

  const customer = await createCustomer(
    {
      name: "Smoke P4 Customer",
      phone,
      address: "Smoke Address",
      nominee: {
        name: "Nominee",
        phone: "9000000002",
        relationship: "Spouse",
      },
    },
    admin
  );

  const passbookNumber = customer.passbookNumber;
  assert(Boolean(passbookNumber), "Customer created with auto-generated passbookNumber");
  assert(PASSBOOK_FORMAT.test(passbookNumber), "Generated passbookNumber is 4-digit string (0001-9999 format)");

  const linkedUser = await User.findById(customer.user).select("+passwordHash");
  assert(linkedUser?.role === USER_ROLES.CUSTOMER, "Linked customer user created");
  const passwordMatchesPassbook = await bcrypt.compare(passbookNumber, linkedUser.passwordHash);
  assert(passwordMatchesPassbook, "Default customer password uses generated passbookNumber");

  const customer2 = await createCustomer(
    {
      name: "Smoke P4 Customer Two",
      phone: phone2,
      address: "Smoke Address 2",
    },
    admin
  );

  const nextSeq = parseInt(passbookNumber, 10) + 1;
  assert(
    parseInt(customer2.passbookNumber, 10) === nextSeq,
    "Second customer receives next passbook series number"
  );
  assert(PASSBOOK_FORMAT.test(customer2.passbookNumber), "Second passbookNumber is 4-digit string");

  let manualPassbookRejected = false;
  try {
    await createCustomer(
      {
        name: "Manual PB Reject",
        phone: `4${String(Date.now()).slice(-9)}`,
        passbookNumber: "1234",
      },
      admin
    );
  } catch (error) {
    manualPassbookRejected = error instanceof ApiError && error.statusCode === 400;
  }
  assert(manualPassbookRejected, "Manual passbookNumber in create body rejected");

  await resetCustomerPassword(customer._id, "newpass123", admin);
  const userAfterReset = await User.findById(customer.user).select("+passwordHash");
  const resetOk = await bcrypt.compare("newpass123", userAfterReset.passwordHash);
  assert(resetOk, "Customer password reset works");

  const scheme = await createScheme(
    {
      customerId: customer._id.toString(),
      startDate: new Date("2025-01-01"),
    },
    admin
  );

  assert(scheme.enrollmentNumber.startsWith("AJGK-ENR-"), "Scheme created with enrollmentNumber");

  let secondActiveBlocked = false;
  try {
    await assertCustomerCanCreateActiveScheme(customer._id);
  } catch (error) {
    secondActiveBlocked = error instanceof ApiError && error.statusCode === 409;
  }
  assert(secondActiveBlocked, "Second ACTIVE scheme blocked");

  const redeemed = await updateSchemeStatus(
    scheme._id,
    { status: SCHEME_STATUS.REDEEMED, notes: "Smoke redeem" },
    admin
  );
  assert(redeemed.status === SCHEME_STATUS.REDEEMED, "Scheme status updated to REDEEMED");
  assert(
    redeemed.statusHistory.some(
      (entry) => entry.status === SCHEME_STATUS.REDEEMED && entry.changedBy.toString() === admin._id.toString()
    ),
    "statusHistory records actor for REDEEMED"
  );

  const scheme2 = await createScheme({ customerId: customer._id.toString(), startDate: new Date("2026-01-01") }, admin);
  const closed = await updateSchemeStatus(
    scheme2._id,
    { status: SCHEME_STATUS.CLOSED, notes: "Smoke close" },
    admin
  );
  assert(closed.status === SCHEME_STATUS.CLOSED, "Scheme status updated to CLOEED");

  const scheme3 = await createScheme({ customerId: customer._id.toString(), startDate: new Date("2026-02-01") }, admin);
  const withdrawn = await updateSchemeStatus(
    scheme3._id,
    { status: SCHEME_STATUS.WITHDRAWN, notes: "Smoke withdraw" },
    admin
  );
  assert(withdrawn.status === SCHEME_STATUS.WITHDRAWN, "Scheme status updated to WITHDRAWN");

  const byPassbook = await searchCustomers(passbookNumber);
  assert(byPassbook.some((item) => item._id.toString() === customer._id.toString()), "Search by generated passbookNumber");

  const byPhone = await searchCustomers(phone);
  assert(byPhone.some((item) => item._id.toString() === customer._id.toString()), "Search by phone");

  const byName = await searchCustomers("Smoke P4");
  assert(byName.some((item) => item._id.toString() === customer._id.toString()), "Search by name");

  const server = app.listen(0);
  const port = server.address().port;
  const adminToken = jwt.sign({ id: admin._id, role: admin.role }, env.jwtSecret, {
    expiresIn: "1h",
  });

  try {
    const createRes = await requestJson(port, {
      method: "POST",
      path: "/api/customers",
      token: adminToken,
      body: {
        name: "HTTP Smoke Customer",
        phone: `3${String(Date.now()).slice(-9)}`,
        address: "HTTP Address",
      },
    });
    assert(createRes.status === 201, "POST /api/customers without passbookNumber returns 201");
    assert(
      PASSBOOK_FORMAT.test(createRes.body?.data?.passbookNumber),
      "POST /api/customers returns generated passbookNumber in response"
    );

    const httpCustomerId = createRes.body.data._id;
    await Customer.deleteOne({ _id: httpCustomerId });
    await User.deleteOne({ _id: createRes.body.data.user });

    const listRes = await requestJson(port, {
      method: "GET",
      path: `/api/customers?search=${encodeURIComponent(passbookNumber)}`,
      token: adminToken,
    });
    assert(listRes.status === 200, "GET /api/customers returns 200");

    const customerRes = await requestJson(port, {
      method: "GET",
      path: `/api/customers/${customer._id}`,
      token: adminToken,
    });
    assert(customerRes.status === 200, "GET /api/customers/:id returns 200");
    assert(Boolean(customerRes.body?.data?.customer), "Customer detail returns customer profile");
    assert(
      customerRes.body.data.customer.passbookNumber === passbookNumber,
      "Customer detail includes generated passbookNumber"
    );
  } finally {
    server.close();
  }

  await Scheme.deleteMany({ customer: { $in: [customer._id, customer2._id] } });
  await Customer.deleteMany({ _id: { $in: [customer._id, customer2._id] } });
  await User.deleteMany({ _id: { $in: [customer.user, customer2.user] } });

  console.log("\nPhase 4 smoke test completed successfully.");
};

run()
  .catch((error) => {
    console.error("\nPhase 4 smoke test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
