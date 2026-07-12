/**
 * Phase 2 service smoke test — creates temporary data, verifies calculations, then cleans up.
 * Run: npm run smoke:phase2
 */
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const env = require("../config/env");
const User = require("../models/user.model");
const StaffProfile = require("../models/staffProfile.model");
const Customer = require("../models/customer.model");
const Scheme = require("../models/scheme.model");
const Payment = require("../models/payment.model");
const CashSubmission = require("../models/cashSubmission.model");
const {
  USER_ROLES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SCHEME_STATUS,
  AUDIT_ACTIONS,
} = require("../constants/enums");
const {
  calculateSchemeDates,
  assertCustomerCanCreateActiveScheme,
  appendStatusHistory,
  createEnrollmentNumber,
} = require("../services/scheme.service");
const {
  getTotalPaidForScheme,
  getFirstSixMonthsPaid,
  getAfterSixMonthsPaid,
  getSchemeLimitSummary,
  willNewPaymentExceedLimit,
} = require("../services/paymentLimit.service");
const { getPaymentMethodBreakdown, getReceiptDisplayData } = require("../services/cash.service");
const { getStaffCashInHand } = require("../services/staffCash.service");
const { generateReceiptNumber } = require("../services/receipt.service");
const { logAudit } = require("../services/audit.service");
const { createStaff } = require("../services/staff.service");
const ApiError = require("../utils/ApiError");

const SMOKE_TAG = "SMOKE-P2";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`PASS: ${message}`);
};

const cleanupP2 = async ({ customerId, staffUserId, staffProfileId }) => {
  if (customerId) {
    await Payment.deleteMany({ customer: customerId });
    await Scheme.deleteMany({ customer: customerId });
    const customer = await Customer.findById(customerId).select("user");
    await Customer.deleteOne({ _id: customerId });
    if (customer?.user) await User.deleteOne({ _id: customer.user });
  }
  if (staffUserId) {
    await Payment.deleteMany({ collectedBy: staffUserId });
    await CashSubmission.deleteMany({ staff: staffUserId });
  }
  if (staffProfileId) await StaffProfile.deleteOne({ _id: staffProfileId });
  if (staffUserId) await User.deleteOne({ _id: staffUserId });
};

