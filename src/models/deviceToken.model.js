const mongoose = require("mongoose");

const DEVICE_PLATFORMS = {
  IOS: "ios",
  ANDROID: "android",
};

const deviceTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true, trim: true, index: true },
    platform: { type: String, enum: Object.values(DEVICE_PLATFORMS), required: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DeviceToken", deviceTokenSchema);
module.exports.DEVICE_PLATFORMS = DEVICE_PLATFORMS;
