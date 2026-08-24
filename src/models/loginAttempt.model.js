const mongoose = require("mongoose");

const loginAttemptSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    count: { type: Number, default: 0 },
    windowStart: { type: Date, required: true },
    lockedUntil: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LoginAttempt", loginAttemptSchema);
