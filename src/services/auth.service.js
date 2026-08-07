const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { registerCustomer } = require("./customer.service");
const { logAudit } = require("./audit.service");
const ApiError = require("../utils/ApiError");
const { JWT_SECRET, JWT_EXPIRES_IN } = require("../config/env");
const { AUDIT_ACTIONS } = require("../constants/enums");
const {
  MIN_PASSWORD_LENGTH,
  assertPasswordStrength,
  generateTemporaryPassword,
} = require("../utils/password");

const signUserToken = (user) => {
  const tokenVersion = user.tokenVersion || 0;
  return jwt.sign(
    { id: user._id, role: user.role, tokenVersion },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

const login = async ({ phone, password }) => {
  if (!phone?.trim() || !password) {
    throw new ApiError(400, "Phone and password are required.");
  }

  const user = await User.findOne({ phone: phone.trim() }).select(
    "name phone role status tokenVersion +passwordHash"
  );
  if (!user) throw new ApiError(401, "Invalid phone or password.");
  if (user.status === "INACTIVE") throw new ApiError(403, "Account is inactive.");
  if (!user.passwordHash) {
    throw new ApiError(401, "Invalid phone or password.");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) throw new ApiError(401, "Invalid phone or password.");

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  const token = signUserToken(user);

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

const register = async (payload) => {
  const { user, customer } = await registerCustomer(payload);

  const token = signUserToken(user);

  await logAudit({
    actor: user._id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.LOGIN,
    targetType: "User",
    targetId: user._id,
    notes: "Customer registered and signed in",
  });

  return {
    token,
    user: { _id: user._id, name: user.name, phone: user.phone, role: user.role, status: user.status },
    customer,
  };
};

const logout = async (user) => {
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  await logAudit({
    actor: user._id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.LOGIN,
    targetType: "User",
    targetId: user._id,
    notes: "User logged out",
  });
  return { message: "Logged out successfully." };
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

module.exports = {
  login,
  register,
  logout,
  me,
  assertPasswordStrength,
  generateTemporaryPassword,
  MIN_PASSWORD_LENGTH,
};
