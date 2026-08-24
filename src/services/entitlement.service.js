const { loadSchemeLedgerContext } = require("../utils/paymentLedger");
const {
  ENTITLEMENT_FORMULA_VERSION,
  SETTLEMENT_CONTRACT,
} = require("../constants/settlementContract");

const computeEntitlement = async (schemeId, session = null) => {
  const { entries } = await loadSchemeLedgerContext(schemeId, session);
  const eligibleContributions = entries.reduce((sum, entry) => sum + entry.amount, 0);

  return {
    formulaVersion: ENTITLEMENT_FORMULA_VERSION,
    contract: SETTLEMENT_CONTRACT,
    eligibleContributions,
    bonus: 0,
    deductions: 0,
    roundingAdjustment: 0,
    finalEntitlement: eligibleContributions,
    inputSnapshot: {
      paymentCount: entries.length,
      contributions: entries.map((entry) => ({
        paymentId: entry.paymentId,
        amount: entry.amount,
        paymentDate: entry.paymentDate,
        adjustmentCorrectionId: entry.adjustmentCorrectionId,
      })),
    },
  };
};

module.exports = {
  computeEntitlement,
};
