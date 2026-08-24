const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/user.model");
const Customer = require("../models/customer.model");
const { logAudit } = require("./audit.service");
const ApiError = require("../utils/ApiError");
const {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  JWT_ISSUER,
  JWT_AUDIENCE,
} = require("../config/env");
const { AUDIT_ACTIONS, USER_ROLES } = require("../constants/enums");
const { assertPrivilegedPassword } = require("../constants/credentialPolicies");
const {
  assertNotLocked,
  recordFailedAttempt,
  resetAttempts,
} = require("./loginRateLimit.service");

const signAccessToken = (user) =>
  jwt.sign(
    {
      id: user._id,
      role: user.role,
      tokenVersion: user.tokenVersion || 0,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );

const generateTemporaryPassword = () =>
  crypto.randomBytes(9).toString("base64url").slice(0, 12);

const buildAuthResponse = (user) => ({
  token: signAccessToken(user),
  user: {
    _id: user._id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    status: user.status,
  },
});

const login = async ({ phone, password }, { ip } = {}) => {
  if (!phone?.trim() || !password) {
    throw new ApiError(400, "Phone and password are required.");
  }

  const normalizedPhone = phone.trim();
  await assertNotLocked({ ip, phone: normalizedPhone });

  const user = await User.findOne({ phone: normalizedPhone }).select("name phone role status tokenVersion +passwordHash");
  if (!user) {
    await recordFailedAttempt({ ip, phone: normalizedPhone });
    throw new ApiError(401, "Invalid phone or password.");
  }
  if (user.status === "INACTIVE") throw new ApiError(403, "Account is inactive.");
  if (!user.passwordHash) {
    await recordFailedAttempt({ ip, phone: normalizedPhone });
    throw new ApiError(401, "Invalid phone or password.");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    await recordFailedAttempt({ ip, phone: normalizedPhone });
    throw new ApiError(401, "Invalid phone or password.");
  }

  await resetAttempts({ ip, phone: normalizedPhone });

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  await logAudit({
    actor: user._id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.LOGIN,
    targetType: "User",
    targetId: user._id,
    notes: "User logged in",
  });

  return buildAuthResponse(user);
};

const logout = async (user) => {
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  await logAudit({
    actor: user._id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.LOGOUT,
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

const assertPasswordStrength = assertPrivilegedPassword;

module.exports = {
  login,
  logout,
  me,
  assertPasswordStrength,
  generateTemporaryPassword,
  signAccessToken,
};
