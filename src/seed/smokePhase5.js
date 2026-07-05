/**
 * Phase 5 smoke test — payment collection, limits, receipts, reversal.
 * Run: npm run smoke:phase5
 */
const mongoose = require("mongoose");
const env = require("../config/env");
const { connectDb } = require("../config/db");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const Payment = require("../models/payment.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
} = require("../constants/enums");
const { createStaff } = require("../services/staff.service");
const { createCustomer } = require("../services/customer.service");
const { createScheme } = require("../services/schemeManagement.service");
const { collectPayment, reversePayment } = require("../services/payment.service");
const { getStaffCashInHand, getReceiptDisplayData } = require("../services/cash.service");
const { getTotalPaidForScheme } = require("../services/paymentLimit.service");
const ApiError = require("../utils/ApiError");

const SMOKE_TAG = "SMOKE-P5";
const PASSBOOK_FORMAT = /^\d{4}$/;

const assert = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
};

const cleanupP5 = async ({ customerIds = [], staffUserId, staffProfileId }) => {
  if (customerIds.length) {
    await Payment.deleteMany({ customer: { $in: customerIds } });
    await Scheme.deleteMany({ customer: { $in: customerIds } });
    const customers = await Customer.find({ _id: { $in: customerIds } }).select("user");
    await Customer.deleteMany({ _id: { $in: customerIds } });
    const userIds = customers.map((c) => c.user).filter(Boolean);
    if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
  }
  if (staffUserId) {
    await Payment.deleteMany({ collectedBy: staffUserId });
  }
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
  const staffPhone = `7${String(Date.now()).slice(-9)}`;
  let staffUser = null;
  let staffProfile = null;
  let customer = null;
  let customerUserId = null;

  try {
    ({ user: staffUser, profile: staffProfile } = await createStaff(
      {
        name: "Smoke P5 Staff",
        phone: staffPhone,
        password: "staff123",
        notes: runTag,
      },
      admin
    ));

    customer = await createCustomer(
      {
        name: "Smoke P5 Customer",
        phone: `6${String(Date.now()).slice(-9)}`,
        address: "Smoke P5 Address",
      },
      admin
    );
    customerUserId = customer.user;

    assert(Boolean(customer.passbookNumber), "Customer created without manual passbook input");
    assert(PASSBOOK_FORMAT.test(customer.passbookNumber), "Passbook auto-generated (4-digit)");

    const scheme = await createScheme(
      { customerId: customer._id.toString(), startDate: new Date("2025-01-01") },
      admin
    );
    assert(scheme.enrollmentNumber.startsWith("AJGK-ENR-"), "Scheme created with enrollmentNumber");

    const cashResult = await collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 30000,
        paymentMethod: PAYMENT_METHODS.CASH,
        paymentDate: new Date("2025-02-01"),
      },
      staffUser
    );
    assert(cashResult.payment.amount === 30000, "CASH payment collected");

    let cashSummary = await getStaffCashInHand(staffUser._id);
    assert(cashSummary.cashCollected === 30000, "CASH increases staff cash collected");
    assert(cashSummary.cashInHand === 30000, "CASH increases staff cash in hand");

    const receipt = await getReceiptDisplayData(cashResult.payment._id);
    assert(receipt.passbookNumber === customer.passbookNumber, "Receipt includes passbook number");
    assert(receipt.enrollmentNumber === scheme.enrollmentNumber, "Receipt includes enrollment number");

    await collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 30000,
        paymentMethod: PAYMENT_METHODS.CASH,
        paymentDate: new Date("2025-04-01"),
      },
      staffUser
    );

    cashSummary = await getStaffCashInHand(staffUser._id);
    assert(cashSummary.cashCollected === 60000, "Second CASH payment included in cash collected");

    let staffBlocked = false;
    try {
      await collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 70000,
          paymentMethod: PAYMENT_METHODS.CASH,
          paymentDate: new Date("2025-08-01"),
        },
        staffUser
      );
    } catch (error) {
      staffBlocked = error instanceof ApiError && error.statusCode === 403;
    }
    assert(staffBlocked, "Over-limit staff payment blocked");

    const overrideResult = await collectPayment(
      {
        customer: customer._id.toString(),
        scheme: scheme._id.toString(),
        amount: 70000,
        paymentMethod: PAYMENT_METHODS.CASH,
        paymentDate: new Date("2025-08-01"),
        overrideReason: `${runTag} admin override for smoke test`,
      },
      admin
    );
    assert(overrideResult.payment.isLimitOverride === true, "Admin override with reason works");

    cashSummary = await getStaffCashInHand(staffUser._id);
    assert(cashSummary.cashCollected === 60000, "Staff CASH only before admin override (60000)");
    assert(cashSummary.cashInHand === 60000, "Staff cash in hand before non-cash methods");

    for (const method of [PAYMENT_METHODS.UPI, PAYMENT_METHODS.BANK, PAYMENT_METHODS.CARD]) {
      await collectPayment(
        {
          customer: customer._id.toString(),
          scheme: scheme._id.toString(),
          amount: 5000,
          paymentMethod: method,
          paymentDate: new Date("2025-03-01"),
          transactionReference: `${runTag}-${method}`,
        },
        staffUser
      );
    }

    cashSummary = await getStaffCashInHand(staffUser._id);
    assert(cashSummary.cashCollected === 60000, "UPI/BANK/CARD do not increase cash collected");
    assert(cashSummary.cashInHand === 60000, "UPI/BANK/CARD do not increase cash in hand");

    const totalBeforeReverse = await getTotalPaidForScheme(scheme._id);
    const expectedTotal = 30000 + 30000 + 70000 + 5000 * 3;
    assert(totalBeforeReverse === expectedTotal, "Total paid includes all SUCCESS payments before reverse");

    cashSummary = await getStaffCashInHand(staffUser._id);
    const cashBeforeReverse = cashSummary.cashCollected;
    assert(cashBeforeReverse === 60000, "Staff cash collected before reverse");

    await reversePayment(
      cashResult.payment._id,
      { reason: `${runTag} reversal`, notes: "Smoke reverse" },
      admin
    );

    const reversed = await Payment.findById(cashResult.payment._id);
    assert(reversed.status === PAYMENT_STATUS.REVERSED, "Payment marked REVERSED");

    const totalAfterReverse = await getTotalPaidForScheme(scheme._id);
    assert(totalAfterReverse === totalBeforeReverse - 30000, "Reversed payment excluded from scheme total");

    cashSummary = await getStaffCashInHand(staffUser._id);
    assert(
      cashSummary.cashCollected === cashBeforeReverse - 30000,
      "Reversed CASH payment excluded from cash collected / cash in hand"
    );

    console.log("\nPhase 5 smoke test completed successfully.");
  } finally {
    await cleanupP5({
      customerIds: customer ? [customer._id] : [],
      staffUserId: staffUser?._id,
      staffProfileId: staffProfile?._id,
    });
  }
};

run()
  .catch((error) => {
    console.error("\nPhase 5 smoke test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
