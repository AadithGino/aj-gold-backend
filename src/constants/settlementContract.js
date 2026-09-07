const ENTITLEMENT_FORMULA_VERSION = "principal-v1";
const EARLY_CLOSURE_FORMULA_VERSION = "principal-early-5pct-v1";
const EARLY_CLOSURE_RETENTION_RATE = 0.05;

const ALLOWED_SETTLEMENT_PAYOUT_METHODS = ["CASH", "UPI", "BANK", "GOLD"];

const SETTLEMENT_CONTRACT = {
  formulaVersion: ENTITLEMENT_FORMULA_VERSION,
  description:
    "Successful non-reversed effective contribution total; principal only at maturity.",
  earlyClosureAllowed: true,
  earlyClosureFormula:
    "95% of successful non-reversed effective contribution total; 5% retained (floor to whole rupees).",
  earlyClosureFormulaVersion: EARLY_CLOSURE_FORMULA_VERSION,
  earlyClosureRetentionRate: EARLY_CLOSURE_RETENTION_RATE,
  bonus: 0,
  deductions: 0,
  roundingRule: "Whole rupees only; early-close retained amount uses floor.",
  allowedPayoutMethods: ALLOWED_SETTLEMENT_PAYOUT_METHODS,
  payoutReferenceRequired: false,
  payoutEvidenceRequired: false,
  makerCheckerRequired: false,
  staffCanExecuteFullSettlement: false,
  customerAcknowledgementRequired: false,
  makingChargeAffectsPayout: false,
};

module.exports = {
  ENTITLEMENT_FORMULA_VERSION,
  EARLY_CLOSURE_FORMULA_VERSION,
  EARLY_CLOSURE_RETENTION_RATE,
  ALLOWED_SETTLEMENT_PAYOUT_METHODS,
  SETTLEMENT_CONTRACT,
};
