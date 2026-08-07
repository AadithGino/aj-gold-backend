require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/user.model");
const { USER_ROLES, USER_STATUS } = require("../constants/enums");
const { NODE_ENV, SEED_ALLOW_PRODUCTION } = require("../config/env");

const assertSeedAllowed = () => {
  if (NODE_ENV === "production" && !SEED_ALLOW_PRODUCTION) {
    throw new Error("Refusing to run seed against production. Set SEED_ALLOW_PRODUCTION=true to override.");
  }
};

const seed = async () => {
  assertSeedAllowed();

  const phone = process.env.DEFAULT_ADMIN_PHONE;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  const name = process.env.DEFAULT_ADMIN_NAME || "Admin";

  if (!phone || !password) {
    throw new Error("DEFAULT_ADMIN_PHONE and DEFAULT_ADMIN_PASSWORD are required for seed:admin.");
  }

  if (password.length < 8) {
    throw new Error("DEFAULT_ADMIN_PASSWORD must be at least 8 characters.");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ phone }).select("+passwordHash");

  if (existing) {
    if (!existing.passwordHash) {
      existing.passwordHash = await bcrypt.hash(password, 12);
      await existing.save();
      console.log(`Admin password repaired for: ${existing.name} (${existing.phone})`);
    } else {
      console.log(`Admin already exists: ${existing.name} (${existing.phone})`);
    }
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await User.create({
    name,
    phone,
    passwordHash,
    role: USER_ROLES.ADMIN,
    status: USER_STATUS.ACTIVE,
  });

  console.log(`Admin created: ${name} / ${phone}`);
  await mongoose.disconnect();
};

seed().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
