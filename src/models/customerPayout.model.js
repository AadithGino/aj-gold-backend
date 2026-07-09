const mongoose = require("mongoose");
const {
  PAYMENT_METHODS,
  PAYOUT_TYPES,
  PAYOUT_STATUS,
  USER_ROLES,
} = require("../constants/enums");

const customerPayoutSchema = new mongoose.Schema(
  {
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
    payoutNumber: {
      type: String,
      unique: true,
      required: true,
      trim: true,
      index: true,
    },
    payoutType: {
      type: String,
      enum: Object.values(PAYOUT_TYPES),
      required: true,
    },
    payoutMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    payoutDate: { type: Date, default: Date.now, index: true },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    paidByRole: {
      type: String,
      enum: [USER_ROLES.ADMIN, USER_ROLES.STAFF],
      required: true,
    },
    referenceNumber: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: Object.values(PAYOUT_STATUS),
      default: PAYOUT_STATUS.SUCCESS,
      index: true,
    },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reversedAt: Date,
    reversalReason: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CustomerPayout", customerPayoutSchema);
