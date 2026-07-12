/**
 * HTTP integration smoke test against a running demo backend.
 * Run: npm run smoke:integration  (requires npm run start:demo)
 */
require("dotenv").config({ path: require("path").join(__dirname, "../../.env.demo") });

const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const { clientRequestId } = require("./smokeHelpers");
const { CORRECTION_TYPES, SCHEME_STATUS, PAYMENT_METHODS } = require("../constants/enums");

const BASE_URL = (process.env.INTEGRATION_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const ADMIN_PHONE = "9999999999";
const ADMIN_PASSWORD = "admin123";
const ARUN_PHONE = "9847011001";
const SREESHMA_PHONE = "9847011002";
const STAFF_PASSWORD = "agent123";

const extractDbName = (uri) => {
  if (!uri) return "";
  const withoutQuery = uri.split("?")[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return last.includes(":") ? "" : last;
};

const results = [];

const pass = (n, label) => {
  console.log(`PASS: ${n}. ${label}`);
  results.push({ n, ok: true, label });
};

const fail = (n, label, detail) => {
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`FAIL: ${n}. ${label}${suffix}`);
  results.push({ n, ok: false, label, detail });
};

const assertTruthy = (value, message) => {
  if (!value) throw new Error(message);
};

const requestJson = ({ method, path, token, body }) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
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
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = { raw: data };
            }
          }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const login = async (phone, password) => {
  const res = await requestJson({
    method: "POST",
    path: "/api/auth/login",
    body: { phone, password },
  });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error(`Login failed (${res.status}): ${res.body?.message || "unknown"}`);
  }
  return res.body.data.token;
};

const runScenario = async (n, label, fn) => {
  try {
    await fn();
    pass(n, label);
  } catch (error) {
    fail(n, label, error.message);
  }
};

