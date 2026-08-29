const mongoose = require("mongoose");

const OUTBOX_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SENT: "SENT",
  FAILED: "FAILED",
  DEAD_LETTER: "DEAD_LETTER",
};

const OUTBOX_TOPICS = {
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  PAYMENT_REVERSED: "PAYMENT_REVERSED",
  CORRECTION_APPROVED: "CORRECTION_APPROVED",
  CASH_SUBMITTED: "CASH_SUBMITTED",
  SETTLEMENT_FINALIZED: "SETTLEMENT_FINALIZED",
  SCHEME_ACTIVATED: "SCHEME_ACTIVATED",
  SCHEME_MATURED: "SCHEME_MATURED",
};

const outboxSchema = new mongoose.Schema(
  {
    topic: { type: String, enum: Object.values(OUTBOX_TOPICS), required: true, index: true },
    dedupeKey: { type: String, required: true, unique: true, index: true, trim: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: Object.values(OUTBOX_STATUS),
      default: OUTBOX_STATUS.PENDING,
      index: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastError: { type: String, default: "" },
    sentAt: { type: Date },
    processingOwner: { type: String, default: "", trim: true },
    leaseExpiresAt: { type: Date, index: true },
    deliveredAt: { type: Date },
  },
  { timestamps: true }
);

outboxSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model("OutboxEvent", outboxSchema);
module.exports.OUTBOX_STATUS = OUTBOX_STATUS;
module.exports.OUTBOX_TOPICS = OUTBOX_TOPICS;
