const { login, me } = require("../services/auth.service");

const loginController = async (req, res, next) => {
  try {
    const result = await login(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const meController = async (req, res, next) => {
  try {
    const data = await me(req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const logoutController = async (req, res) => {
  res.json({ success: true, message: "Logged out successfully." });
};

module.exports = { loginController, meController, logoutController };
