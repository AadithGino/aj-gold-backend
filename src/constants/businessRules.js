const { MIN_PAYMENT_AMOUNT } = require("../config/env");

const getBusinessRules = () => ({
  minPaymentAmount: MIN_PAYMENT_AMOUNT,
});

module.exports = {
  getBusinessRules,
};
