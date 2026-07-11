const mongoose = require("mongoose");

const staffProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    employeeCode: { type: String, trim: true },
    permissions: {
      canCollectPayment:    { type: Boolean, default: true },
      canCreateCustomer:    { type: Boolean, default: true },
      canViewReports:       { type: Boolean, default: false },
      canSubmitCash:        { type: Boolean, default: true },
      canMarkRedeemed:      { type: Boolean, default: true },
      canMarkClosed:        { type: Boolean, default: true },
    },
    calculatedCashInHand: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StaffProfile", staffProfileSchema);
