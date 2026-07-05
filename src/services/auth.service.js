const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { logAudit } = require("./audit.service");
const ApiError = require("../utils/ApiError");
const { JWT_SECRET, JWT_EXPIRES_IN } = require("../config/env");
const { AUDIT_ACTIONS } = require("../constants/enums");

const login = async ({ phone, password }) => {
  if (!phone?.trim() || !password) {
    throw new ApiError(400, "Phone and password are required.");
  }

  const user = await User.findOne({ phone: phone.trim() }).select("+passwordHash");
  if (!user) throw new ApiError(401, "Invalid phone or password.");
  if (user.status === "INACTIVE") throw new ApiError(403, "Account is inactive.");
  if (!user.passwordHash) {
    throw new ApiError(401, "Invalid phone or password.");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) throw new ApiError(401, "Invalid phone or password.");

  user.lastLoginAt = new Date();
  await user.save();

  const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  await logAudit({
    actor: user._id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.LOGIN,
    targetType: "User",
    targetId: user._id,
    notes: "User logged in",
  });

  return {
    token,
    user: { _id: user._id, name: user.name, phone: user.phone, role: user.role, status: user.status },
  };
};

const me = async (user) => ({
  user: {
    _id: user._id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    status: user.status,
  },
});

module.exports = { login, me };
