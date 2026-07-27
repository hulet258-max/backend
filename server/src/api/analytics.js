const express = require("express");
const { query } = require("../config/postgres");

const router = express.Router();
const ALLOWED_EVENTS = new Set([
  "session_start",
  "page_view",
  "heartbeat",
  "game_view",
  "app_error",
]);

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

router.post("/analytics/event", async (req, res) => {
  try {
    const eventName = clean(req.body?.eventName, 40);
    const sessionId = clean(req.body?.sessionId, 80);
    const userId = clean(req.body?.userId, 80) || null;
    const path = clean(req.body?.path, 240) || "/";
    const metadata = req.body?.metadata && typeof req.body.metadata === "object" && !Array.isArray(req.body.metadata)
      ? req.body.metadata
      : {};

    if (!ALLOWED_EVENTS.has(eventName) || !sessionId) {
      return res.status(400).json({ success: false, error: "Invalid analytics event." });
    }

    const metadataJson = JSON.stringify(metadata);
    const safeMetadata = metadataJson.length <= 4000 ? metadataJson : JSON.stringify({ truncated: true });
    await query(
      `INSERT INTO analytics_events (user_id, session_id, event_name, path, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, sessionId, eventName, path, safeMetadata]
    );
    return res.status(201).json({ success: true });
  } catch (error) {
    console.error(" /api/analytics/event error:", error);
    return res.status(500).json({ success: false, error: "Could not record analytics event." });
  }
});

module.exports = router;
