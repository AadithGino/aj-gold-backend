const mongoose = require("mongoose");
const { PAYMENT_METHODS, PAYMENT_STATUS, USER_ROLES } = require("../constants/enums");

const paymentSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", index: true, required: true },
    scheme: { type: mongoose.Schema.Types.ObjectId, ref: "Scheme", index: true, required: true },
    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    collectedByRole: {
      type: String,
      enum: [USER_ROLES.ADMIN, USER_ROLES.STAFF],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      required: true,
      index: true,
    },
    transactionReference: { type: String, trim: true },
    paymentDate: { type: Date, default: Date.now, index: true },
    receiptNumber: { type: String, unique: true, index: true, required: true, trim: true },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.SUCCESS,
      index: true,
    },
    isLimitOverride: { type: Boolean, default: false },
    overrideReason: String,
    overrideBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
