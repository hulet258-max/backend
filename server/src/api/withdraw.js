const express = require("express");
const { Telegram } = require("telegraf");
const {
  MIN_WITHDRAW_COINS,
  isWholeCoinAmount,
} = require("../config/economy");
const { withdrawBalance } = require("../db/store");

const router = express.Router();

const ADMIN_TELEGRAM_ID = "1303374266";

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

router.post("/withdraw", async (req, res) => {
  try {
    const { telegramId, amount } = req.body;

    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: "telegramId is required.",
      });
    }

    const withdrawAmount = toNumber(amount);
    if (!isWholeCoinAmount(withdrawAmount) || withdrawAmount < MIN_WITHDRAW_COINS) {
      return res.status(400).json({
        success: false,
        error: `amount must be a whole coin amount greater than or equal to ${MIN_WITHDRAW_COINS}.`,
      });
    }

    const result = await withdrawBalance(telegramId, withdrawAmount);

    if (process.env.BOT_TOKEN) {
      const telegram = new Telegram(process.env.BOT_TOKEN);
      const message = [
        "💸 New Withdraw Request",
        `User Telegram ID: ${telegramId}`,
        `Phone: ${result.phone}`,
        `Withdraw Amount: ${withdrawAmount} coins`,
        `Balance After: ${result.nextBalance} coins`,
      ].join("\n");

      await telegram.sendMessage(ADMIN_TELEGRAM_ID, message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Sent", callback_data: "withdraw_sent" }],
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
      newBalance: result.nextBalance,
      phone: result.phone,
      limits: {
        minWithdraw: MIN_WITHDRAW_COINS,
        maxWithdraw: result.currentBalance,
      },
    });
  } catch (error) {
    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: "User not found.",
      });
    }

    if (error.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        success: false,
        error: "Insufficient balance for this withdraw amount.",
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
