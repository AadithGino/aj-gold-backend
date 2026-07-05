const {
  getNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
} = require("../services/notification.service");

const getMyNotifications = async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page, 10)  || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const result = await getNotifications(req.user._id, { page, limit });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const getMyUnreadCount = async (req, res, next) => {
  try {
    const count = await getUnreadCount(req.user._id);
    res.json({ success: true, data: { count } });
  } catch (err) {
    next(err);
  }
};

const markOneRead = async (req, res, next) => {
  try {
    await markRead(req.params.id, req.user._id);
    res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    next(err);
  }
};

const markAllAsRead = async (req, res, next) => {
  try {
    await markAllRead(req.user._id);
    res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    next(err);
  }
};

module.exports = { getMyNotifications, getMyUnreadCount, markOneRead, markAllAsRead };
