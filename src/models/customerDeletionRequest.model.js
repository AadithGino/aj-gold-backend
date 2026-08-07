const mongoose = require("mongoose");
const { DELETION_REQUEST_STATUS } = require("../constants/enums");

const customerDeletionRequestSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reason: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: Object.values(DELETION_REQUEST_STATUS),
      default: DELETION_REQUEST_STATUS.PENDING,
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: Date,
    reviewNotes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

customerDeletionRequestSchema.index({ customer: 1, status: 1 });
customerDeletionRequestSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("CustomerDeletionRequest", customerDeletionRequestSchema);
