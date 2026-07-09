/**
 * Phase 8 smoke test — correction approval + customer payout ledger.
 * Run: npm run smoke:phase8
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
const PaymentCorrection = require("../models/paymentCorrection.model");
const CustomerPayout = require("../models/customerPayout.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  CORRECTION_TYPES,
  CORRECTION_STATUS,
  SCHEME_STATUS,
  PAYOUT_TYPES,
} = require("../constants/enums");
const { createStaff } = require("../services/staff.service");
const { createCustomer } = require("../services/customer.service");
const { createScheme } = require("../services/schemeManagement.service");
const { collectPayment } = require("../services/payment.service");
const { createCashSubmission } = require("../services/cash.service");
const { getCashPositionSummary } = require("../services/cashPosition.service");
const { getCustomerLedger, getSchemeLedger } = require("../services/report.service");
const { getStaffCashInHand } = require("../services/cash.service");

const SMOKE_TAG = "SMOKE-P8";

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

const cleanupP8 = async ({ customerIds = [], staffUserId, staffProfileId, submissionIds = [] }) => {
  if (customerIds.length) {
    await PaymentCorrection.deleteMany({ customer: { $in: customerIds } });
    await CustomerPayout.deleteMany({ customer: { $in: customerIds } });
    await Payment.deleteMany({ customer: { $in: customerIds } });
    const Scheme = require("../models/scheme.model");
    await Scheme.deleteMany({ customer: { $in: customerIds } });
    const customers = await Customer.find({ _id: { $in: customerIds } }).select("user");
    await Customer.deleteMany({ _id: { $in: customerIds } });
    const userIds = customers.map((c) => c.user).filter(Boolean);
    if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
  }
  if (submissionIds.length) {
    const CashSubmission = require("../models/cashSubmission.model");
    await CashSubmission.deleteMany({ _id: { $in: submissionIds } });
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
  const staffPhone = `3${String(Date.now()).slice(-9)}`;
  let staffUser = null;
  let staffProfile = null;
  let customer = null;
  let scheme = null;
  let cashPayment = null;
  let upiPayment = null;
  let bankPayment = null;
  let submissionId = null;

  try {
    ({ user: staffUser, profile: staffProfile } = await createStaff(
      {
        name: "Smoke P8 Staff",
        phone: staffPhone,
        password: "staff123",
        notes: runTag,
      },
      admin
    ));

    customer = await createCustomer(
      {
        name: "Smoke P8 Customer",
        phone: `2${String(Date.now()).slice(-9)}`,
        address: "Smoke P8 Address",
      },
      admin
    );
    assert(Boolean(customer.passbookNumber), "Customer created without manual passbook");

    scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: new Date("2025-01-01") },
      admin
    );

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

    upiPayment = (
      await collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 5000,
          paymentMethod: PAYMENT_METHODS.UPI,
          paymentDate: new Date("2025-03-01"),
          transactionReference: `${runTag}-UPI`,
        },
        staffUser
      )
    ).payment;

    bankPayment = (
      await collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 3000,
          paymentMethod: PAYMENT_METHODS.BANK,
          paymentDate: new Date("2025-04-01"),
          transactionReference: `${runTag}-BANK`,
        },
        staffUser
      )
    ).payment;

    const cashBefore = await getStaffCashInHand(staffUser._id);
    assert(cashBefore.cashInHand === 10000, "Staff cash in hand before corrections is 10000");

    const server = app.listen(0);
    const port = server.address().port;
    const adminToken = jwt.sign({ id: admin._id, role: admin.role }, env.jwtSecret, { expiresIn: "1h" });
    const staffToken = jwt.sign({ id: staffUser._id, role: staffUser.role }, env.jwtSecret, { expiresIn: "1h" });
    const customerUser = await User.findById(customer.user);
    const customerToken = jwt.sign({ id: customerUser._id, role: customerUser.role }, env.jwtSecret, {
      expiresIn: "1h",
    });

    try {
      const amountCorrectionReq = await requestJson(port, {
        method: "POST",
        path: `/api/payments/${cashPayment._id}/correction-request`,
        token: staffToken,
        body: {
          correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
          requestedValue: 15000,
          reason: `${runTag} amount correction`,
        },
      });
      assert(amountCorrectionReq.status === 201, "Staff correction request created");
      const correctionId = amountCorrectionReq.body.data._id;

      const paymentPending = await Payment.findById(cashPayment._id);
      assert(paymentPending.amount === 10000, "Payment unchanged while correction PENDING");

      const approveRes = await requestJson(port, {
        method: "POST",
        path: `/api/corrections/${correctionId}/approve`,
        token: adminToken,
        body: { reviewNotes: "Approved for smoke test" },
      });
      assert(approveRes.status === 200, "Admin approves amount correction");

      const paymentCorrected = await Payment.findById(cashPayment._id);
      assert(paymentCorrected.amount === 15000, "Payment amount updated after approval");

      const cashAfterCorrection = await getStaffCashInHand(staffUser._id);
      assert(cashAfterCorrection.cashInHand === 15000, "Cash in hand reflects corrected CASH amount");

      const reverseCorrectionReq = await requestJson(port, {
        method: "POST",
        path: `/api/payments/${upiPayment._id}/correction-request`,
        token: staffToken,
        body: {
          correctionType: CORRECTION_TYPES.REVERSE_PAYMENT,
          reason: `${runTag} reverse via correction`,
        },
      });
      assert(reverseCorrectionReq.status === 201, "Staff reverse correction request created");
      const reverseCorrectionId = reverseCorrectionReq.body.data._id;

      const rejectTarget = await requestJson(port, {
        method: "POST",
        path: `/api/payments/${bankPayment._id}/correction-request`,
        token: staffToken,
        body: {
          correctionType: CORRECTION_TYPES.EDIT_AMOUNT,
          requestedValue: 9999,
          reason: `${runTag} reject me`,
        },
      });
      assert(rejectTarget.status === 201, "Second correction request for reject test");
      const rejectId = rejectTarget.body.data._id;

      const rejectRes = await requestJson(port, {
        method: "POST",
        path: `/api/corrections/${rejectId}/reject`,
        token: adminToken,
        body: { reviewNotes: "Rejected in smoke test" },
      });
      assert(rejectRes.status === 200, "Admin rejects correction");
      const bankAfterReject = await Payment.findById(bankPayment._id);
      assert(bankAfterReject.amount === 3000, "Rejected correction did not change payment");

      const approveReverse = await requestJson(port, {
        method: "POST",
        path: `/api/corrections/${reverseCorrectionId}/approve`,
        token: adminToken,
        body: { reviewNotes: "Reverse approved" },
      });
      assert(approveReverse.status === 200, "Admin approves reverse correction");
      const reversedUpi = await Payment.findById(upiPayment._id);
      assert(reversedUpi.status === PAYMENT_STATUS.REVERSED, "Payment marked REVERSED after approval");

      const positionBeforeSubmission = await getCashPositionSummary();
      assert(positionBeforeSubmission.payoutTrackingImplemented === true, "Payout tracking enabled");

      const { submission } = await createCashSubmission(
        {
          staff: staffUser._id,
          submittedAmount: 15000,
          submissionDate: new Date(),
          receivedBy: "Admin User",
          notes: runTag,
        },
        admin
      );
      submissionId = submission._id;

      const positionAfterSubmission = await getCashPositionSummary();
      assert(
        positionAfterSubmission.totalCashWithStaff === positionBeforeSubmission.totalCashWithStaff - 15000,
        "Cash submission decreases Cash With Staff"
      );
      assert(
        positionAfterSubmission.cashInVault === positionBeforeSubmission.cashInVault + 15000,
        "Cash submission increases Cash in Vault"
      );
      assert(
        positionAfterSubmission.totalCollectedFromCustomers === positionBeforeSubmission.totalCollectedFromCustomers,
        "Cash submission does not change total collected from customers"
      );

      const cashPayoutRes = await requestJson(port, {
        method: "POST",
        path: "/api/payouts",
        token: adminToken,
        body: {
          customerId: customer._id.toString(),
          schemeId: scheme._id.toString(),
          payoutType: PAYOUT_TYPES.REDEMPTION,
          payoutMethod: PAYMENT_METHODS.CASH,
          amount: 4000,
          referenceNumber: `${runTag}-CASH-PAY`,
          notes: "Smoke cash payout",
        },
      });
      assert(cashPayoutRes.status === 201, "Admin creates CASH payout");
      assert(cashPayoutRes.body.data.payoutNumber.startsWith("AJGK-PAY-"), "Payout number generated");

      const bankPayoutRes = await requestJson(port, {
        method: "POST",
        path: "/api/payouts",
        token: adminToken,
        body: {
          customerId: customer._id.toString(),
          schemeId: scheme._id.toString(),
          payoutType: PAYOUT_TYPES.WITHDRAWAL,
          payoutMethod: PAYMENT_METHODS.BANK,
          amount: 2000,
          referenceNumber: `${runTag}-BANK-PAY`,
          applySchemeStatus: SCHEME_STATUS.REDEEMED,
          notes: "Smoke bank payout with redeem",
        },
      });
      assert(bankPayoutRes.status === 201, "Admin creates BANK payout with REDEEMED status");

      const Scheme = require("../models/scheme.model");
      const schemeAfter = await Scheme.findById(scheme._id);
      assert(schemeAfter.status === SCHEME_STATUS.REDEEMED, "Scheme status updated to REDEEMED");
      assert(schemeAfter.statusHistory.some((h) => h.status === SCHEME_STATUS.REDEEMED), "statusHistory recorded");

      const cashPosition = await getCashPositionSummary();
      assert(cashPosition.totalCustomerPayout === 6000, "Total customer payout is 6000");
      assert(cashPosition.totalCashCustomerPayout === 4000, "Cash customer payout is 4000");
      assert(cashPosition.totalBankCustomerPayout === 2000, "Bank customer payout is 2000");
      assert(cashPosition.totalCashInVault === cashPosition.cashInVault, "totalCashInVault equals cashInVault");
      assert(
        cashPosition.cashInVault ===
          cashPosition.totalCashSubmittedToVault +
            cashPosition.totalUpiCollectedFromCustomers +
            cashPosition.totalBankCollectedFromCustomers +
            cashPosition.totalCardCollectedFromCustomers -
            cashPosition.totalCustomerPayout,
        "Cash in Vault = submitted cash + UPI + Bank + Card collections - all payouts"
      );
      assert(
        cashPosition.cashInVault === positionAfterSubmission.cashInVault - 6000,
        "All customer payouts reduce Cash in Vault"
      );

      const customerLedger = await getCustomerLedger(customer._id);
      assert((customerLedger.payoutHistory || []).length >= 1, "Customer ledger includes payouts");

      const schemeLedger = await getSchemeLedger(scheme._id);
      assert((schemeLedger.successfulPayouts || []).length >= 1, "Scheme ledger includes payouts");

      const staffApproveBlock = await requestJson(port, {
        method: "POST",
        path: `/api/corrections/${correctionId}/approve`,
        token: staffToken,
        body: {},
      });
      assert(staffApproveBlock.status === 403, "Staff cannot approve corrections");

      const staffPayoutBlock = await requestJson(port, {
        method: "POST",
        path: "/api/payouts",
        token: staffToken,
        body: {
          customerId: customer._id.toString(),
          schemeId: scheme._id.toString(),
          payoutType: PAYOUT_TYPES.ADJUSTMENT,
          payoutMethod: PAYMENT_METHODS.CASH,
          amount: 100,
        },
      });
      assert(staffPayoutBlock.status === 403, "Staff cannot create payouts");

      const customerCorrectionBlock = await requestJson(port, {
        method: "GET",
        path: "/api/corrections",
        token: customerToken,
      });
      assert(customerCorrectionBlock.status === 403, "Customer blocked from corrections");

      const customerPayoutBlock = await requestJson(port, {
        method: "GET",
        path: "/api/payouts",
        token: customerToken,
      });
      assert(customerPayoutBlock.status === 403, "Customer blocked from payout admin routes");

      const correctionsList = await requestJson(port, {
        method: "GET",
        path: "/api/corrections?status=APPROVED",
        token: adminToken,
      });
      assert(correctionsList.status === 200, "Admin lists corrections");
      assertNoPasswordHash(correctionsList.body, "correctionsList");
    } finally {
      server.close();
    }

    console.log("\nPhase 8 smoke test completed successfully.");
  } finally {
    await cleanupP8({
      customerIds: customer ? [customer._id] : [],
      staffUserId: staffUser?._id,
      staffProfileId: staffProfile?._id,
      submissionIds: submissionId ? [submissionId] : [],
    });
  }
};

run()
  .catch((error) => {
    console.error("\nPhase 8 smoke test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
