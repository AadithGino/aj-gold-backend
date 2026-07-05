require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");
const User     = require("../models/user.model");
const { USER_ROLES, USER_STATUS } = require("../constants/enums");

const seed = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const phone    = process.env.DEFAULT_ADMIN_PHONE    || "9999999999";
  const password = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
  const name     = process.env.DEFAULT_ADMIN_NAME     || "Admin";

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

  console.log(`Admin created: ${name} / ${phone} / ${password}`);
  await mongoose.disconnect();
};

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
