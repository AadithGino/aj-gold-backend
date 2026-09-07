#!/usr/bin/env node
/**
 * Dev helper: look up a phone's login identity without printing hashes or secrets.
 * Usage: node scripts/lookup-login-user.js 9895713567
 */
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MONGO_URI } = require("../src/config/env");
const User = require("../src/models/user.model");
const Customer = require("../src/models/customer.model");
const LoginAttempt = require("../src/models/loginAttempt.model");

const phone = String(process.argv[2] || "").replace(/\D/g, "");
if (phone.length < 10) {
  console.error("Usage: node scripts/lookup-login-user.js <10-digit-phone>");
  process.exit(1);
}

const main = async () => {
  await mongoose.connect(MONGO_URI);
  const digits = phone.slice(-10);
  const users = await User.find({
    $or: [{ phone: digits }, { phone: { $regex: `${digits}$` } }],
  }).select("name phone role status tokenVersion lastLoginAt +passwordHash");

  if (!users.length) {
    console.log(`No user found for phone ending ${digits}.`);
    await mongoose.disconnect();
    return;
  }

  for (const user of users) {
    const customer = await Customer.findOne({ user: user._id }).select(
      "passbookNumber name phone status"
    );
    const passbook = customer?.passbookNumber || "";
    const candidates = [...new Set(["0001", "00001", passbook, digits].filter(Boolean))];
    const matches = [];
    for (const candidate of candidates) {
      if (user.passwordHash && (await bcrypt.compare(candidate, user.passwordHash))) {
        matches.push(candidate);
      }
    }
    const locks = await LoginAttempt.find({
      key: { $in: [`account:${user.phone}`, `account:${digits}`] },
    }).select("key failedCount lockedUntil");

    console.log("---");
    console.log(`name: ${user.name}`);
    console.log(`role: ${user.role}`);
    console.log(`status: ${user.status}`);
    console.log(`stored phone: ${user.phone}`);
    console.log(`passbook: ${passbook || "(none — not a customer record)"}`);
    console.log(`has password hash: ${Boolean(user.passwordHash)}`);
    console.log(
      matches.length
        ? `password matches: ${matches.join(", ")}`
        : "password does not match passbook, 0001, or the phone number (a custom password was set)"
    );
    if (locks.length) {
      for (const lock of locks) {
        console.log(
          `login attempts: ${lock.key} failed=${lock.failedCount || 0} lockedUntil=${
            lock.lockedUntil || "none"
          }`
        );
      }
    } else {
      console.log("login lock: none");
    }
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
