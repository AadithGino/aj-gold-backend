const DeviceToken = require("../models/deviceToken.model");
const ApiError = require("../utils/ApiError");

const registerDeviceToken = async (userId, { token, platform }) => {
  const trimmedToken = String(token || "").trim();
  if (!trimmedToken) {
    throw new ApiError(400, "FCM token is required.");
  }

  const now = new Date();
  const existing = await DeviceToken.findOne({ token: trimmedToken });

  if (existing) {
    existing.user = userId;
    existing.platform = platform;
    existing.lastSeenAt = now;
    await existing.save();
    return existing;
  }

  const [record] = await DeviceToken.create([
    {
      user: userId,
      token: trimmedToken,
      platform,
      lastSeenAt: now,
    },
  ]);
  return record;
};

const unregisterDeviceToken = async (userId, token) => {
  const trimmedToken = String(token || "").trim();
  if (!trimmedToken) {
    throw new ApiError(400, "FCM token is required.");
  }

  await DeviceToken.deleteOne({ user: userId, token: trimmedToken });
};

const listTokensForUser = async (userId) => {
  return DeviceToken.find({ user: userId }).select("token platform").lean();
};

const removeDeviceTokens = async (tokens = []) => {
  const normalized = tokens.map((token) => String(token || "").trim()).filter(Boolean);
  if (!normalized.length) return 0;
  const result = await DeviceToken.deleteMany({ token: { $in: normalized } });
  return result.deletedCount || 0;
};

module.exports = {
  registerDeviceToken,
  unregisterDeviceToken,
  listTokensForUser,
  removeDeviceTokens,
};
