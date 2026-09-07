const { loadSchemeLedgerContext } = require("../utils/paymentLedger");
const { SCHEME_STATUS } = require("../constants/enums");
const {
  ENTITLEMENT_FORMULA_VERSION,
  EARLY_CLOSURE_FORMULA_VERSION,
  EARLY_CLOSURE_RETENTION_RATE,
  SETTLEMENT_CONTRACT,
} = require("../constants/settlementContract");

const computeEarlyClosureRetained = (principal) => {
  const amount = Number(principal) || 0;
  if (amount <= 0) return 0;
  return Math.floor(amount * EARLY_CLOSURE_RETENTION_RATE);
};

const computeEntitlement = async (schemeId, options = {}) => {
  const session = options.session ?? null;
  const settlementType = options.settlementType || null;
  const { entries } = await loadSchemeLedgerContext(schemeId, session);
  const eligibleContributions = entries.reduce((sum, entry) => sum + entry.amount, 0);
  const isEarlyClose = settlementType === SCHEME_STATUS.CLOSED;
  const retained = isEarlyClose ? computeEarlyClosureRetained(eligibleContributions) : 0;
  const finalEntitlement = eligibleContributions - retained;

  return {
    formulaVersion: isEarlyClose ? EARLY_CLOSURE_FORMULA_VERSION : ENTITLEMENT_FORMULA_VERSION,
    contract: SETTLEMENT_CONTRACT,
    eligibleContributions,
    bonus: 0,
    deductions: retained,
    earlyClosureRetained: retained,
    roundingAdjustment: 0,
    finalEntitlement,
    inputSnapshot: {
      paymentCount: entries.length,
      contributions: entries.map((entry) => ({
        paymentId: entry.paymentId,
        amount: entry.amount,
        paymentDate: entry.paymentDate,
        adjustmentCorrectionId: entry.adjustmentCorrectionId,
      })),
      settlementType: settlementType || null,
      earlyClosureRetentionRate: isEarlyClose ? EARLY_CLOSURE_RETENTION_RATE : 0,
    },
  };
};

module.exports = {
  computeEntitlement,
  computeEarlyClosureRetained,
};
