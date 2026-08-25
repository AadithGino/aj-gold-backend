require("dotenv").config({ path: ".env.demo" });

const http = require("http");
const https = require("https");
const { URL } = require("url");
const mongoose = require("mongoose");
const Payment = require("../models/payment.model");

const BASE_URL = process.env.SMOKE_API_URL || "http://127.0.0.1:8000";
const ADMIN_PHONE = process.env.DEFAULT_ADMIN_PHONE || "9999999999";
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
const STAFF_PASSWORD = "staff123";

const fail = (message) => {
  throw new Error(message);
};

const reqId = () => `INT-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const request = ({ method, path, token, body }) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
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
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const api = async (method, path, token, body, expect = [200]) => {
  const res = await request({ method, path, token, body });
  if (!expect.includes(res.status)) {
    fail(`${method} ${path} expected ${expect.join("/")} got ${res.status}: ${res.body?.message || "unknown"}`);
  }
  return res.body?.data ?? res.body;
};

const login = async (phone, password) => {
  const data = await api("POST", "/api/auth/login", null, { phone, password }, [200]);
  return data.token;
};

const run = async () => {
  if (process.env.ALLOW_DATABASE_RESET !== "true") {
    fail("Refusing integration smoke: ALLOW_DATABASE_RESET must be true.");
  }
  if (!process.env.CONFIRM_DATABASE_RESET) {
    fail("Refusing integration smoke: CONFIRM_DATABASE_RESET must be set.");
  }
  if (!process.env.MONGO_URI) {
    fail("Refusing integration smoke: MONGO_URI must be set.");
  }

  console.log(`\nAJ Gold — HTTP integration smoke (${reqId()})`);
  console.log(`Target API: ${BASE_URL}`);

  const adminToken = await login(ADMIN_PHONE, ADMIN_PASSWORD);
  console.log("PASS: admin login");

  const staffPhone = `6${String(Date.now()).slice(-9)}`;
  const staffCreate = await api(
    "POST",
    "/api/admin/staff",
    adminToken,
    {
      name: "Integration Staff",
      phone: staffPhone,
      password: STAFF_PASSWORD,
      permissions: { canCollectPayment: true, canViewReports: true },
      notes: "integration smoke",
    },
    [201, 200]
  );
  const staffId = staffCreate.staffUserId || staffCreate.user?._id;
  const staffToken = await login(staffPhone, STAFF_PASSWORD);
  console.log("PASS: staff create/login");

  const customerPhone = `7${String(Date.now()).slice(-9)}`;
  const customer = await api(
    "POST",
    "/api/customers",
    adminToken,
    {
      name: "Integration Customer",
      phone: customerPhone,
      address: "Integration Address",
    },
    [201]
  );
  const customerToken = await login(customerPhone, customer.passbookNumber);
  console.log("PASS: customer create/login");

  const scheme = await api(
    "POST",
    "/api/schemes",
    adminToken,
    {
      customerId: customer._id,
      startDate: new Date().toISOString(),
      clientRequestId: reqId(),
    },
    [201]
  );
  console.log("PASS: scheme created");

  const paymentReqId = reqId();
  const paymentA = await api(
    "POST",
    "/api/payments",
    staffToken,
    {
      customer: customer._id,
      scheme: scheme._id,
      amount: 10000,
      paymentMethod: "CASH",
      clientRequestId: paymentReqId,
    },
    [201]
  );
  const paymentReplay = await api(
    "POST",
    "/api/payments",
    staffToken,
    {
      customer: customer._id,
      scheme: scheme._id,
      amount: 10000,
      paymentMethod: "CASH",
      clientRequestId: paymentReqId,
    },
    [200, 201]
  );
  if (String(paymentA.payment._id) !== String(paymentReplay.payment._id)) {
    fail("Idempotent replay returned different payment id.");
  }
  const conflict = await request({
    method: "POST",
    path: "/api/payments",
    token: staffToken,
    body: {
      customer: customer._id,
      scheme: scheme._id,
      amount: 11000,
      paymentMethod: "CASH",
      clientRequestId: paymentReqId,
    },
  });
  if (conflict.status !== 409) {
    fail(`Conflicting idempotency replay expected 409, got ${conflict.status}`);
  }
  console.log("PASS: payment idempotency and conflict guard");

  const cashSubmission = await api(
    "POST",
    "/api/admin/cash-submissions",
    adminToken,
    {
      staff: staffId,
      submittedAmount: 5000,
      submissionDate: new Date().toISOString(),
      receivedBy: "Integration Admin",
      notes: "partial",
      clientRequestId: reqId(),
    },
    [201]
  );
  if (!cashSubmission.submission?._id) {
    fail("Cash submission id missing.");
  }
  console.log("PASS: cash submission");

  const correctionReq = await api(
    "POST",
    `/api/payments/${paymentA.payment._id}/correction-request`,
    staffToken,
    {
      correctionType: "EDIT_AMOUNT",
      requestedValue: 12000,
      reason: "integration adjust",
    },
    [201]
  );
  const correctionId = correctionReq._id;
  await api(
    "POST",
    `/api/corrections/${correctionId}/approve`,
    adminToken,
    { reviewNotes: "ok", reviewClientRequestId: reqId() },
    [200]
  );
  console.log("PASS: correction request/approval");

  const settlement = await api(
    "PATCH",
    `/api/schemes/${scheme._id}/status`,
    adminToken,
    {
      status: "CLOSED",
      payoutMethod: "CASH",
      notes: "integration close",
      clientRequestId: reqId(),
    },
    [200]
  );
  if (!settlement.settlement?.amount || settlement.settlement.amount <= 0) {
    fail("Settlement amount missing.");
  }
  console.log("PASS: direct settlement");

  const postSettlementPayment = await request({
    method: "POST",
    path: "/api/payments",
    token: staffToken,
    body: {
      customer: customer._id,
      scheme: scheme._id,
      amount: 1000,
      paymentMethod: "CASH",
      clientRequestId: reqId(),
    },
  });
  if (![400, 409].includes(postSettlementPayment.status)) {
    fail(`Post-settlement payment expected 400/409, got ${postSettlementPayment.status}`);
  }
  console.log("PASS: post-settlement payment blocked");

  const customerBlocked = await request({
    method: "GET",
    path: "/api/corrections",
    token: customerToken,
  });
  if (customerBlocked.status !== 403) {
    fail(`Customer correction access expected 403, got ${customerBlocked.status}`);
  }
  console.log("PASS: customer permission block");

  await api("POST", "/api/auth/logout", staffToken, {}, [200]);
  const afterLogout = await request({
    method: "GET",
    path: "/api/auth/me",
    token: staffToken,
  });
  if (afterLogout.status !== 401) {
    fail(`Expected 401 after logout, got ${afterLogout.status}`);
  }
  console.log("PASS: logout token invalidation");

  const notFound = await request({ method: "GET", path: "/api/not-a-real-route" });
  if (!notFound.body?.requestId) {
    fail("404 response missing requestId.");
  }
  console.log("PASS: requestId on error responses");

  await mongoose.connect(process.env.MONGO_URI);
  const dupCount = await Payment.countDocuments({
    customer: customer._id,
    scheme: scheme._id,
    amount: 10000,
    paymentMethod: "CASH",
    status: "SUCCESS",
  });
  if (dupCount !== 1) {
    fail(`Expected exactly 1 successful CASH payment row, found ${dupCount}`);
  }
  await mongoose.disconnect();
  console.log("PASS: idempotent payment uniqueness in DB");

  console.log("\nIntegration smoke summary: PASS");
};

run().catch(async (error) => {
  console.error(`\nIntegration smoke failed: ${error.message || error}`);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
