const mongoose = require("mongoose");

const idempotencyRecordSchema = new mongoose.Schema(
  {
    clientRequestId: { type: String, required: true, trim: true },
    operationType: { type: String, required: true, trim: true, index: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      enum: ["COMPLETED", "FAILED"],
      default: "COMPLETED",
      index: true,
    },
    responsePayload: { type: mongoose.Schema.Types.Mixed },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resourceType: { type: String, trim: true },
    resourceId: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

idempotencyRecordSchema.index({ clientRequestId: 1, operationType: 1 }, { unique: true });

module.exports = mongoose.model("IdempotencyRecord", idempotencyRecordSchema);
