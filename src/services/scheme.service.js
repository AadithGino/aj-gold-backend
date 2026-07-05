const Scheme = require("../models/scheme.model");
const { SCHEME_STATUS } = require("../constants/enums");
const { addMonths } = require("../utils/date");
const { generateEnrollmentNumber } = require("./receipt.service");
const ApiError = require("../utils/ApiError");

const calculateSchemeDates = (startDate) => {
  const start = startDate instanceof Date ? startDate : new Date(startDate);

  return {
    startDate: start,
    sixMonthDate: addMonths(start, 6),
    maturityDate: addMonths(start, 11),
  };
};

const getActiveSchemeForCustomer = async (customerId) => {
  return Scheme.findOne({
    customer: customerId,
    status: SCHEME_STATUS.ACTIVE,
  });
};

const customerHasActiveScheme = async (customerId) => {
  const activeScheme = await getActiveSchemeForCustomer(customerId);
  return Boolean(activeScheme);
};

const assertCustomerCanCreateActiveScheme = async (customerId) => {
  const activeScheme = await getActiveSchemeForCustomer(customerId);

  if (activeScheme) {
    throw new ApiError(
      409,
      "Customer already has an active scheme. Close or complete the current scheme before creating another active scheme."
    );
  }
};

const appendStatusHistory = (scheme, { status, changedBy, changedByRole, notes, changedAt }) => {
  if (!scheme.statusHistory) {
    scheme.statusHistory = [];
  }

  scheme.statusHistory.push({
    status,
    changedBy,
    changedByRole,
    changedAt: changedAt || new Date(),
    notes: notes || "",
  });

  scheme.status = status;
  return scheme;
};

const createEnrollmentNumber = async (date = new Date()) => generateEnrollmentNumber(date);

module.exports = {
  calculateSchemeDates,
  getActiveSchemeForCustomer,
  customerHasActiveScheme,
  assertCustomerCanCreateActiveScheme,
  appendStatusHistory,
  createEnrollmentNumber,
};
