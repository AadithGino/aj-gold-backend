const { SETTLEMENT_STATUSES, SETTLEMENT_WORKFLOW_STATUS } = require("../constants/enums");
const ApiError = require("./ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const LOCKED_WORKFLOW_STATUSES = new Set([
  SETTLEMENT_WORKFLOW_STATUS.APPROVED,
  SETTLEMENT_WORKFLOW_STATUS.PAYOUT_PENDING,
  SETTLEMENT_WORKFLOW_STATUS.PAID,
  SETTLEMENT_WORKFLOW_STATUS.FINALIZED,
]);

const isSchemeSettled = (scheme) =>
  Boolean(scheme && SETTLEMENT_STATUSES.includes(scheme.status));

const isSchemeFinanciallyLocked = (scheme) => {
  if (isSchemeSettled(scheme)) {
    return true;
  }
  const workflowStatus = scheme?.settlementWorkflow?.status;
  return Boolean(workflowStatus && LOCKED_WORKFLOW_STATUSES.has(workflowStatus));
};

const assertSchemeNotSettled = (scheme) => {
  if (isSchemeFinanciallyLocked(scheme)) {
    throw new ApiError(409, "Scheme is already settled.", [], {
      code: ERROR_CODES.SCHEME_ALREADY_SETTLED,
      retryable: false,
    });
  }
};

module.exports = {
  isSchemeSettled,
  isSchemeFinanciallyLocked,
  assertSchemeNotSettled,
};
