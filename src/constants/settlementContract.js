const ENTITLEMENT_FORMULA_VERSION = "principal-v1";

const ALLOWED_SETTLEMENT_PAYOUT_METHODS = ["CASH", "UPI", "BANK", "GOLD"];

const SETTLEMENT_CONTRACT = {
  formulaVersion: ENTITLEMENT_FORMULA_VERSION,
  description:
    "Successful non-reversed effective contribution total; principal only; no bonus, penalty, or deduction.",
  earlyClosureAllowed: true,
  earlyClosureFormula:
    "Same as maturity: successful non-reversed effective contribution total; principal only.",
  bonus: 0,
  deductions: 0,
  roundingRule: "Whole rupees only; entitlement equals sum of eligible contributions.",
  allowedPayoutMethods: ALLOWED_SETTLEMENT_PAYOUT_METHODS,
  payoutReferenceRequired: false,
  payoutEvidenceRequired: false,
  makerCheckerRequired: false,
  staffCanExecuteFullSettlement: true,
  customerAcknowledgementRequired: false,
  makingChargeAffectsPayout: false,
};

module.exports = {
  ENTITLEMENT_FORMULA_VERSION,
  ALLOWED_SETTLEMENT_PAYOUT_METHODS,
  SETTLEMENT_CONTRACT,
};
