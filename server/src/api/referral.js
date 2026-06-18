const express = require("express");
const router = express.Router();
const { awardReferralIfEligible, createReferralLink } = require("../db/store");
const { emitBalanceUpdates } = require("../services/balanceEvents");

router.post("/referral-link", async (req, res) => {
  try {
    const { userId, origin, botUsername } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    const referralLink = await createReferralLink(userId, { origin, botUsername });
    return res.json({
      success: true,
      code: referralLink.code,
      link: referralLink.link,
      shareCount: Number(referralLink.share_count || 0),
      rewardCount: Number(referralLink.reward_count || 0),
      maxRewards: Number(referralLink.max_rewards || 5),
    });
  } catch (error) {
    console.error(" /api/referral-link error:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/referral-open", async (req, res) => {
  try {
    const { code, userId } = req.body;
    if (!code || !userId) {
      return res.status(400).json({ success: false, error: "Missing referral data" });
    }

    const result = await awardReferralIfEligible(code, userId);
    if (result.awarded && result.referrerId) {
      await emitBalanceUpdates(req.app.get("io"), [result.referrerId]);
    }

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error(" /api/referral-open error:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
