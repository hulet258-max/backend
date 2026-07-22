const { Telegram } = require("telegraf");
const {
  claimWithdrawalUserNotification,
  completeWithdrawalRequest,
  releaseWithdrawalUserNotification,
  updateWithdrawalNotification,
} = require("../db/store");

const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || "1303374266");

function getTelegram() {
  return process.env.BOT_TOKEN ? new Telegram(process.env.BOT_TOKEN) : null;
}

function withdrawalCompletedText(request) {
  return [
    "✅ Withdrawal sent",
    "",
    `The payment for ${request.amount} Birr has been sent to you. Check your account.`,
  ].join("\n");
}

async function notifyAdminOfWithdrawal(request) {
  const telegram = getTelegram();
  if (!telegram) {
    const message = "BOT_TOKEN is missing. Withdraw admin message was not sent.";
    await updateWithdrawalNotification(request.id, { notificationError: message });
    return { sent: false, error: message };
  }

  try {
    const message = [
      "💸 New Withdraw Request",
      `Request: ${request.id}`,
      `User Telegram ID: ${request.userId}`,
      `Phone: ${request.phone}`,
      `Withdraw Amount: ${request.amount} Birr`,
      `Balance After: ${request.balanceAfter} Birr`,
    ].join("\n");
    const result = await telegram.sendMessage(ADMIN_TELEGRAM_ID, message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Sent", callback_data: `withdraw_sent:${request.id}` }],
        ],
      },
    });
    await updateWithdrawalNotification(request.id, {
      adminNotified: true,
      telegramAdminMessageId: result?.message_id,
      notificationError: "",
    });
    return { sent: true };
  } catch (error) {
    const message = String(error.message || "Telegram admin notification failed.");
    await updateWithdrawalNotification(request.id, { notificationError: message });
    return { sent: false, error: message };
  }
}

async function completeAndNotifyWithdrawal(requestId, telegramOverride = null) {
  const request = await completeWithdrawalRequest(requestId);
  if (request.userNotifiedAt) return { request, userNotified: true, duplicate: true };
  const claimed = await claimWithdrawalUserNotification(requestId);
  if (!claimed) return { request, userNotified: false, duplicate: true, notificationInProgress: true };

  const telegram = telegramOverride || getTelegram();
  if (!telegram) {
    const message = "BOT_TOKEN is missing. Withdrawal completion notification was not sent.";
    await releaseWithdrawalUserNotification(request.id, message);
    return { request, userNotified: false, notificationError: message };
  }

  try {
    await telegram.sendMessage(request.userId, withdrawalCompletedText(request));
    const updated = await updateWithdrawalNotification(request.id, {
      userNotified: true,
      notificationError: "",
    });
    return { request: updated || request, userNotified: true, duplicate: false };
  } catch (error) {
    const message = String(error.message || "User notification failed.");
    await releaseWithdrawalUserNotification(request.id, message);
    return { request, userNotified: false, notificationError: message };
  }
}

module.exports = {
  ADMIN_TELEGRAM_ID,
  completeAndNotifyWithdrawal,
  notifyAdminOfWithdrawal,
  withdrawalCompletedText,
};
