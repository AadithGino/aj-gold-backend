/**
 * AJ Gold Kambil — Rich Client Demo Seed
 *
 * Prerequisites:
 *   - Backend running (default http://127.0.0.1:8000)
 *   - DB cleared except admin user
 *
 * Run:
 *   npm run seed:demo
 *
 * Optional env:
 *   RESET_DEMO_COUNTERS=true  — reset receipt/enrollment/passbook counters (demo-only DB)
 *   SEED_API_URL=http://127.0.0.1:8000
 */
require("dotenv").config();

const http = require("http");
const https = require("https");
const { URL } = require("url");
const mongoose = require("mongoose");

const BASE_URL =
  process.env.SEED_API_URL || `http://127.0.0.1:${process.env.PORT || 8000}`;

const ADMIN_PHONE = process.env.DEFAULT_ADMIN_PHONE || "9999999999";
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
const STAFF_PASSWORD = "agent123";

const ARUN_SUBMISSION = 180000;
const SREESHMA_SUBMISSION = 130000;

const STAFF = [
  {
    key: "arun",
    name: "Arun Nair",
    phone: "9847011001",
    notes: "Demo agent — Thiruvananthapuram region",
  },
  {
    key: "sreeshma",
    name: "Sreeshma Menon",
    phone: "9847011002",
    notes: "Demo agent — Kochi / Central Kerala region",
  },
];

const CUSTOMERS = [
  {
    key: "anjali",
    owner: "arun",
    name: "Anjali Nambiar",
    phone: "9847110001",
    address: "Pattom, Thiruvananthapuram, Kerala 695004",
    nominee: {
      name: "Gopal Nambiar",
      phone: "9847110101",
      relationship: "Father",
    },
    startDate: "2026-05-15",
    scenario: "New customer — pre-6-month, limit still forming",
  },
  {
    key: "rahul",
    owner: "arun",
    name: "Rahul Warrier",
    phone: "9847110002",
    address: "Marine Drive, Kochi, Kerala 682031",
    nominee: {
      name: "Lakshmi Warrier",
      phone: "9847110102",
      relationship: "Mother",
    },
    startDate: "2026-02-01",
    scenario: "Good mixed payment history across all methods",
  },
  {
    key: "deepak",
    owner: "arun",
    name: "Deepak Menon",
    phone: "9847110003",
    address: "SM Street, Kozhikode, Kerala 673001",
    nominee: {
      name: "Priya Menon",
      phone: "9847110103",
      relationship: "Spouse",
    },
    startDate: "2025-12-01",
    scenario: "Post-6-month — cap partially used (~₹30,000 remaining)",
  },
  {
    key: "meera",
    owner: "arun",
    name: "Meera Krishnan",
    phone: "9847110004",
    address: "Swaraj Round, Thrissur, Kerala 680001",
    nominee: {
      name: "Ravi Krishnan",
      phone: "9847110104",
      relationship: "Brother",
    },
    startDate: "2025-11-01",
    scenario: "Active scheme — 6-month cap fully reached",
  },
  {
    key: "suresh",
    owner: "sreeshma",
    name: "Suresh Pillai",
    phone: "9847110005",
    address: "Alappuzha Beach Road, Kerala 688012",
    nominee: {
      name: "Suma Pillai",
      phone: "9847110105",
      relationship: "Spouse",
    },
    startDate: "2025-11-01",
    scenario: "Active scheme — 6-month cap fully reached",
  },
  {
    key: "fathima",
    owner: "sreeshma",
    name: "Fathima Rahman",
    phone: "9847110006",
    address: "Mananchira, Kozhikode, Kerala 673001",
    nominee: {
      name: "Abdul Rahman",
      phone: "9847110106",
      relationship: "Father",
    },
    startDate: "2026-06-01",
    scenario: "New customer — pre-6-month, active July transactions",
  },
  {
    key: "joseph",
    owner: "sreeshma",
    name: "Joseph Varghese",
    phone: "9847110007",
    address: "Pala, Kottayam, Kerala 686575",
    nominee: {
      name: "Mary Varghese",
      phone: "9847110107",
      relationship: "Mother",
    },
    startDate: "2026-01-15",
    scenario: "Near six-month point — long clean payment history",
  },
];

