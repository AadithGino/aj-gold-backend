const mongoose = require("mongoose");

const receiptCounterSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: false }
);

module.exports = mongoose.model("ReceiptCounter", receiptCounterSchema);