const run = async () => {
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is not configured.");
  }

  await connectDb(env.mongoUri);

  const admin = await User.findOne({ role: USER_ROLES.ADMIN });
  assert(Boolean(admin), "Admin user exists for smoke test actor");

  const runTag = `${SMOKE_TAG}-${Date.now()}`;
  const staffPhone = `8${String(Date.now()).slice(-9)}`;
  let customer = null;
  let scheme = null;
  let staffUser = null;
  let staffProfile = null;

  try {
    ({ user: staffUser, profile: staffProfile } = await createStaff(
      {
        name: "Smoke P2 Staff",
        phone: staffPhone,
        password: "staff123",
        notes: runTag,
      },
      admin
    ));

    const passbookNumber = `${runTag}-PB`;
    customer = await Customer.create({
      customerCode: `${runTag}-CUST`,
      passbookNumber,
      name: "Smoke Test Customer",
      phone: `9${String(Date.now()).slice(-9)}`,
      address: "Smoke Test Address",
      nominee: { name: "Nominee", phone: "9000000001", relationship: "Spouse" },
      createdBy: admin._id,
      updatedBy: admin._id,
    });

    const startDate = new Date("2025-01-01");
    const dates = calculateSchemeDates(startDate);
    const enrollmentNumber = await createEnrollmentNumber(startDate);

    scheme = await Scheme.create({
      customer: customer._id,
      enrollmentNumber,
      startDate: dates.startDate,
      sixMonthDate: dates.sixMonthDate,
      maturityDate: dates.maturityDate,
      status: SCHEME_STATUS.ACTIVE,
      createdBy: admin._id,
      updatedBy: admin._id,
    });

    assert(scheme.enrollmentNumber.startsWith("AJGK-ENR-"), "Enrollment number generated");
    assert(dates.sixMonthDate > dates.startDate, "sixMonthDate calculated");
    assert(dates.maturityDate > dates.sixMonthDate, "maturityDate calculated");

    let guardBlocked = false;
    try {
      await assertCustomerCanCreateActiveScheme(customer._id);
    } catch (error) {
      guardBlocked = error instanceof ApiError && error.statusCode === 409;
    }
    assert(guardBlocked, "Active scheme guard blocks second active scheme");

    const receiptCash = await generateReceiptNumber();
    const receiptUpi = await generateReceiptNumber();

    await Payment.create({
      customer: customer._id,
      scheme: scheme._id,
      collectedBy: staffUser._id,
      collectedByRole: USER_ROLES.STAFF,
      amount: 30000,
      paymentMethod: PAYMENT_METHODS.CASH,
      paymentDate: new Date("2025-02-01"),
      receiptNumber: receiptCash,
      status: PAYMENT_STATUS.SUCCESS,
    });

    await Payment.create({
      customer: customer._id,
      scheme: scheme._id,
      collectedBy: staffUser._id,
      collectedByRole: USER_ROLES.STAFF,
      amount: 30000,
      paymentMethod: PAYMENT_METHODS.UPI,
      paymentDate: new Date("2025-03-01"),
      receiptNumber: receiptUpi,
      status: PAYMENT_STATUS.SUCCESS,
    });

    const totalPaid = await getTotalPaidForScheme(scheme._id);
    assert(totalPaid === 60000, "Total paid per scheme is 60000");

    const firstSix = await getFirstSixMonthsPaid(scheme._id, scheme.sixMonthDate);
    assert(firstSix === 60000, "First six months paid is 60000");

    const afterSix = await getAfterSixMonthsPaid(scheme._id, scheme.sixMonthDate);
    assert(afterSix === 0, "After six months paid is 0 before post-period payments");

    const limitSummary = await getSchemeLimitSummary(scheme._id);
    assert(limitSummary.remainingAllowedPayment === 60000, "Remaining allowed payment is 60000");

    const withinLimit = await willNewPaymentExceedLimit(scheme._id, 50000, new Date("2025-08-01"));
    assert(withinLimit.exceedsLimit === false, "50000 payment within remaining limit passes");

    const exceedsLimit = await willNewPaymentExceedLimit(scheme._id, 70000, new Date("2025-08-01"));
    assert(exceedsLimit.exceedsLimit === true, "70000 payment exceeding remaining limit blocked");

    await CashSubmission.create({
      staff: staffUser._id,
      submittedAmount: 10000,
      submissionDate: new Date("2025-08-02"),
      receivedBy: "Smoke Admin",
      notes: runTag,
      createdBy: admin._id,
    });

    const cashInHand = await getStaffCashInHand(staffUser._id);
    assert(cashInHand.cashCollected === 30000, "Isolated staff cash collected counts CASH only");
    assert(cashInHand.cashSubmitted === 10000, "Isolated staff cash submitted recorded");
    assert(cashInHand.cashInHand === 20000, "Isolated staff cash in hand is 20000");

    const breakdown = await getPaymentMethodBreakdown({ scheme: scheme._id });
    const cashRow = breakdown.find((row) => row.paymentMethod === PAYMENT_METHODS.CASH);
    const upiRow = breakdown.find((row) => row.paymentMethod === PAYMENT_METHODS.UPI);
    assert(cashRow?.total === 30000, "Payment method breakdown includes CASH");
    assert(upiRow?.total === 30000, "Payment method breakdown includes UPI");

    const paymentForReceipt = await Payment.findOne({ receiptNumber: receiptCash });
    const receiptData = await getReceiptDisplayData(paymentForReceipt._id);
    assert(receiptData.passbookNumber === passbookNumber, "Receipt shows customer passbookNumber");
    assert(receiptData.enrollmentNumber === enrollmentNumber, "Receipt shows scheme enrollmentNumber");
    assert(receiptData.amount === 30000, "Receipt shows payment amount");

    appendStatusHistory(scheme, {
      status: SCHEME_STATUS.REDEEMED,
      changedBy: admin._id,
      changedByRole: USER_ROLES.ADMIN,
      notes: "Smoke test redemption",
    });
    await scheme.save();
    assert(scheme.statusHistory.length === 1, "Scheme status history recorded");

    await logAudit({
      actor: admin._id,
      actorRole: USER_ROLES.ADMIN,
      action: AUDIT_ACTIONS.PAYMENT_COLLECTED,
      targetType: "Payment",
      targetId: paymentForReceipt._id,
      notes: "Smoke test audit entry",
    });

    console.log("\nPhase 2 smoke test completed successfully.");
  } finally {
    await cleanupP2({
      customerId: customer?._id,
      staffUserId: staffUser?._id,
      staffProfileId: staffProfile?._id,
    });
  }
};

run()
  .catch((error) => {
    console.error("\nPhase 2 smoke test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