/** 11 payments per customer → 77 total */
const PAYMENT_PLANS = {
  anjali: [
    { amount: 20000, method: "CASH", date: "2026-05-20T10:00:00.000Z" },
    { amount: 10000, method: "UPI", date: "2026-05-28T10:00:00.000Z", reference: "UPI-ANJALI-MAY" },
    { amount: 18000, method: "CASH", date: "2026-06-05T10:00:00.000Z" },
    { amount: 8000, method: "BANK", date: "2026-06-15T10:00:00.000Z", reference: "NEFT-ANJALI-JUN" },
    { amount: 7000, method: "CARD", date: "2026-06-22T10:00:00.000Z", reference: "CARD-ANJALI-JUN" },
    { amount: 15000, method: "CASH", date: "2026-07-01T10:00:00.000Z" },
    { amount: 9000, method: "UPI", date: "2026-07-02T10:00:00.000Z", reference: "UPI-ANJALI-JUL1" },
    { amount: 12000, method: "CASH", date: "2026-07-03T10:00:00.000Z" },
    { amount: 6000, method: "BANK", date: "2026-07-04T10:00:00.000Z", reference: "NEFT-ANJALI-JUL" },
    { amount: 5000, method: "CARD", date: "2026-07-04T11:00:00.000Z", reference: "CARD-ANJALI-JUL" },
    { amount: 10000, method: "CASH", date: "2026-07-05T10:00:00.000Z" },
  ],
  rahul: [
    { amount: 15000, method: "CASH", date: "2026-02-10T10:00:00.000Z" },
    { amount: 12000, method: "UPI", date: "2026-03-10T10:00:00.000Z", reference: "UPI-RAHUL-MAR" },
    { amount: 18000, method: "CASH", date: "2026-04-10T10:00:00.000Z" },
    { amount: 10000, method: "BANK", date: "2026-04-25T10:00:00.000Z", reference: "NEFT-RAHUL-APR" },
    { amount: 8000, method: "CARD", date: "2026-05-10T10:00:00.000Z", reference: "CARD-RAHUL-MAY" },
    { amount: 20000, method: "CASH", date: "2026-06-01T10:00:00.000Z" },
    { amount: 11000, method: "UPI", date: "2026-06-15T10:00:00.000Z", reference: "UPI-RAHUL-JUN" },
    { amount: 9000, method: "BANK", date: "2026-06-28T10:00:00.000Z", reference: "NEFT-RAHUL-JUN" },
    { amount: 22000, method: "CASH", date: "2026-07-02T10:00:00.000Z" },
    { amount: 7000, method: "CARD", date: "2026-07-04T10:00:00.000Z", reference: "CARD-RAHUL-JUL" },
    { amount: 15000, method: "CASH", date: "2026-07-05T10:00:00.000Z" },
  ],
  deepak: [
    { amount: 15000, method: "CASH", date: "2025-12-05T10:00:00.000Z" },
    { amount: 12000, method: "UPI", date: "2026-01-05T10:00:00.000Z", reference: "UPI-DEEPAK-JAN" },
    { amount: 13000, method: "CASH", date: "2026-02-05T10:00:00.000Z" },
    { amount: 12000, method: "BANK", date: "2026-03-05T10:00:00.000Z", reference: "NEFT-DEEPAK-MAR" },
    { amount: 14000, method: "CASH", date: "2026-04-05T10:00:00.000Z" },
    { amount: 14000, method: "UPI", date: "2026-05-05T10:00:00.000Z", reference: "UPI-DEEPAK-MAY" },
    { amount: 12000, method: "CASH", date: "2026-06-10T10:00:00.000Z" },
    { amount: 10000, method: "UPI", date: "2026-06-20T10:00:00.000Z", reference: "UPI-DEEPAK-JUN" },
    { amount: 10000, method: "CASH", date: "2026-07-01T10:00:00.000Z" },
    { amount: 10000, method: "BANK", date: "2026-07-03T10:00:00.000Z", reference: "NEFT-DEEPAK-JUL" },
    { amount: 8000, method: "CARD", date: "2026-07-05T10:00:00.000Z", reference: "CARD-DEEPAK-JUL" },
  ],
  meera: [
    { amount: 14000, method: "CASH", date: "2025-11-05T10:00:00.000Z" },
    { amount: 13000, method: "UPI", date: "2025-12-05T10:00:00.000Z", reference: "UPI-MEERA-DEC" },
    { amount: 13000, method: "CASH", date: "2026-01-05T10:00:00.000Z" },
    { amount: 13000, method: "BANK", date: "2026-02-05T10:00:00.000Z", reference: "NEFT-MEERA-FEB" },
    { amount: 14000, method: "CASH", date: "2026-03-05T10:00:00.000Z" },
    { amount: 13000, method: "UPI", date: "2026-04-05T10:00:00.000Z", reference: "UPI-MEERA-APR" },
    { amount: 16000, method: "CASH", date: "2026-05-10T10:00:00.000Z" },
    { amount: 16000, method: "UPI", date: "2026-06-05T10:00:00.000Z", reference: "UPI-MEERA-JUN" },
    { amount: 16000, method: "CASH", date: "2026-06-20T10:00:00.000Z" },
    { amount: 16000, method: "BANK", date: "2026-07-01T10:00:00.000Z", reference: "NEFT-MEERA-JUL" },
    { amount: 16000, method: "CARD", date: "2026-07-04T10:00:00.000Z", reference: "CARD-MEERA-JUL" },
  ],
  suresh: [
    { amount: 15000, method: "CASH", date: "2025-11-05T10:00:00.000Z" },
    { amount: 12000, method: "UPI", date: "2025-12-05T10:00:00.000Z", reference: "UPI-SURESH-DEC" },
    { amount: 14000, method: "CASH", date: "2026-01-05T10:00:00.000Z" },
    { amount: 13000, method: "BANK", date: "2026-02-05T10:00:00.000Z", reference: "NEFT-SURESH-FEB" },
    { amount: 13000, method: "CASH", date: "2026-03-05T10:00:00.000Z" },
    { amount: 13000, method: "UPI", date: "2026-04-05T10:00:00.000Z", reference: "UPI-SURESH-APR" },
    { amount: 18000, method: "CASH", date: "2026-05-10T10:00:00.000Z" },
    { amount: 16000, method: "CASH", date: "2026-06-05T10:00:00.000Z" },
    { amount: 16000, method: "UPI", date: "2026-06-20T10:00:00.000Z", reference: "UPI-SURESH-JUN" },
    { amount: 16000, method: "CASH", date: "2026-07-01T10:00:00.000Z" },
    { amount: 14000, method: "CASH", date: "2026-07-04T10:00:00.000Z" },
  ],
  fathima: [
    { amount: 12000, method: "CASH", date: "2026-06-06T10:00:00.000Z" },
    { amount: 8000, method: "UPI", date: "2026-06-10T10:00:00.000Z", reference: "UPI-FATHIMA-JUN" },
    { amount: 15000, method: "CASH", date: "2026-06-15T10:00:00.000Z" },
    { amount: 7000, method: "BANK", date: "2026-06-20T10:00:00.000Z", reference: "NEFT-FATHIMA-JUN" },
    { amount: 6000, method: "CARD", date: "2026-06-25T10:00:00.000Z", reference: "CARD-FATHIMA-JUN" },
    { amount: 18000, method: "CASH", date: "2026-07-01T10:00:00.000Z" },
    { amount: 9000, method: "UPI", date: "2026-07-02T10:00:00.000Z", reference: "UPI-FATHIMA-JUL" },
    { amount: 14000, method: "CASH", date: "2026-07-03T10:00:00.000Z" },
    { amount: 8000, method: "BANK", date: "2026-07-04T10:00:00.000Z", reference: "NEFT-FATHIMA-JUL" },
    { amount: 7000, method: "CARD", date: "2026-07-04T11:00:00.000Z", reference: "CARD-FATHIMA-JUL" },
    { amount: 12000, method: "CASH", date: "2026-07-05T10:00:00.000Z" },
  ],
  joseph: [
    { amount: 11000, method: "CASH", date: "2026-01-20T10:00:00.000Z" },
    { amount: 10000, method: "UPI", date: "2026-02-20T10:00:00.000Z", reference: "UPI-JOSEPH-FEB" },
    { amount: 12000, method: "CASH", date: "2026-03-20T10:00:00.000Z" },
    { amount: 10000, method: "BANK", date: "2026-04-20T10:00:00.000Z", reference: "NEFT-JOSEPH-APR" },
    { amount: 9000, method: "CARD", date: "2026-05-05T10:00:00.000Z", reference: "CARD-JOSEPH-MAY" },
    { amount: 13000, method: "CASH", date: "2026-05-20T10:00:00.000Z" },
    { amount: 11000, method: "UPI", date: "2026-06-10T10:00:00.000Z", reference: "UPI-JOSEPH-JUN" },
    { amount: 14000, method: "CASH", date: "2026-06-25T10:00:00.000Z" },
    { amount: 10000, method: "BANK", date: "2026-07-01T10:00:00.000Z", reference: "NEFT-JOSEPH-JUL" },
    { amount: 8000, method: "CARD", date: "2026-07-03T10:00:00.000Z", reference: "CARD-JOSEPH-JUL" },
    { amount: 15000, method: "CASH", date: "2026-07-05T10:00:00.000Z" },
  ],
};

