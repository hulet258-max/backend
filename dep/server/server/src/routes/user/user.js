// server/src/routes/user.js

const express = require("express");
const router = express.Router();
const db = require("../../config/firebase");

router.post("/telegram-user", async (req, res) => {
  try {
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({ success: false, error: "telegramId missing" });
    }

    const doc = await db
      .collection("users")
      .doc(String(telegramId))
      .get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({ success: true, user: doc.data() });
  } catch (err) {
    console.error("❌ /api/telegram-user error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;