const express = require("express");
const { Telegram } = require("telegraf");
const {
  MIN_WITHDRAW_BIRR,
  isWholeBirrAmount,
} = require("../config/economy");
const { withdrawBalance } = require("../db/store");
const {
  WITHDRAWAL_WAIT_DAYS,
  splitRemainingWithdrawalTime,
} = require("../services/withdrawalPolicy");

const router = express.Router();

const ADMIN_TELEGRAM_ID = "1303374266";

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

    const withdrawAmount = toNumber(amount);
    if (!isWholeBirrAmount(withdrawAmount) || withdrawAmount < MIN_WITHDRAW_BIRR) {
      return res.status(400).json({
        success: false,
        error: `amount must be at least ${MIN_WITHDRAW_BIRR} Birr.`,
      });
    }

    const result = await withdrawBalance(telegramId, withdrawAmount, phone);

    if (process.env.BOT_TOKEN) {
      const telegram = new Telegram(process.env.BOT_TOKEN);
      const message = [
        "💸 New Withdraw Request",
        `User Telegram ID: ${telegramId}`,
        `Phone: ${result.phone}`,
        `Withdraw Amount: ${withdrawAmount} Birr`,
        `Balance After: ${result.nextBalance} Birr`,
      ].join("\n");

      await telegram.sendMessage(ADMIN_TELEGRAM_ID, message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Sent", callback_data: `withdraw_sent:${telegramId}:${withdrawAmount}` }],
          ],
        },
      });
    } else {
      console.warn("BOT_TOKEN is missing. Withdraw admin message was not sent.");
    }

    return res.json({
      success: true,
      message: "Withdraw request submitted successfully.",
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
        maxWithdraw: result.nextWithdrawableBalance,
      },
    });
  } catch (error) {
    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: "User not found.",
      });
    }

    if (error.message === "WITHDRAWAL_ACCOUNT_TOO_NEW") {
      const remaining = splitRemainingWithdrawalTime(error.remainingSeconds);
      const eligibleAt = error.eligibleAt instanceof Date
        ? error.eligibleAt.toISOString()
        : String(error.eligibleAt);
      const joinedAt = error.joinedAt instanceof Date
        ? error.joinedAt.toISOString()
        : String(error.joinedAt);

      return res.status(403).json({
        success: false,
        error: `Withdrawals are available ${WITHDRAWAL_WAIT_DAYS} days after joining. You can withdraw after ${eligibleAt}.`,
        code: "WITHDRAWAL_ACCOUNT_TOO_NEW",
        joinedAt,
        eligibleAt,
        ...remaining,
      });
    }

    if (error.message === "INSUFFICIENT_BALANCE" || error.message === "INSUFFICIENT_WITHDRAWABLE_BALANCE") {
      return res.status(400).json({
        success: false,
        error: "This amount includes welcome/share gift Birr, which cannot be withdrawn.",
        withdrawableBalance: error.withdrawableBalance || 0,
        nonWithdrawableBalance: error.nonWithdrawableBalance || 0,
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
