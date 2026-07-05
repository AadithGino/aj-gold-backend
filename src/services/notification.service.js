const Notification = require("../models/notification.model");
const { NOTIFICATION_TYPES } = require("../models/notification.model");
const Customer = require("../models/customer.model");

const MAX_FETCH = 50;

const notifyPaymentReceived = async ({ customer, payment, collectedByName, collectedByRole }) => {
  try {
    if (!customer?.user) return; // customer not linked to a user account
    const title   = "Payment Received";
    const roleTag = collectedByRole === "ADMIN" ? "Admin" : "Staff";
    const message = `${roleTag} ${collectedByName} collected ₹${payment.amount.toLocaleString("en-IN")} via ${payment.paymentMethod} for your scheme (${payment.receiptNumber}).`;

    await Notification.create({
      recipient: customer.user,
      type:      NOTIFICATION_TYPES.PAYMENT_RECEIVED,
      title,
      message,
      data: {
        paymentId:       payment._id,
        amount:          payment.amount,
        paymentMethod:   payment.paymentMethod,
        receiptNumber:   payment.receiptNumber,
        collectedByName,
        collectedByRole,
      },
    });
  } catch (err) {
    console.error("[notification.service] notifyPaymentReceived failed:", err.message);
  }
};

const notifyPaymentReversed = async ({ customer, payment }) => {
  try {
    if (!customer?.user) return;
    await Notification.create({
      recipient: customer.user,
      type:      NOTIFICATION_TYPES.PAYMENT_REVERSED,
      title:     "Payment Reversed",
      message:   `Your payment of ₹${payment.amount.toLocaleString("en-IN")} (${payment.receiptNumber}) has been reversed. Please contact your AJ Gold advisor for details.`,
      data: {
        paymentId:     payment._id,
        amount:        payment.amount,
        receiptNumber: payment.receiptNumber,
      },
    });
  } catch (err) {
    console.error("[notification.service] notifyPaymentReversed failed:", err.message);
  }
};

const getNotifications = async (userId, { page = 1, limit = MAX_FETCH } = {}) => {
  const skip = (Math.max(page, 1) - 1) * Math.min(limit, MAX_FETCH);

  const [items, unreadCount] = await Promise.all([
    Notification.find({ recipient: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Math.min(limit, MAX_FETCH))
      .lean(),
    Notification.countDocuments({ recipient: userId, isRead: false }),
  ]);

  return { items, unreadCount };
};

const markRead = async (notificationId, userId) => {
  await Notification.updateOne(
    { _id: notificationId, recipient: userId },
    { $set: { isRead: true } }
  );
};

const markAllRead = async (userId) => {
  await Notification.updateMany({ recipient: userId, isRead: false }, { $set: { isRead: true } });
};

const getUnreadCount = async (userId) => {
  return Notification.countDocuments({ recipient: userId, isRead: false });
};

module.exports = {
  notifyPaymentReceived,
  notifyPaymentReversed,
  getNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
  NOTIFICATION_TYPES,
};
