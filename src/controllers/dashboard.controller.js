const {
  getAdminDashboard,
  getStaffDashboard,
  getCustomerDashboard,
  getRoleProfile,
  getStaffCashSubmissions,
  getStaffPayoutHistory,
  getCustomerPayoutHistory,
} = require("../services/dashboard.service");
const { USER_ROLES } = require("../constants/enums");
const ApiError = require("../utils/ApiError");

const adminDashboardHandler = async (req, res, next) => {
  try {
    const data = await getAdminDashboard();
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

const staffDashboardHandler = async (req, res, next) => {
  try {
    const data = await getStaffDashboard(req.user);
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

const staffCashSubmissionsHandler = async (req, res, next) => {
  try {
    const data = await getStaffCashSubmissions(req.user, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const customerDashboardHandler = async (req, res, next) => {
  try {
    const data = await getCustomerDashboard(req.user);
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

const staffPayoutHistoryHandler = async (req, res, next) => {
  try {
    const data = await getStaffPayoutHistory(req.user, {
      from: req.query.from,
      to: req.query.to,
      method: req.query.method,
      payoutType: req.query.payoutType,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const customerPayoutHistoryHandler = async (req, res, next) => {
  try {
    const data = await getCustomerPayoutHistory(req.user, {
      from: req.query.from,
      to: req.query.to,
      method: req.query.method,
      payoutType: req.query.payoutType,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const roleProfileHandler = async (req, res, next) => {
  try {
    const data = await getRoleProfile(req.user);
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

module.exports = {
  adminDashboardHandler,
  staffDashboardHandler,
  staffCashSubmissionsHandler,
  staffPayoutHistoryHandler,
  customerDashboardHandler,
  customerPayoutHistoryHandler,
  roleProfileHandler,
};
