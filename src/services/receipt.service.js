const ReceiptCounter = require("../models/receiptCounter.model");
const ApiError = require("../utils/ApiError");

const padSequence = (seq, length = 6) => String(seq).padStart(length, "0");

const getNextSequence = async (key) => {
  const counter = await ReceiptCounter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true }
  );

  return counter.seq;
};

const generateReceiptNumber = async (date = new Date()) => {
  const year = date.getFullYear();
  const key = `receipt-${year}`;
  const seq = await getNextSequence(key);
  return `AJGK-${year}-${padSequence(seq)}`;
};

const generateEnrollmentNumber = async (date = new Date()) => {
  const year = date.getFullYear();
  const key = `enrollment-${year}`;
  const seq = await getNextSequence(key);
  return `AJGK-ENR-${year}-${padSequence(seq)}`;
};

const PASSBOOK_COUNTER_KEY = "PASSBOOK";
const PASSBOOK_MAX = 9999;

const generatePassbookNumber = async () => {
  const seq = await getNextSequence(PASSBOOK_COUNTER_KEY);

  if (seq > PASSBOOK_MAX) {
    throw new ApiError(409, "Passbook number series exhausted");
  }

  return String(seq).padStart(4, "0");
};

const generatePayoutNumber = async (date = new Date()) => {
  const year = date.getFullYear();
  const seq = await getNextSequence("PAYOUT");
  return `AJGK-PAY-${year}-${padSequence(seq)}`;
};

module.exports = {
  generateReceiptNumber,
  generateEnrollmentNumber,
  generatePassbookNumber,
  generatePayoutNumber,
  getNextSequence,
  PASSBOOK_COUNTER_KEY,
  PASSBOOK_MAX,
};
