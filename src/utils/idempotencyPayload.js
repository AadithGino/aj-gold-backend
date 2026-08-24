const buildPaymentCollectIntent = (payload, amount) => ({
  customer: payload.customer,
  scheme: payload.scheme,
  amount,
  paymentMethod: payload.paymentMethod,
  transactionReference: payload.transactionReference?.trim() || "",
  notes: payload.notes?.trim() || "",
});

const buildCashSubmissionIntent = (payload, submittedAmount) => ({
  staff: payload.staff,
  submittedAmount,
  notes: payload.notes?.trim() || "",
});

const buildSchemeCreateIntent = ({ customerId, schemeName, startDate }) => ({
  customerId,
  schemeName: schemeName?.trim() || "",
  startDate: startDate ? String(startDate) : "",
});

module.exports = {
  buildPaymentCollectIntent,
  buildCashSubmissionIntent,
  buildSchemeCreateIntent,
};