const DEMO_PHONES = [
  ...STAFF.map((s) => s.phone),
  ...CUSTOMERS.map((c) => c.phone),
];

const log = (msg) => console.log(msg);
const fail = (msg) => {
  throw new Error(msg);
};

const formatINR = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;

const request = ({ method, path, token, body }) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const transport = url.protocol === "https:" ? https : http;

    const req = transport.request(
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

const api = async (method, path, token, body) => {
  const res = await request({ method, path, token, body });
  if (res.status >= 400) {
    fail(
      `${method} ${path} → ${res.status}: ${
        res.body?.message || JSON.stringify(res.body)
      }`
    );
  }
  return res.body?.data ?? res.body;
};

const login = async (phone, password) => {
  const data = await api("POST", "/api/auth/login", null, { phone, password });
  return data.token;
};

const getId = (entity) => entity?._id || entity?.id || null;

const getStaffUserId = (created) => created.staffUserId || created.user?._id;

const cashInHandOf = (staffDetail) => Number(staffDetail?.cashInHand ?? 0);

const flattenCustomerSchemes = (detail) => {
  const groups = [];
  if (Array.isArray(detail.schemes)) groups.push(...detail.schemes);
  if (detail.activeScheme) groups.push(detail.activeScheme);
  [
    "activeSchemes",
    "previousSchemes",
    "closedSchemes",
    "redeemedSchemes",
    "withdrawnSchemes",
    "maturedSchemes",
    "suspendedSchemes",
  ].forEach((key) => {
    if (Array.isArray(detail[key])) groups.push(...detail[key]);
  });
  return groups;
};

const getRemainingAllowed = (scheme) =>
  Number(scheme?.remainingAllowedPayment ?? 0);

const emptyStats = () => ({
  paymentCount: 0,
  CASH: 0,
  UPI: 0,
  BANK: 0,
  CARD: 0,
  arunCash: 0,
  sreeshmaCash: 0,
});

const trackPayment = (stats, owner, method, amount) => {
  stats.paymentCount += 1;
  stats[method] = (stats[method] || 0) + amount;
  if (method === "CASH") {
    if (owner === "arun") stats.arunCash += amount;
    if (owner === "sreeshma") stats.sreeshmaCash += amount;
  }
};

const collect = async (
  token,
  { customerId, schemeId, amount, method, date, reference, notes }
) =>
  api("POST", "/api/payments", token, {
    customer: customerId,
    scheme: schemeId,
    amount,
    paymentMethod: method,
    paymentDate: date,
    transactionReference: reference || "",
    notes: notes || "Demo seed payment",
  });

const cleanupPreviousDemo = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    log("⚠ MONGO_URI missing — skipping direct cleanup");
    return;
  }

  await mongoose.connect(uri);

  const User = require("../models/user.model");
  const Customer = require("../models/customer.model");
  const StaffProfile = require("../models/staffProfile.model");
  const Payment = require("../models/payment.model");
  const Scheme = require("../models/scheme.model");
  const CashSubmission = require("../models/cashSubmission.model");

  let Notification = null;
  try {
    Notification = require("../models/notification.model");
  } catch {
    Notification = null;
  }

  const demoUsers = await User.find({ phone: { $in: DEMO_PHONES } }).select(
    "_id role phone"
  );
  const userIds = demoUsers.map((u) => u._id);
  const staffUserIds = demoUsers
    .filter((u) => u.role === "STAFF")
    .map((u) => u._id);

  // Orphan staff profiles (user deleted but profile remains) block employee-code reuse
  const allProfiles = await StaffProfile.find({}).select("_id user notes");
  const orphanProfileIds = [];
  for (const profile of allProfiles) {
    const user = await User.findById(profile.user).select("phone role");
    if (
      !user ||
      DEMO_PHONES.includes(user.phone) ||
      (profile.notes || "").toLowerCase().includes("demo agent")
    ) {
      orphanProfileIds.push(profile._id);
      if (user && user.role === "STAFF") staffUserIds.push(user._id);
    }
  }
  if (orphanProfileIds.length) {
    await StaffProfile.deleteMany({ _id: { $in: orphanProfileIds } });
  }

  const customers = await Customer.find({
    $or: [{ user: { $in: userIds } }, { phone: { $in: DEMO_PHONES } }],
  }).select("_id user phone");

  const customerIds = customers.map((c) => c._id);
  const customerUserIds = customers.map((c) => c.user).filter(Boolean);

  const schemes = await Scheme.find({ customer: { $in: customerIds } }).select("_id");
  const schemeIds = schemes.map((s) => s._id);

  if (customerIds.length || staffUserIds.length) {
    await Payment.deleteMany({
      $or: [
        { customer: { $in: customerIds } },
        { scheme: { $in: schemeIds } },
        { collectedBy: { $in: staffUserIds } },
      ],
    });
    await CashSubmission.deleteMany({ staff: { $in: staffUserIds } });

    if (Notification) {
      await Notification.deleteMany({
        $or: [
          { user: { $in: [...userIds, ...customerUserIds] } },
          { customer: { $in: customerIds } },
        ],
      });
    }

    await Scheme.deleteMany({ _id: { $in: schemeIds } });
    await Customer.deleteMany({ _id: { $in: customerIds } });
    await StaffProfile.deleteMany({ user: { $in: staffUserIds } });
  }

  await User.deleteMany({
    $or: [{ phone: { $in: DEMO_PHONES } }, { _id: { $in: customerUserIds } }],
  });

  if (process.env.RESET_DEMO_COUNTERS === "true") {
    const ReceiptCounter = require("../models/receiptCounter.model");
    await ReceiptCounter.deleteMany({});
    log("✓ Receipt/enrollment/passbook counters reset (RESET_DEMO_COUNTERS=true)");
  }

  log("✓ Cleared previous demo seed data (admin user preserved)");
  await mongoose.disconnect();
};