const assertErrorShape = (res, { status, code, retryable }) => {
  assertTruthy(res.body, "error body missing");
  assertTruthy(res.body.requestId, "requestId missing on error response");
  if (status != null && res.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${res.status}`);
  }
  if (code != null && res.body.code !== code) {
    throw new Error(`expected code ${code}, got ${res.body.code}`);
  }
  if (retryable != null && res.body.retryable !== retryable) {
    throw new Error(`expected retryable ${retryable}, got ${res.body.retryable}`);
  }
};

const uniquePhone = () => `8${String(Date.now()).slice(-9)}`;

const run = async () => {
  const dbName = extractDbName(process.env.MONGO_URI).toLowerCase();
  if (!dbName || !/(dev|demo|test)/.test(dbName)) {
    console.error(
      `Refusing integration smoke: database "${dbName || "(unknown)"}" must contain dev, demo, or test.`
    );
    process.exit(1);
  }
  if (process.env.ALLOW_DATABASE_RESET !== "true") {
    console.error("Refusing integration smoke: ALLOW_DATABASE_RESET must be true.");
    process.exit(1);
  }

  const runTag = `INT-${Date.now()}`;
  const settlementAmount = 5000;
  const paymentAmount = 5000;
  const correctionAmount = 6000;

  let adminToken;
  let arunToken;
  let sreeshmaToken;
  let customerToken;
  let smokeCustomerId;
  let smokeSchemeId;
  let smokePassbook;
  let arunStaffUserId;
  let paymentId;
  let paymentCountBefore;
  let correctionId;
  let baselineSettlementTotal;
  let reviewRequestId;
  const idempotentRequestId = clientRequestId();

  console.log(`\nAJ Gold — HTTP integration smoke (${runTag})\n`);
  console.log(`Target API: ${BASE_URL}`);
  console.log(`Database: ${dbName}\n`);

  await runScenario(1, "Admin login succeeds", async () => {
    adminToken = await login(ADMIN_PHONE, ADMIN_PASSWORD);
  });

  await runScenario(2, "Staff login succeeds", async () => {
    arunToken = await login(ARUN_PHONE, STAFF_PASSWORD);
  });

  await runScenario(3, "Customer login succeeds", async () => {
    const listRes = await requestJson({
      method: "GET",
      path: "/api/customers?search=9847110006",
      token: adminToken,
    });
    assertTruthy(listRes.status === 200, "customer list failed");
    const fathima = listRes.body?.data?.items?.find((c) => c.phone === "9847110006");
    assertTruthy(fathima?.passbookNumber, "fathima passbook not found");
    customerToken = await login("9847110006", fathima.passbookNumber);
  });

  await runScenario(4, "Staff collects a cash payment", async () => {
    assertTruthy(adminToken && arunToken, "missing auth tokens from prior scenarios");

    const createCustomerRes = await requestJson({
      method: "POST",
      path: "/api/customers",
      token: adminToken,
      body: {
        name: `Smoke Customer ${runTag}`,
        phone: uniquePhone(),
        address: "Integration smoke address",
      },
    });
    assertTruthy(createCustomerRes.status === 201, `create customer failed (${createCustomerRes.status})`);
    smokeCustomerId = createCustomerRes.body.data._id;
    smokePassbook = createCustomerRes.body.data.passbookNumber;

    const createSchemeRes = await requestJson({
      method: "POST",
      path: "/api/schemes",
      token: adminToken,
      body: {
        customerId: smokeCustomerId,
        startDate: "2024-03-01T00:00:00.000Z",
      },
    });
    assertTruthy(createSchemeRes.status === 201, "create scheme failed");
    smokeSchemeId = createSchemeRes.body.data._id;

    const staffRes = await requestJson({
      method: "GET",
      path: `/api/admin/staff?search=${ARUN_PHONE}`,
      token: adminToken,
    });
    const arunStaff = staffRes.body?.data?.items?.find((s) => s.phone === ARUN_PHONE);
    assertTruthy(arunStaff?.staffUserId, "arun staff id not found");
    arunStaffUserId = arunStaff.staffUserId;

    const countRes = await requestJson({
      method: "GET",
      path: `/api/payments?customerId=${smokeCustomerId}&schemeId=${smokeSchemeId}`,
      token: adminToken,
    });
    paymentCountBefore = Array.isArray(countRes.body?.data) ? countRes.body.data.length : 0;

    const collectRes = await requestJson({
      method: "POST",
      path: "/api/payments",
      token: arunToken,
      body: {
        customer: smokeCustomerId,
        scheme: smokeSchemeId,
        amount: paymentAmount,
        paymentMethod: PAYMENT_METHODS.CASH,
        notes: runTag,
        clientRequestId: idempotentRequestId,
      },
    });
    assertTruthy(collectRes.status === 201, `collect payment failed (${collectRes.status})`);
    paymentId = collectRes.body.data.payment._id;
    assertTruthy(paymentId, "payment id missing");
  });

  await runScenario(5, "Repeating the exact payment with the same clientRequestId returns the original payment", async () => {
    assertTruthy(paymentId, "payment id missing");
    const replayRes = await requestJson({
      method: "POST",
      path: "/api/payments",
      token: arunToken,
      body: {
        customer: smokeCustomerId,
        scheme: smokeSchemeId,
        amount: paymentAmount,
        paymentMethod: PAYMENT_METHODS.CASH,
        notes: runTag,
        clientRequestId: idempotentRequestId,
      },
    });
    assertTruthy(replayRes.status === 201, "idempotent replay failed");
    assertTruthy(
      replayRes.body.data.payment._id === paymentId,
      "idempotent replay returned a different payment id"
    );
  });

  await runScenario(6, "Confirm only one payment exists for the idempotent clientRequestId", async () => {
    const listRes = await requestJson({
      method: "GET",
      path: `/api/payments?customerId=${smokeCustomerId}&schemeId=${smokeSchemeId}`,
      token: adminToken,
    });
    const items = Array.isArray(listRes.body?.data) ? listRes.body.data : [];
    const idempotentPayments = items.filter((p) => p.notes === runTag || p.amount === paymentAmount);
    assertTruthy(
      items.length === paymentCountBefore + 1,
      `expected ${paymentCountBefore + 1} payments, got ${items.length}`
    );
    assertTruthy(idempotentPayments.length >= 1, "idempotent payment not listed");
  });

  await runScenario(7, "Reusing the same ID with a different amount returns IDEMPOTENCY_KEY_REUSED", async () => {
    const conflictRes = await requestJson({
      method: "POST",
      path: "/api/payments",
      token: arunToken,
      body: {
        customer: smokeCustomerId,
        scheme: smokeSchemeId,
        amount: paymentAmount + 1000,
        paymentMethod: PAYMENT_METHODS.CASH,
        notes: runTag,
        clientRequestId: idempotentRequestId,
      },
    });
    assertErrorShape(conflictRes, {
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
      retryable: false,
    });
  });

  await runScenario(8, "Admin records a partial staff cash submission", async () => {
    const submissionRes = await requestJson({
      method: "POST",
      path: "/api/admin/cash-submissions",
      token: adminToken,
      body: {
        staff: arunStaffUserId,
        submittedAmount: 10000,
        notes: `${runTag} partial submission`,
        clientRequestId: clientRequestId(),
      },
    });
    assertTruthy(submissionRes.status === 201, `cash submission failed (${submissionRes.status})`);
    assertTruthy(
      submissionRes.body.data.cashInHand >= 0,
      "cash in hand negative after partial submission"
    );
  });

  await runScenario(9, "Cash submission above cash in hand returns INSUFFICIENT_STAFF_CASH", async () => {
    const summaryRes = await requestJson({
      method: "GET",
      path: `/api/admin/staff/${arunStaffUserId}/cash-summary`,
      token: adminToken,
    });
    const cashInHand = summaryRes.body?.data?.cashInHand ?? 0;
    const overRes = await requestJson({
      method: "POST",
      path: "/api/admin/cash-submissions",
      token: adminToken,
      body: {
        staff: arunStaffUserId,
        submittedAmount: cashInHand + 50000,
        notes: `${runTag} over submission`,
        clientRequestId: clientRequestId(),
      },
    });
    assertErrorShape(overRes, {
      status: 409,
      code: "INSUFFICIENT_STAFF_CASH",
      retryable: false,
    });
  });

  await runScenario(10, "Staff cash summary is correct after submission", async () => {
    const summaryRes = await requestJson({
      method: "GET",
      path: `/api/admin/staff/${arunStaffUserId}/cash-summary`,
      token: adminToken,
    });
    assertTruthy(summaryRes.status === 200, "cash summary request failed");
    const summary = summaryRes.body.data;
    assertTruthy(summary.cashInHand >= 0, "cash in hand is negative");
    assertTruthy(
      summary.cashInHand === summary.cashCollected - summary.cashSubmitted,
      "cashInHand != cashCollected - cashSubmitted"
    );
  });

  await runScenario(11, "Staff requests a payment correction", async () => {
    const correctionRes = await requestJson({
      method: "POST",
      path: `/api/payments/${paymentId}/correction-request`,
      token: arunToken,
      body: {
        correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
        requestedValue: correctionAmount,
        reason: `${runTag} amount correction`,
      },
    });
    assertTruthy(correctionRes.status === 201, `correction request failed (${correctionRes.status})`);
    correctionId = correctionRes.body.data._id;
    assertTruthy(correctionId, "correction id missing");
  });

  reviewRequestId = clientRequestId();

  await runScenario(12, "Admin approves correction using reviewClientRequestId", async () => {
    const approveRes = await requestJson({
      method: "POST",
      path: `/api/corrections/${correctionId}/approve`,
      token: adminToken,
      body: {
        reviewNotes: `${runTag} approved`,
        reviewClientRequestId: reviewRequestId,
      },
    });
    assertTruthy(approveRes.status === 200, `approve failed (${approveRes.status})`);
  });

  await runScenario(13, "Repeating approval with the same reviewClientRequestId is idempotent", async () => {
    const replayRes = await requestJson({
      method: "POST",
      path: `/api/corrections/${correctionId}/approve`,
      token: adminToken,
      body: {
        reviewNotes: `${runTag} approved replay`,
        reviewClientRequestId: reviewRequestId,
      },
    });
    assertTruthy(replayRes.status === 200, `approve replay failed (${replayRes.status})`);
  });

  await runScenario(14, "A second conflicting review is rejected", async () => {
    const rejectRes = await requestJson({
      method: "POST",
      path: `/api/corrections/${correctionId}/reject`,
      token: adminToken,
      body: {
        reviewNotes: `${runTag} conflicting reject`,
        reviewClientRequestId: clientRequestId(),
      },
    });
    assertErrorShape(rejectRes, {
      status: 409,
      code: "CORRECTION_ALREADY_REVIEWED",
      retryable: false,
    });
  });

  await runScenario(15, "Admin redeems eligible scheme with settlementAmount, notes, clientRequestId", async () => {
    const cashPosBefore = await requestJson({
      method: "GET",
      path: "/api/reports/cash-position",
      token: adminToken,
    });
    baselineSettlementTotal = cashPosBefore.body?.data?.totalCustomerSettlement ?? 0;

    const settleRes = await requestJson({
      method: "PATCH",
      path: `/api/schemes/${smokeSchemeId}/status`,
      token: adminToken,
      body: {
        status: SCHEME_STATUS.REDEEMED,
        settlementAmount,
        notes: `${runTag} redemption settlement`,
        clientRequestId: clientRequestId(),
      },
    });
    assertTruthy(settleRes.status === 200, `settlement failed (${settleRes.status})`);
    assertTruthy(
      settleRes.body.data.settlement?.amount === settlementAmount,
      "settlement amount not stored on scheme"
    );
  });

  await runScenario(16, "Settlement amount appears in scheme detail, ledgers, dashboard, and cash-position report", async () => {
    const schemeRes = await requestJson({
      method: "GET",
      path: `/api/schemes/${smokeSchemeId}`,
      token: adminToken,
    });
    assertTruthy(schemeRes.body?.data?.settlement?.amount === settlementAmount, "scheme detail mismatch");

    const customerLedgerRes = await requestJson({
      method: "GET",
      path: `/api/reports/customer-ledger/${smokeCustomerId}`,
      token: adminToken,
    });
    const customerSettlements = customerLedgerRes.body?.data?.settlementHistory || [];
    assertTruthy(
      customerSettlements.some((entry) => entry.amount === settlementAmount),
      "customer ledger missing settlement"
    );

    const schemeLedgerRes = await requestJson({
      method: "GET",
      path: `/api/reports/scheme-ledger/${smokeSchemeId}`,
      token: adminToken,
    });
    const schemeSettlements = schemeLedgerRes.body?.data?.settlements || [];
    assertTruthy(
      schemeSettlements.some((entry) => entry.amount === settlementAmount),
      "scheme ledger missing settlement"
    );

    const dashboardRes = await requestJson({
      method: "GET",
      path: "/api/dashboard/admin",
      token: adminToken,
    });
    assertTruthy(
      dashboardRes.body?.data?.totalCustomerSettlement === baselineSettlementTotal + settlementAmount,
      "admin dashboard settlement total mismatch"
    );

    const cashPosRes = await requestJson({
      method: "GET",
      path: "/api/reports/cash-position",
      token: adminToken,
    });
    assertTruthy(
      cashPosRes.body?.data?.totalCustomerSettlement === baselineSettlementTotal + settlementAmount,
      "cash-position settlement total mismatch"
    );
  });

  await runScenario(17, "New payment after settlement is rejected with PAYMENT_AFTER_SETTLEMENT", async () => {
    const afterSettleRes = await requestJson({
      method: "POST",
      path: "/api/payments",
      token: arunToken,
      body: {
        customer: smokeCustomerId,
        scheme: smokeSchemeId,
        amount: 1000,
        paymentMethod: PAYMENT_METHODS.CASH,
        notes: `${runTag} after settlement`,
        clientRequestId: clientRequestId(),
      },
    });
    assertErrorShape(afterSettleRes, {
      status: 409,
      code: "PAYMENT_AFTER_SETTLEMENT",
      retryable: false,
    });
  });

  await runScenario(18, "Staff cannot settle a scheme", async () => {
    const staffSettleRes = await requestJson({
      method: "PATCH",
      path: `/api/schemes/${smokeSchemeId}/status`,
      token: arunToken,
      body: {
        status: SCHEME_STATUS.REDEEMED,
        settlementAmount: 1000,
        notes: `${runTag} staff attempt`,
        clientRequestId: clientRequestId(),
      },
    });
    assertTruthy(staffSettleRes.status === 403, `expected 403, got ${staffSettleRes.status}`);
    assertTruthy(staffSettleRes.body?.requestId, "requestId missing on staff settle error");
  });

  await runScenario(19, "Staff cannot access another staff member's restricted payment", async () => {
    sreeshmaToken = await login(SREESHMA_PHONE, STAFF_PASSWORD);
    const forbiddenRes = await requestJson({
      method: "GET",
      path: `/api/payments/${paymentId}`,
      token: sreeshmaToken,
    });
    assertTruthy(forbiddenRes.status === 403, `expected 403, got ${forbiddenRes.status}`);
    assertTruthy(forbiddenRes.body?.requestId, "requestId missing on forbidden payment access");
  });

  await runScenario(20, "Logout invalidates the previous token", async () => {
    const tempToken = await login(ARUN_PHONE, STAFF_PASSWORD);
    const logoutRes = await requestJson({
      method: "POST",
      path: "/api/auth/logout",
      token: tempToken,
    });
    assertTruthy(logoutRes.status === 200, "logout failed");
    const meRes = await requestJson({
      method: "GET",
      path: "/api/auth/me",
      token: tempToken,
    });
    assertTruthy(meRes.status === 401, `expected 401 after logout, got ${meRes.status}`);
    assertTruthy(meRes.body?.requestId, "requestId missing on post-logout 401");
  });

  await runScenario(21, "Login rate limiting returns 429 and RATE_LIMITED", async () => {
    const ratePhone = `1${crypto.randomBytes(4).toString("hex").slice(0, 9)}`;
    let limited = null;
    for (let i = 0; i < 25; i += 1) {
      limited = await requestJson({
        method: "POST",
        path: "/api/auth/login",
        body: { phone: ratePhone, password: "wrong-password-value" },
      });
      if (limited.status === 429) break;
    }
    assertErrorShape(limited, {
      status: 429,
      code: "RATE_LIMITED",
      retryable: false,
    });
  });

  await runScenario(22, "Error responses include requestId", async () => {
    const badRes = await requestJson({
      method: "GET",
      path: "/api/not-a-real-route",
      token: adminToken,
    });
    assertTruthy(badRes.status === 404, "expected 404 for missing route");
    assertTruthy(badRes.body?.requestId, "requestId missing on 404");
  });

  await runScenario(23, "No staff cash balance becomes negative", async () => {
    const staffRes = await requestJson({
      method: "GET",
      path: "/api/admin/staff",
      token: adminToken,
    });
    const staffItems = staffRes.body?.data?.items || [];
    for (const staff of staffItems) {
      const summaryRes = await requestJson({
        method: "GET",
        path: `/api/admin/staff/${staff.staffUserId}/cash-summary`,
        token: adminToken,
      });
      const cashInHand = summaryRes.body?.data?.cashInHand;
      if (cashInHand < 0) {
        throw new Error(`${staff.name} has negative cash in hand (${cashInHand})`);
      }
    }
  });

  await runScenario(24, "No duplicate financial record is created for idempotent payment", async () => {
    const listRes = await requestJson({
      method: "GET",
      path: `/api/payments?customerId=${smokeCustomerId}&schemeId=${smokeSchemeId}`,
      token: adminToken,
    });
    const items = Array.isArray(listRes.body?.data) ? listRes.body.data : [];
    assertTruthy(
      items.length === paymentCountBefore + 1,
      `expected ${paymentCountBefore + 1} payment records, found ${items.length}`
    );
  });

  const failed = results.filter((row) => !row.ok);
  console.log(`\nIntegration smoke summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exit(1);
  }
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
