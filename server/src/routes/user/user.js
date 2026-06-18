// server/src/routes/user.js

const express = require("express");
const router = express.Router();
const {
  ensureUser,
  getPublicUsers,
  getUserProfile,
  updateUserDisplayName,
} = require("../../db/store");

router.post("/telegram-user", async (req, res) => {
  try {
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({ success: false, error: "telegramId missing" });
    }

    const user = await ensureUser(telegramId);

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

module.exports = router;
