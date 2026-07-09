const {
  collectPayment,
  listPayments,
  getPaymentDetail,
  getPaymentReceipt,
  reversePayment,
} = require("../services/payment.service");
const { createCorrectionRequest } = require("../services/correction.service");

const collectPaymentHandler = async (req, res, next) => {
  try {
    const result = await collectPayment(req.body, req.user);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const listPaymentsHandler = async (req, res, next) => {
  try {
    const result = await listPayments(req.query, req.user);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const getPaymentDetailHandler = async (req, res, next) => {
  try {
    const result = await getPaymentDetail(req.params.paymentId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const getPaymentReceiptHandler = async (req, res, next) => {
  try {
    const result = await getPaymentReceipt(req.params.paymentId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const createCorrectionHandler = async (req, res, next) => {
  try {
    const result = await createCorrectionRequest(req.params.paymentId, req.body, req.user);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const reversePaymentHandler = async (req, res, next) => {
  try {
    const result = await reversePayment(req.params.paymentId, req.body, req.user);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  collectPaymentHandler,
  listPaymentsHandler,
  getPaymentDetailHandler,
  getPaymentReceiptHandler,
  createCorrectionHandler,
  reversePaymentHandler,
};
