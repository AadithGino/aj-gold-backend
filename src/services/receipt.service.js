const ReceiptCounter = require("../models/receiptCounter.model");
const ApiError = require("../utils/ApiError");

const padSequence = (seq, length = 6) => String(seq).padStart(length, "0");

const getNextSequence = async (key, session = null) => {
  const counter = await ReceiptCounter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true, session: session || undefined }
  );

  return counter.seq;
};

const generateReceiptNumber = async (date = new Date(), session = null) => {
  const year = date.getFullYear();
  const key = `receipt-${year}`;
  const seq = await getNextSequence(key, session);
  return `AJGK-${year}-${padSequence(seq)}`;
};

const generateEnrollmentNumber = async (date = new Date(), session = null) => {
  const year = date.getFullYear();
  const key = `enrollment-${year}`;
  const seq = await getNextSequence(key, session);
  return `AJGK-ENR-${year}-${padSequence(seq)}`;
};

const PASSBOOK_COUNTER_KEY = "PASSBOOK";
const PASSBOOK_MAX = 9999;

const generatePassbookNumber = async (session = null) => {
  const seq = await getNextSequence(PASSBOOK_COUNTER_KEY, session);

  if (seq > PASSBOOK_MAX) {
    throw new ApiError(409, "Passbook number series exhausted");
  }

  return String(seq).padStart(4, "0");
};

module.exports = {
  generateReceiptNumber,
  generateEnrollmentNumber,
  generatePassbookNumber,
  getNextSequence,
  PASSBOOK_COUNTER_KEY,
  PASSBOOK_MAX,
};
