const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const {
  getMyNotifications,
  getMyUnreadCount,
  markOneRead,
  markAllAsRead,
} = require("../controllers/notification.controller");

const router = express.Router();

router.use(authMiddleware);

router.get("/",             getMyNotifications);
router.get("/unread-count", getMyUnreadCount);
router.patch("/read-all",   markAllAsRead);
router.patch("/:id/read",   markOneRead);

module.exports = router;
