const {
  getAdminDashboard,
  getStaffDashboard,
  getCustomerDashboard,
  getRoleProfile,
  getStaffCashSubmissions,
  getStaffRedemptionHistory,
  getOwnCustomerRedemptionHistory,
} = require("../services/dashboard.service");
const { sendPaged } = require("../utils/httpPage");
const { listPayments } = require("../services/payment.service");

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

const customerRedemptionHistoryHandler = async (req, res, next) => {
  try {
    const result = await getOwnCustomerRedemptionHistory(req.user, {
      from: req.query.from,
      to: req.query.to,
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    sendPaged(res, result);
  } catch (err) {
    next(err);
  }
};

const customerPaymentsHandler = async (req, res, next) => {
  try {
    const result = await listPayments(
      {
        from: req.query.from,
        to: req.query.to,
        method: req.query.method,
        cursor: req.query.cursor,
        limit: req.query.limit,
      },
      req.user
    );
    sendPaged(res, result);
  } catch (err) {
    next(err);
  }
};

const staffRedemptionHistoryHandler = async (req, res, next) => {
  try {
    const result = await getStaffRedemptionHistory(req.user, {
      from: req.query.from,
      to: req.query.to,
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    sendPaged(res, result);
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
  customerRedemptionHistoryHandler,
  customerPaymentsHandler,
  roleProfileHandler,
};
