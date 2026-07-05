const mongoose = require("mongoose");
const { CORRECTION_TYPES, CORRECTION_STATUS } = require("../constants/enums");

const paymentCorrectionSchema = new mongoose.Schema(
  {
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requestedByRole: { type: String, required: true },
    reason: { type: String, required: true },
    correctionType: {
      type: String,
      enum: Object.values(CORRECTION_TYPES),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(CORRECTION_STATUS),
      default: CORRECTION_STATUS.PENDING,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: Date,
    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("PaymentCorrection", paymentCorrectionSchema);
