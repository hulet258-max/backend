const {
  buildMiniAppLaunchUrl,
  buildReferralInlineResult,
  buildReferralPhotoUrl,
  buildRoomInlineResult,
  buildRoomWebAppUrl,
  buildWebAppUrl,
} = require("../bot/bot");

let cachedBotUsername = "";

function cleanBotUsername(botUsername = "") {
  return String(botUsername || "").replace(/^@/, "").trim();
}

function getTelegramToken() {
  return String(process.env.BOT_TOKEN || "").trim();
}

async function callTelegram(method, payload) {
  const token = getTelegramToken();
  if (!token) {
    throw new Error("BOT_TOKEN is not configured.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }

  return data.result;
}

async function getBotUsername(preferredUsername = "") {
  const preferred = cleanBotUsername(preferredUsername);
  if (preferred) return preferred;

  const configured = cleanBotUsername(process.env.BOT_USERNAME || process.env.REACT_APP_BOT_USERNAME);
  if (configured) return configured;

  if (cachedBotUsername) return cachedBotUsername;

  const bot = await callTelegram("getMe", {});
  cachedBotUsername = cleanBotUsername(bot?.username);
  return cachedBotUsername;
}

function normalizeTelegramUserId(userId) {
  const cleanUserId = String(userId || "").trim();
  if (!/^\d+$/.test(cleanUserId)) return 0;
  return Number(cleanUserId);
}

async function savePreparedInlineMessage(userId, result) {
  const telegramUserId = normalizeTelegramUserId(userId);
  if (!telegramUserId) {
    throw new Error("Valid Telegram user_id is required.");
  }

  return callTelegram("savePreparedInlineMessage", {
    user_id: telegramUserId,
    result,
    allow_user_chats: true,
    allow_bot_chats: false,
    allow_group_chats: true,
    allow_channel_chats: false,
  });
}

async function saveWithWebAppFallback({ userId, webAppResult, fallbackResult }) {
  try {
    return await savePreparedInlineMessage(userId, webAppResult);
  } catch (error) {
    const message = String(error?.description || error?.message || "");
    if (!/web_app|button_type|BUTTON_TYPE/i.test(message)) throw error;
    return savePreparedInlineMessage(userId, fallbackResult);
  }
}

async function prepareReferralShare({ userId, code, botUsername = "" }) {
  const photoUrl = buildReferralPhotoUrl();
  const webAppUrl = buildWebAppUrl(code);
  const cleanBotUsernameValue = await getBotUsername(botUsername);
  const fallbackUrl = buildMiniAppLaunchUrl(`ref_${code}`, cleanBotUsernameValue);

  if (!photoUrl || !webAppUrl) {
    throw new Error("Referral share URL is not configured.");
  }

  return saveWithWebAppFallback({
    userId,
    webAppResult: buildReferralInlineResult(code, photoUrl, webAppUrl, fallbackUrl, true),
    fallbackResult: buildReferralInlineResult(code, photoUrl, webAppUrl, fallbackUrl, false),
  });
}

async function preparePrivateRoomShare({ userId, room, botUsername = "" }) {
  const roomUrl = buildRoomWebAppUrl(room?.id);
  const cleanBotUsernameValue = await getBotUsername(botUsername);
  const fallbackUrl = buildMiniAppLaunchUrl(`room_${room?.id}`, cleanBotUsernameValue);

  if (!room || !roomUrl) {
    throw new Error("Private room share URL is not configured.");
  }

  return saveWithWebAppFallback({
    userId,
    webAppResult: buildRoomInlineResult(room, roomUrl, fallbackUrl, true),
    fallbackResult: buildRoomInlineResult(room, roomUrl, fallbackUrl, false),
  });
}

module.exports = {
  preparePrivateRoomShare,
  prepareReferralShare,
};
