const mongoose = require("mongoose");
const { CORRECTION_TYPES, CORRECTION_STATUS } = require("../constants/enums");

const paymentCorrectionSchema = new mongoose.Schema(
  {
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      required: true,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    scheme: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Scheme",
      required: true,
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requestedByRole: { type: String, required: true },
    correctionType: {
      type: String,
      enum: Object.values(CORRECTION_TYPES),
      required: true,
    },
    originalSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    requestedValue: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: Object.values(CORRECTION_STATUS),
      default: CORRECTION_STATUS.PENDING,
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: Date,
    reviewNotes: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

paymentCorrectionSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentCorrection", paymentCorrectionSchema);
