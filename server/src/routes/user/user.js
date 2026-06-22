// server/src/routes/user.js

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const {
  ensureUser,
  getPublicUsers,
  getUserProfile,
  updateUserDisplayName,
} = require("../../db/store");

const TELEGRAM_LOGIN_FIELDS = [
  "id",
  "first_name",
  "last_name",
  "username",
  "photo_url",
  "auth_date",
];

function verifyTelegramLogin(loginData = {}) {
  const botToken = process.env.BOT_TOKEN;
  const receivedHash = String(loginData.hash || "");
  if (!botToken || !/^[a-f0-9]{64}$/i.test(receivedHash)) return false;

  const authDate = Number(loginData.auth_date || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || authDate > now + 300 || now - authDate > 86400) return false;

  const dataCheckString = TELEGRAM_LOGIN_FIELDS
    .filter((field) => loginData[field] !== undefined && loginData[field] !== "")
    .sort()
    .map((field) => `${field}=${loginData[field]}`)
    .join("\n");
  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expectedHash, "hex"),
    Buffer.from(receivedHash, "hex")
  );
}

router.post("/telegram-login", async (req, res) => {
  try {
    const loginData = req.body?.loginData || {};
    if (!verifyTelegramLogin(loginData)) {
      return res.status(401).json({ success: false, error: "Invalid or expired Telegram login." });
    }

    const user = await ensureUser(loginData.id);
    return res.json({
      success: true,
      user,
      telegramUser: {
        id: String(loginData.id),
        first_name: loginData.first_name || "",
        last_name: loginData.last_name || "",
        username: loginData.username || "",
        photo_url: loginData.photo_url || "",
      },
    });
  } catch (err) {
    console.error(" /api/telegram-login error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

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
