const { login, register, me, logout } = require("../services/auth.service");
const asyncHandler = require("../utils/asyncHandler");

const loginController = asyncHandler(async (req, res) => {
  const result = await login(req.body, { ip: req.clientIp || req.ip });
  res.json({ success: true, data: result });
});

const registerController = asyncHandler(async (req, res) => {
  const result = await register(req.body, { ip: req.clientIp || req.ip });
  res.status(201).json({ success: true, data: result });
});

const meController = asyncHandler(async (req, res) => {
  const data = await me(req.user);
  res.json({ success: true, data });
});

const logoutController = asyncHandler(async (req, res) => {
  const data = await logout(req.user);
  res.json({ success: true, data });
});

module.exports = {
  loginController,
  registerController,
  meController,
  logoutController,
};
