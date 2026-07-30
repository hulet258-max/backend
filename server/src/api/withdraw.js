const express = require("express");
const {
  MIN_REMAINING_BALANCE_BIRR,
  MIN_WITHDRAW_BIRR,
  MIN_WITHDRAWAL_GAMES,
  MIN_WITHDRAWAL_PLAY_DAYS,
  isWholeBirrAmount,
} = require("../config/economy");
const { withdrawBalance } = require("../db/store");
const { notifyAdminOfWithdrawal } = require("../services/withdrawals");

const router = express.Router();

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizePhone(value) {
  const compact = String(value || "").trim().replace(/[\s-]/g, "");
  if (/^0[79]\d{8}$/.test(compact)) return `+251${compact.slice(1)}`;
  if (/^251[79]\d{8}$/.test(compact)) return `+${compact}`;
  return compact;
}

function isValidPhoneNumber(value) {
  return /^\+251[79]\d{8}$/.test(normalizePhone(value));
}

router.post("/withdraw", async (req, res) => {
  try {
    const { telegramId, amount } = req.body;
    const phone = normalizePhone(req.body?.phone);
    const requestId = String(req.body?.requestId || "").trim();

    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: "telegramId is required.",
      });
    }

    if (!isValidPhoneNumber(phone)) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid Ethiopian phone number (09/07 or +251 format).",
      });
    }

    if (requestId && !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid withdrawal request ID.",
        code: "INVALID_WITHDRAWAL_REQUEST_ID",
      });
    }

    const withdrawAmount = toNumber(amount);
    if (!isWholeBirrAmount(withdrawAmount) || withdrawAmount < MIN_WITHDRAW_BIRR) {
      return res.status(400).json({
        success: false,
        error: `amount must be at least ${MIN_WITHDRAW_BIRR} Birr.`,
      });
    }

    const result = await withdrawBalance(telegramId, withdrawAmount, phone, { requestId });
    if (!result.duplicate) {
      const notification = await notifyAdminOfWithdrawal(result.request);
      if (!notification.sent) {
        console.warn("Withdrawal accepted but Telegram admin notification failed:", notification.error);
      }
    }

    return res.json({
      success: true,
      message: "Withdrawal has been sent. It will be completed in less than 24 hours.",
      request: result.request,
      duplicate: Boolean(result.duplicate),
      telegramId: String(telegramId),
      withdrawnAmount: withdrawAmount,
      previousBalance: result.currentBalance,
      previousWithdrawableBalance: result.withdrawableBalance,
      nonWithdrawableBalance: result.nonWithdrawableBalance,
      newBalance: result.nextBalance,
      newWithdrawableBalance: result.nextWithdrawableBalance,
      phone: result.phone,
      limits: {
        minWithdraw: MIN_WITHDRAW_BIRR,
        maxWithdraw: result.nextMaxWithdraw,
        dailyLimit: result.dailyLimit,
        remainingDailyLimit: result.remainingDailyLimit,
        unlimitedDailyWithdrawals: result.dailyLimit === null,
        gamesRequired: MIN_WITHDRAWAL_GAMES,
        playDaysRequired: MIN_WITHDRAWAL_PLAY_DAYS,
        minimumRemainingBalance: MIN_REMAINING_BALANCE_BIRR,
      },
    });
  } catch (error) {
    if (error.message === "WITHDRAWALS_DISABLED") {
      return res.status(503).json({
        success: false,
        error: "Withdrawals are not available right now. Please try again later.",
        code: "WITHDRAWALS_DISABLED",
      });
    }

    if (error.message === "WITHDRAWAL_REQUEST_CONFLICT") {
      return res.status(409).json({
        success: false,
        error: "This withdrawal request ID was already used for another request.",
        code: "WITHDRAWAL_REQUEST_CONFLICT",
      });
    }
    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: "User not found.",
      });
    }

    if (error.message === "WITHDRAWAL_DEPOSIT_REQUIRED") {
      return res.status(403).json({
        success: false,
        error: "Make at least one deposit before withdrawing.",
        code: "WITHDRAWAL_DEPOSIT_REQUIRED",
      });
    }

    if (error.message === "WITHDRAWAL_ACTIVITY_REQUIRED") {
      return res.status(403).json({
        success: false,
        error: `Keep playing before withdrawing. Complete at least ${MIN_WITHDRAWAL_GAMES} games across ${MIN_WITHDRAWAL_PLAY_DAYS} different days.`,
        code: "WITHDRAWAL_ACTIVITY_REQUIRED",
        gamesPlayed: error.gamesPlayed,
        gamesRequired: error.gamesRequired,
        remainingGames: error.remainingGames,
        playDays: error.playDays,
        playDaysRequired: error.playDaysRequired,
        remainingPlayDays: error.remainingPlayDays,
      });
    }

    if (error.message === "WITHDRAWAL_MIN_BALANCE_REQUIRED") {
      return res.status(400).json({
        success: false,
        error: `You must keep at least ${MIN_REMAINING_BALANCE_BIRR} Birr in your balance after withdrawing.`,
        code: "WITHDRAWAL_MIN_BALANCE_REQUIRED",
        currentBalance: error.currentBalance,
        minimumRemainingBalance: error.minimumRemainingBalance,
        maxWithdraw: error.maxWithdraw,
      });
    }

    if (error.message === "WITHDRAWAL_DAILY_LIMIT_EXCEEDED") {
      return res.status(400).json({
        success: false,
        error: `Your current daily withdrawal limit is ${error.dailyLimit} Birr.`,
        code: "WITHDRAWAL_DAILY_LIMIT_EXCEEDED",
        dailyLimit: error.dailyLimit,
        withdrawnToday: error.withdrawnToday,
        remainingDailyLimit: error.remainingDailyLimit,
      });
    }

    if (error.message === "INSUFFICIENT_BALANCE" || error.message === "INSUFFICIENT_WITHDRAWABLE_BALANCE") {
      return res.status(400).json({
        success: false,
        error: "This amount includes welcome/share gift Birr, which cannot be withdrawn.",
        withdrawableBalance: error.withdrawableBalance || 0,
        nonWithdrawableBalance: error.nonWithdrawableBalance || 0,
        maxWithdraw: error.maxWithdraw || 0,
      });
    }

    console.error("❌ /api/withdraw error:", error);
    return res.status(500).json({
      success: false,
      error: "Server error during withdraw.",
    });
  }
});

module.exports = router;
