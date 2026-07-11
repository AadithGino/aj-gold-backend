const {
  getAdminDashboard,
  getStaffDashboard,
  getCustomerDashboard,
  getRoleProfile,
  getStaffCashSubmissions,
  getStaffRedemptionHistory,
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

const staffRedemptionHistoryHandler = async (req, res, next) => {
  try {
    const data = await getStaffRedemptionHistory(req.user, {
      from: req.query.from,
      to: req.query.to,
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
  staffRedemptionHistoryHandler,
  customerDashboardHandler,
  roleProfileHandler,
};
