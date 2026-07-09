const { USER_ROLES } = require("../constants/enums");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const {
  getCollectionReport,
  getStaffPerformanceReport,
  getCashPositionReport,
  getSchemeReport,
  getMaturityCalendar,
  getCustomerLedger,
  getSchemeLedger,
} = require("../services/report.service");

const assertNotCustomer = (user) => {
  if (user.role === USER_ROLES.CUSTOMER) {
    throw new ApiError(403, "Customers cannot access reports.");
  }
};

const assertAdmin = (user) => {
  if (user.role !== USER_ROLES.ADMIN) {
    throw new ApiError(403, "Admin access required.");
  }
};

const collectionsHandler = asyncHandler(async (req, res) => {
  assertNotCustomer(req.user);
  const data = await getCollectionReport(req.query, req.user);
  res.json({ success: true, data });
});

const staffPerformanceHandler = asyncHandler(async (req, res) => {
  assertAdmin(req.user);
  const data = await getStaffPerformanceReport(req.query);
  res.json({ success: true, data });
});

const cashPositionHandler = asyncHandler(async (req, res) => {
  assertAdmin(req.user);
  const data = await getCashPositionReport();
  res.json({ success: true, data });
});

const schemesHandler = asyncHandler(async (req, res) => {
  assertAdmin(req.user);
  const data = await getSchemeReport(req.query);
  res.json({ success: true, data });
});

const maturityCalendarHandler = asyncHandler(async (req, res) => {
  assertAdmin(req.user);
  const data = await getMaturityCalendar(req.query);
  res.json({ success: true, data });
});

const customerLedgerHandler = asyncHandler(async (req, res) => {
  assertNotCustomer(req.user);
  const data = await getCustomerLedger(req.params.customerId);
  res.json({ success: true, data });
});

const schemeLedgerHandler = asyncHandler(async (req, res) => {
  assertNotCustomer(req.user);
  const data = await getSchemeLedger(req.params.schemeId);
  res.json({ success: true, data });
});

module.exports = {
  collectionsHandler,
  staffPerformanceHandler,
  cashPositionHandler,
  schemesHandler,
  maturityCalendarHandler,
  customerLedgerHandler,
  schemeLedgerHandler,
};