const addPayments = async (token, owner, customerId, schemeId, entries, label, stats) => {
  for (const entry of entries) {
    await collect(token, {
      customerId,
      schemeId,
      amount: entry.amount,
      method: entry.method,
      date: entry.date,
      reference: entry.reference,
      notes: entry.notes || `${label} — ${entry.method} ${entry.amount}`,
    });
    trackPayment(stats, owner, entry.method, entry.amount);
  }
};

const findScheme = (detail, schemeId) =>
  flattenCustomerSchemes(detail).find((s) => String(s._id) === String(schemeId));

const run = async () => {
  log(`\nAJ Gold Rich Demo Seed → ${BASE_URL}\n`);

  await cleanupPreviousDemo();

  const health = await request({ method: "GET", path: "/api/health" });
  if (health.status !== 200) {
    fail(`Backend not reachable at ${BASE_URL}. Start server: npm start`);
  }
  log("✓ Backend health OK");

  const adminToken = await login(ADMIN_PHONE, ADMIN_PASSWORD);
  log(`✓ Admin logged in (${ADMIN_PHONE})`);

  const stats = emptyStats();
  const staffIds = {};
  const staffTokens = {};

  for (const agent of STAFF) {
    const created = await api("POST", "/api/admin/staff", adminToken, {
      name: agent.name,
      phone: agent.phone,
      password: STAFF_PASSWORD,
      notes: agent.notes,
      permissions: { canCreateCustomer: true, canCollectPayment: true },
    });
    staffIds[agent.key] = getStaffUserId(created);
    staffTokens[agent.key] = await login(agent.phone, STAFF_PASSWORD);
    log(`✓ Staff: ${agent.name} (${agent.phone})`);
  }

  const customers = {};
  const schemes = {};

  for (const c of CUSTOMERS) {
    const created = await api("POST", "/api/customers", adminToken, {
      name: c.name,
      phone: c.phone,
      address: c.address,
      nominee: c.nominee,
    });
    const customerId = getId(created);
    customers[c.key] = { ...created, _id: customerId, owner: c.owner, scenario: c.scenario };
    log(`✓ Customer: ${c.name} — passbook ${created.passbookNumber}`);

    const scheme = await api("POST", "/api/schemes", adminToken, {
      customerId,
      startDate: c.startDate,
    });
    schemes[c.key] = scheme;
    log(`  ↳ ${scheme.enrollmentNumber} — ${c.scenario}`);
  }

  log("\nCreating 77 payments (11 per customer)...\n");

  for (const c of CUSTOMERS) {
    const plan = PAYMENT_PLANS[c.key];
    if (!plan || plan.length !== 11) {
      fail(`Expected 11 payments for ${c.key}, got ${plan?.length || 0}`);
    }
    await addPayments(
      staffTokens[c.owner],
      c.owner,
      customers[c.key]._id,
      schemes[c.key]._id,
      plan,
      c.name,
      stats
    );
    log(`✓ ${c.name}: 11 payments (${c.owner === "arun" ? "Arun" : "Sreeshma"})`);
  }

  log("\nSubmitting partial cash to vault...\n");

  await api("POST", "/api/admin/cash-submissions", adminToken, {
    staff: staffIds.arun,
    submittedAmount: ARUN_SUBMISSION,
    submissionDate: "2026-07-05T13:00:00.000Z",
    receivedBy: "Admin User",
    notes: "Partial vault deposit — Arun demo",
  });
  log(`✓ Arun submitted ${formatINR(ARUN_SUBMISSION)} (partial)`);

  await api("POST", "/api/admin/cash-submissions", adminToken, {
    staff: staffIds.sreeshma,
    submittedAmount: SREESHMA_SUBMISSION,
    submissionDate: "2026-07-05T13:30:00.000Z",
    receivedBy: "Admin User",
    notes: "Partial vault deposit — Sreeshma demo",
  });
  log(`✓ Sreeshma submitted ${formatINR(SREESHMA_SUBMISSION)} (partial)`);

  const totalCashSubmitted = ARUN_SUBMISSION + SREESHMA_SUBMISSION;
  const arunCashInHandExpected = stats.arunCash - ARUN_SUBMISSION;
  const sreeshmaCashInHandExpected = stats.sreeshmaCash - SREESHMA_SUBMISSION;

  log("\nVerifying via API...\n");

  const arunDetail = await api("GET", `/api/admin/staff/${staffIds.arun}`, adminToken);
  const sreeshmaDetail = await api(
    "GET",
    `/api/admin/staff/${staffIds.sreeshma}`,
    adminToken
  );

  const sureshDetail = await api(
    "GET",
    `/api/customers/${customers.suresh._id}`,
    adminToken
  );
  const meeraDetail = await api(
    "GET",
    `/api/customers/${customers.meera._id}`,
    adminToken
  );
  const deepakDetail = await api(
    "GET",
    `/api/customers/${customers.deepak._id}`,
    adminToken
  );

  const sureshRemaining = getRemainingAllowed(findScheme(sureshDetail, schemes.suresh._id));
  const meeraRemaining = getRemainingAllowed(findScheme(meeraDetail, schemes.meera._id));
  const deepakRemaining = getRemainingAllowed(findScheme(deepakDetail, schemes.deepak._id));

  const arunCashInHand = cashInHandOf(arunDetail);
  const sreeshmaCashInHand = cashInHandOf(sreeshmaDetail);

  const adminDashboard = await api("GET", "/api/dashboard/admin", adminToken);
  const cashPosition = await api("GET", "/api/reports/cash-position", adminToken);
  const staffPerformance = await api("GET", "/api/reports/staff-performance", adminToken);
  const collectionReport = await api("GET", "/api/reports/collections", adminToken);

  if (!adminDashboard) fail("Admin dashboard fetch failed");
  if (!cashPosition) fail("Cash position report fetch failed");
  if (!staffPerformance?.staff?.length) fail("Staff performance report fetch failed");
  if (!collectionReport) fail("Collection report fetch failed");

  log("✓ Admin dashboard fetched");
  log("✓ Cash position report fetched");
  log("✓ Staff performance report fetched");
  log("✓ Collection report fetched");

  if (stats.paymentCount < 75) {
    fail(`Total payments ${stats.paymentCount} < 75`);
  }
  if (totalCashSubmitted < 300000) {
    fail(`Cash submitted ${totalCashSubmitted} < 300000`);
  }
  if (cashPosition.totalCashSubmittedToVault < 300000) {
    fail(
      `Vault cash ${cashPosition.totalCashSubmittedToVault} < 300000 (from cash position report)`
    );
  }
  if (arunCashInHand <= 0) {
    fail(`Arun cash in hand ${arunCashInHand} must be > 0`);
  }
  if (sreeshmaCashInHand <= 0) {
    fail(`Sreeshma cash in hand ${sreeshmaCashInHand} must be > 0`);
  }
  if (arunCashInHand !== arunCashInHandExpected) {
    fail(`Arun cash in hand expected ${arunCashInHandExpected}, got ${arunCashInHand}`);
  }
  if (sreeshmaCashInHand !== sreeshmaCashInHandExpected) {
    fail(
      `Sreeshma cash in hand expected ${sreeshmaCashInHandExpected}, got ${sreeshmaCashInHand}`
    );
  }
  if (sureshRemaining !== 0) {
    fail(`Suresh remainingAllowedPayment expected 0, got ${sureshRemaining}`);
  }
  if (meeraRemaining !== 0) {
    fail(`Meera remainingAllowedPayment expected 0, got ${meeraRemaining}`);
  }
  if (deepakRemaining <= 0) {
    fail(`Deepak remainingAllowedPayment expected > 0, got ${deepakRemaining}`);
  }

  log("✓ All verification checks passed\n");

  log("══════════════════════════════════════════════════════════");
  log("  AJ GOLD DEMO SEED — READY FOR CLIENT RECORDING");
  log("══════════════════════════════════════════════════════════");

  log("\n── LOGIN CREDENTIALS ──");
  log(`  Admin       ${ADMIN_PHONE} / ${ADMIN_PASSWORD}`);
  log(`  Arun Nair   ${STAFF[0].phone} / ${STAFF_PASSWORD}`);
  log(`  Sreeshma    ${STAFF[1].phone} / ${STAFF_PASSWORD}`);

  log("\n── CUSTOMERS (phone / passbook password) ──");
  for (const c of CUSTOMERS) {
    const row = customers[c.key];
    log(`  ${row.name.padEnd(18)} ${row.phone}  passbook ${row.passbookNumber}`);
  }

  log("\n── PAYMENT TOTALS ──");
  log(`  Total payments:     ${stats.paymentCount}`);
  log(`  Total CASH:         ${formatINR(stats.CASH)}`);
  log(`  Total UPI:          ${formatINR(stats.UPI)}`);
  log(`  Total BANK:         ${formatINR(stats.BANK)}`);
  log(`  Total CARD:         ${formatINR(stats.CARD)}`);

  log("\n── CASH / VAULT ──");
  log(`  Arun CASH collected:     ${formatINR(stats.arunCash)}`);
  log(`  Arun submitted:          ${formatINR(ARUN_SUBMISSION)}`);
  log(`  Arun cash in hand:       ${formatINR(arunCashInHand)}`);
  log(`  Sreeshma CASH collected: ${formatINR(stats.sreeshmaCash)}`);
  log(`  Sreeshma submitted:      ${formatINR(SREESHMA_SUBMISSION)}`);
  log(`  Sreeshma cash in hand:   ${formatINR(sreeshmaCashInHand)}`);
  log(`  Cash in vault:           ${formatINR(cashPosition.totalCashInVault)}`);

  log("\n── SCHEME LIMITS ──");
  log(`  Suresh remaining payable:  ${formatINR(sureshRemaining)} (cap exhausted)`);
  log(`  Meera remaining payable:   ${formatINR(meeraRemaining)} (cap exhausted)`);
  log(`  Deepak remaining payable:  ${formatINR(deepakRemaining)} (partial cap used)`);

  log("\n── DEMO SCENARIOS ──");
  log("  • Anjali / Fathima — pre-6-month, limit forming");
  log("  • Joseph — near six-month point, long history");
  log("  • Rahul — rich mixed-method history");
  log("  • Deepak — post-6-month, partial cap remaining");
  log("  • Suresh / Meera — active, cap fully used");
  log("  • Both agents — partial vault submission, pending cash in hand");
  log("  • July 2026 — many recent payments for live-looking reports");
  log("══════════════════════════════════════════════════════════\n");
};

run().catch((err) => {
  console.error("\nDemo seed failed:", err.message);
  process.exit(1);
});
