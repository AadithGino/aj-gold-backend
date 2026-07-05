const mongoose = require("mongoose");
const { SCHEME_STATUS } = require("../constants/enums");

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    changedByRole: { type: String, required: true },
    changedAt: { type: Date, default: Date.now },
    notes: String,
  },
  { _id: false }
);

const schemeSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", index: true, required: true },
    enrollmentNumber: { type: String, unique: true, index: true, required: true, trim: true },
    schemeName: { type: String, default: "Gold Savings Scheme", trim: true },
    startDate: { type: Date, required: true },
    sixMonthDate: { type: Date, required: true },
    maturityDate: { type: Date, required: true },
    status: {
      type: String,
      enum: Object.values(SCHEME_STATUS),
      default: SCHEME_STATUS.ACTIVE,
      index: true,
    },
    statusHistory: [statusHistorySchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

schemeSchema.index({ maturityDate: 1 });
schemeSchema.index({ customer: 1, status: 1 });

module.exports = mongoose.model("Scheme", schemeSchema);
