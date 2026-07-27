// server/src/routes/user.js

const express = require("express");
const router = express.Router();
const {
  ensureUser,
  getPublicUsers,
  getUserProfile,
  updateUserDisplayName,
  acknowledgeWelcomeGift,
  getUnreadNotifications,
  acknowledgeNotification,
} = require("../../db/store");

router.post("/telegram-user", async (req, res) => {
  try {
    const { telegramId, username, firstName, lastName, photoUrl } = req.body;

    if (!telegramId) {
      return res.status(400).json({ success: false, error: "telegramId missing" });
    }

    const user = await ensureUser(telegramId, { username, firstName, lastName, photoUrl });

    res.json({ success: true, user });
  } catch (err) {
    console.error("❌ /api/telegram-user error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.get("/user-profile/:userId", async (req, res) => {
  try {
    const profile = await getUserProfile(req.params.userId);
    if (!profile) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    return res.json({ success: true, profile });
  } catch (err) {
    console.error(" /api/user-profile error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.patch("/user-profile", async (req, res) => {
  try {
    const { userId, displayName } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    const user = await updateUserDisplayName(userId, displayName);
    return res.json({ success: true, user });
  } catch (err) {
    const status = err.code === "DISPLAY_NAME_TAKEN" ? 409 : err.code === "INVALID_DISPLAY_NAME" ? 400 : 500;
    console.error(" /api/user-profile update error:", err);
    return res.status(status).json({ success: false, error: err.message || "Server error" });
  }
});

router.post("/users/public", async (req, res) => {
  try {
    const users = await getPublicUsers(req.body?.userIds || []);
    return res.json({ success: true, users });
  } catch (err) {
    console.error(" /api/users/public error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/welcome-gift/ack", async (req, res) => {
  try {
    if (!req.body?.userId) return res.status(400).json({ success: false, error: "Missing userId" });
    const user = await acknowledgeWelcomeGift(req.body.userId);
    return res.json({ success: true, user });
  } catch (err) {
    console.error(" /api/welcome-gift/ack error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/notifications", async (req, res) => {
  try {
    if (!req.body?.userId) return res.status(400).json({ success: false, error: "Missing userId" });
    const notifications = await getUnreadNotifications(req.body.userId);
    return res.json({ success: true, notifications });
  } catch (err) {
    console.error(" /api/notifications error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/notifications/read", async (req, res) => {
  try {
    const { userId, notificationId } = req.body || {};
    if (!userId || !notificationId) return res.status(400).json({ success: false, error: "Missing notification data" });
    const notification = await acknowledgeNotification(userId, notificationId);
    return res.json({ success: true, notification });
  } catch (err) {
    console.error(" /api/notifications/read error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
