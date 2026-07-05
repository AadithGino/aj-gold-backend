const mongoose = require("mongoose");

const NOTIFICATION_TYPES = {
  PAYMENT_RECEIVED:  "PAYMENT_RECEIVED",
  PAYMENT_REVERSED:  "PAYMENT_REVERSED",
  SCHEME_ACTIVATED:  "SCHEME_ACTIVATED",
  SCHEME_MATURED:    "SCHEME_MATURED",
};

const notificationSchema = new mongoose.Schema(
  {
    recipient:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type:       { type: String, enum: Object.values(NOTIFICATION_TYPES), required: true, index: true },
    title:      { type: String, required: true, trim: true },
    message:    { type: String, required: true, trim: true },
    data:       { type: mongoose.Schema.Types.Mixed, default: {} },
    isRead:     { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
