const express = require("express");
const router = express.Router();
const { createReferralLink, getRoom } = require("../db/store");
const {
  preparePrivateRoomShare,
  prepareReferralShare,
} = require("../services/telegramPreparedShare");

function getPreparedMessageId(preparedMessage) {
  if (typeof preparedMessage === "string") return preparedMessage;
  return preparedMessage?.id || "";
}

router.post("/share/referral", async (req, res) => {
  try {
    const { userId, origin, botUsername } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    const referralLink = await createReferralLink(userId, { origin, botUsername });
    const fallbackQuery = `ref_${referralLink.code}`;
    let preparedMessage = null;
    let preparedError = "";

    try {
      preparedMessage = await prepareReferralShare({
        userId,
        code: referralLink.code,
        botUsername,
      });
    } catch (error) {
      preparedError = error.message || "Prepared referral share failed.";
      console.warn("Telegram prepared referral share failed:", error);
    }

    return res.json({
      success: true,
      code: referralLink.code,
      link: referralLink.link,
      fallbackQuery,
      preparedMessageId: getPreparedMessageId(preparedMessage),
      preparedExpiresAt: preparedMessage?.expiration_date || null,
      preparedError,
    });
  } catch (error) {
    console.error(" /api/share/referral error:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/share/private-room", async (req, res) => {
  try {
    const { userId, roomId, botUsername } = req.body;
    if (!userId || !roomId) {
      return res.status(400).json({ success: false, error: "Missing share data" });
    }

    const room = await getRoom(roomId);
    if (!room || room.visibility !== "private" || room.status !== "waiting") {
      return res.status(404).json({ success: false, error: "Private room is not available." });
    }

    const playerIds = (room.players || []).map(String);
    if (String(room.creatorId) !== String(userId) && !playerIds.includes(String(userId))) {
      return res.status(403).json({ success: false, error: "You cannot share this room." });
    }

    const fallbackQuery = `join_room_${room.id}`;
    let preparedMessage = null;
    let preparedError = "";

    try {
      preparedMessage = await preparePrivateRoomShare({
        userId,
        room,
        botUsername,
      });
    } catch (error) {
      preparedError = error.message || "Prepared private room share failed.";
      console.warn("Telegram prepared private room share failed:", error);
    }

    return res.json({
      success: true,
      fallbackQuery,
      preparedMessageId: getPreparedMessageId(preparedMessage),
      preparedExpiresAt: preparedMessage?.expiration_date || null,
      preparedError,
    });
  } catch (error) {
    console.error(" /api/share/private-room error:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
