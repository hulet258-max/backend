const express = require("express");
const { query } = require("../config/postgres");
const { ensureAppSchema, getWithdrawalsEnabled } = require("../db/store");

const router = express.Router();

function mapPoster(row) {
  return {
    id: Number(row.id),
    imageUrl: row.image_url,
    title: row.title || "",
    platform: row.platform || "",
    detail: row.detail || "",
    targetUrl: row.target_url || "",
    altText: row.alt_text || "",
    showOverlay: row.show_overlay !== false,
    sortOrder: Number(row.sort_order || 0),
  };
}

function mapDepositNumber(row) {
  return {
    id: Number(row.id),
    phoneNumber: row.phone_number,
    label: row.label || "",
    sortOrder: Number(row.sort_order || 0),
  };
}

router.use(async (req, res, next) => {
  try {
    await ensureAppSchema();
    next();
  } catch (error) {
    console.error("Settings schema check failed:", error);
    res.status(500).json({ success: false, error: "Settings schema check failed." });
  }
});

router.get("/lobby", async (req, res) => {
  try {
    const result = await query(`
      SELECT id, image_url, title, platform, detail, target_url, alt_text,
        show_overlay, sort_order
      FROM admin_posters
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, created_at DESC
    `);
    return res.json({ success: true, posters: result.rows.map(mapPoster) });
  } catch (error) {
    console.error(" /api/settings/lobby error:", error);
    return res.status(500).json({ success: false, error: "Could not load lobby settings." });
  }
});

router.get("/deposit-numbers", async (req, res) => {
  try {
    const result = await query(`
      SELECT id, phone_number, label, sort_order
      FROM deposit_numbers
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, created_at DESC
    `);
    return res.json({ success: true, numbers: result.rows.map(mapDepositNumber) });
  } catch (error) {
    console.error(" /api/settings/deposit-numbers error:", error);
    return res.status(500).json({ success: false, error: "Could not load deposit numbers." });
  }
});

router.get("/withdrawals", async (_req, res) => {
  try {
    return res.json({ success: true, enabled: await getWithdrawalsEnabled() });
  } catch (error) {
    console.error(" /api/settings/withdrawals error:", error);
    return res.status(500).json({ success: false, error: "Could not load withdrawal settings." });
  }
});

module.exports = router;
