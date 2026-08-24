const mongoose = require("mongoose");

const NOTIFICATION_TYPES = {
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  PAYMENT_REVERSED: "PAYMENT_REVERSED",
  SCHEME_ACTIVATED: "SCHEME_ACTIVATED",
  SCHEME_MATURED: "SCHEME_MATURED",
  CASH_SUBMITTED: "CASH_SUBMITTED",
  CORRECTION_APPROVED: "CORRECTION_APPROVED",
  SETTLEMENT_FINALIZED: "SETTLEMENT_FINALIZED",
};

const notificationSchema = new mongoose.Schema(
  {
    recipient:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type:       { type: String, enum: Object.values(NOTIFICATION_TYPES), required: true, index: true },
    title:      { type: String, required: true, trim: true },
    message:    { type: String, required: true, trim: true },
    data:       { type: mongoose.Schema.Types.Mixed, default: {} },
    deliveryKey:{ type: String, trim: true, index: true },
    isRead:     { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });
notificationSchema.index(
  { deliveryKey: 1 },
  {
    unique: true,
    name: "uniq_notification_delivery_key",
    partialFilterExpression: { deliveryKey: { $exists: true, $type: "string", $gt: "" } },
  }
);

module.exports = mongoose.model("Notification", notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
