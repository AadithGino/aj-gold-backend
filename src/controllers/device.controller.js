const { z } = require("zod");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { DEVICE_PLATFORMS } = require("../models/deviceToken.model");
const { FCM_TEST_PUSH_ENABLED } = require("../config/env");
const User = require("../models/user.model");
const Customer = require("../models/customer.model");
const { USER_ROLES } = require("../constants/enums");
const {
  registerDeviceToken,
  unregisterDeviceToken,
  listTokensForUser,
} = require("../services/device.service");
const { sendPushToUser } = require("../services/push.service");

const fcmTokenSchema = z.object({
  token: z.string().trim().min(1, "FCM token is required."),
  platform: z.enum([DEVICE_PLATFORMS.IOS, DEVICE_PLATFORMS.ANDROID], {
    message: "Platform must be ios or android.",
  }),
});

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  return parsed.data;
};

const registerFcmTokenHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(fcmTokenSchema, req.body);
  await registerDeviceToken(req.user._id, payload);
  res.json({ success: true, message: "Device token registered." });
});

const unregisterFcmTokenHandler = asyncHandler(async (req, res) => {
  const payload = parseBody(fcmTokenSchema, req.body);
  await unregisterDeviceToken(req.user._id, payload.token);
  res.json({ success: true, message: "Device token removed." });
});

const testPushHandler = asyncHandler(async (req, res) => {
  if (!FCM_TEST_PUSH_ENABLED) {
    throw new ApiError(404, "Not found.");
  }

  const result = await sendPushToUser(req.user._id, {
    title: "Test Payment Received",
    body: "This is a test push notification from AJ Gold Kambil.",
    data: {
      type: "PAYMENT_RECEIVED",
      test: "true",
    },
  });

  res.json({
    success: true,
    message: "Test push attempted.",
    result,
  });
});

const testPushByPhoneSchema = z.object({
  phone: z.string().trim().min(10, "Phone is required."),
});

const adminTestPushByPhoneHandler = asyncHandler(async (req, res) => {
  if (!FCM_TEST_PUSH_ENABLED) {
    throw new ApiError(404, "Not found.");
  }

  const { phone } = parseBody(testPushByPhoneSchema, req.body);
  let user = await User.findOne({ phone, role: USER_ROLES.CUSTOMER }).select("_id name phone").lean();

  if (!user) {
    const customer = await Customer.findOne({ phone }).select("user name phone").lean();
    if (customer?.user) {
      user = await User.findById(customer.user).select("_id name phone").lean();
    }
  }

  if (!user) {
    throw new ApiError(404, "Customer account not found for this phone.");
  }

  const tokens = await listTokensForUser(user._id);
  if (!tokens.length) {
    throw new ApiError(
      409,
      "Customer has no registered device token. Log in on the app and allow notifications first."
    );
  }

  const result = await sendPushToUser(user._id, {
    title: "Test Payment Received",
    body: `Test push notification for ${phone} from AJ Gold Kambil.`,
    data: {
      type: "PAYMENT_RECEIVED",
      test: "true",
    },
  });

  res.json({
    success: true,
    message: "Test push attempted.",
    phone,
    customer: { id: user._id, name: user.name },
    deviceCount: tokens.length,
    result,
  });
});

module.exports = {
  registerFcmTokenHandler,
  unregisterFcmTokenHandler,
  testPushHandler,
  adminTestPushByPhoneHandler,
};
