// server/src/bot/bot.js

const { Telegraf } = require('telegraf');
const { COIN_BIRR_VALUE } = require("../config/economy");
const { ensureUser, getReferralLink, getRoom } = require("../db/store");

const GAME_INTRO = [
  "Welcome to Karta!",
  "",
  "How to play:",
  "1. Join a room or practice against the bot.",
  "2. On your turn, pick one card from the deck or the laid pile, then lay one card.",
  "3. Arrange your 11 cards into matching-rank groups of 4-3-3-1.",
  "4. When your hand is ready, tap Win to declare it.",
  "",
  "Public and private rooms use Birr; practice games are free.",
].join("\n");

function buildWebAppUrl(referralCode = "") {
  const webAppUrl = process.env.WEB_APP_URL;
  if (!webAppUrl) return "";

  const cleanCode = String(referralCode || "").replace(/^ref_/, "").trim();
  if (!cleanCode) return webAppUrl;

  const separator = webAppUrl.includes("?") ? "&" : "?";
  return `${webAppUrl}${separator}ref=${encodeURIComponent(cleanCode)}`;
}

function buildRoomWebAppUrl(roomId) {
  const webAppUrl = process.env.WEB_APP_URL;
  if (!webAppUrl || !roomId) return "";

  try {
    const url = new URL(webAppUrl);
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/second`;
    url.search = "";
    url.searchParams.set("roomId", String(roomId));
    url.searchParams.set("privateShare", "1");
    return url.toString();
  } catch (error) {
    const cleanBase = String(webAppUrl).replace(/\/$/, "");
    return `${cleanBase}/second?roomId=${encodeURIComponent(String(roomId))}&privateShare=1`;
  }
}

function buildMiniAppLaunchUrl(startParam, botUsername = "") {
  const cleanUsername = String(botUsername || "").replace(/^@/, "").trim();
  const cleanStartParam = String(startParam || "").trim();
  if (!cleanUsername || !cleanStartParam) return "";
  return `https://t.me/${cleanUsername}?startapp=${encodeURIComponent(cleanStartParam)}`;
}

function buildReferralPhotoUrl() {
  const configuredUrl = String(process.env.REFERRAL_SHARE_PHOTO_URL || "").trim();
  if (configuredUrl) return configuredUrl;

  try {
    const appUrl = new URL(process.env.WEB_APP_URL);
    return new URL("/karta-share.jpg", appUrl.origin).toString();
  } catch (error) {
    return "";
  }
}

function extractRoomIdFromInlineQuery(query = "") {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return "";

  const directMatch = cleanQuery.match(/(?:^|\s)(?:join[_\s-]?room|room)[_\s:-]+([A-Za-z0-9_-]+)/i);
  if (directMatch?.[1]) return directMatch[1];

  try {
    const parsed = new URL(cleanQuery);
    return parsed.searchParams.get("roomId") || "";
  } catch (error) {
    const queryParamMatch = cleanQuery.match(/[?&]roomId=([A-Za-z0-9_-]+)/i);
    return queryParamMatch?.[1] || "";
  }
}

function extractReferralCodeFromInlineQuery(query = "") {
  const match = String(query || "").trim().match(/(?:^|\s)ref_([a-f0-9]{18})(?=\s|$|[.,!?])/i);
  return match?.[1] || "";
}

function buildPlayButton(webAppUrl, fallbackUrl = "", useWebApp = true) {
  if (useWebApp) {
    return { text: "Play now", web_app: { url: webAppUrl } };
  }
  return { text: "Play now", url: fallbackUrl || webAppUrl };
}

function buildRoomInlineResult(room, roomUrl, fallbackUrl = "", useWebApp = true) {
  const roomName = room.name || "Private room";
  const playerCount = Number(room.playerCount || 0);
  const maxPlayers = Number(room.maxPlayers || 0);
  const entryFee = Number(room.entryFee || 0) * COIN_BIRR_VALUE;

  return {
    type: "article",
    id: `room-${room.id}`,
    title: "Share private Karta game",
    description: `${roomName} | ${playerCount}/${maxPlayers} players | ${entryFee} Birr`,
    input_message_content: {
      message_text: [
        "Private Karta game",
        `Room: ${roomName}`,
        `Players: ${playerCount}/${maxPlayers}`,
        `Entry: ${entryFee} Birr`,
        "",
        "Tap Play now to join the game.",
      ].join("\n"),
    },
    reply_markup: {
      inline_keyboard: [[buildPlayButton(roomUrl, fallbackUrl, useWebApp)]],
    },
  };
}

async function answerRoomInlineQuery(ctx, room, roomUrl, fallbackUrl) {
  const options = { cache_time: 0, is_personal: true };
  try {
    await ctx.answerInlineQuery(
      [buildRoomInlineResult(room, roomUrl, fallbackUrl, true)],
      options
    );
  } catch (error) {
    const message = String(error?.description || error?.message || "");
    if (!/web_app|button_type|BUTTON_TYPE/i.test(message)) throw error;
    await ctx.answerInlineQuery(
      [buildRoomInlineResult(room, roomUrl, fallbackUrl, false)],
      options
    );
  }
}

function buildReferralInlineResult(code, photoUrl, webAppUrl, fallbackUrl = "", useWebApp = true) {
  return {
    type: "photo",
    id: `ref-${code}`,
    photo_url: photoUrl,
    thumbnail_url: photoUrl,
    title: "Share Karta and earn Birr",
    description: "Invite a friend to play Karta.",
    caption: [
      "Play Karta and get Birr!",
      "Join rooms, play cards, and win rewards.",
      "",
      "Tap Play now to start.",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[buildPlayButton(webAppUrl, fallbackUrl, useWebApp)]],
    },
  };
}

async function answerReferralInlineQuery(ctx, code, photoUrl, webAppUrl, fallbackUrl) {
  const options = { cache_time: 0, is_personal: true };
  try {
    await ctx.answerInlineQuery(
      [buildReferralInlineResult(code, photoUrl, webAppUrl, fallbackUrl, true)],
      options
    );
  } catch (error) {
    const message = String(error?.description || error?.message || "");
    if (!/web_app|button_type|BUTTON_TYPE/i.test(message)) throw error;
    await ctx.answerInlineQuery(
      [buildReferralInlineResult(code, photoUrl, webAppUrl, fallbackUrl, false)],
      options
    );
  }
}

/**
 * Create and configure Telegram bot
 */
function createBot() {
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN missing in env');
  }

  const bot = new Telegraf(process.env.BOT_TOKEN);

  // /start command
  bot.start(async (ctx) => {
    const webAppUrl = buildWebAppUrl(ctx.startPayload);
    try {
      await ensureUser(ctx.from.id);
    } catch (err) {
      console.error('Bot start user sync error:', err);
    }

    const photoUrl = buildReferralPhotoUrl();
    const replyMarkup = webAppUrl ? {
          inline_keyboard: [
            [{ text: 'Play now', web_app: { url: webAppUrl } }]
          ]
    } : undefined;

    if (photoUrl) {
      try {
        await ctx.replyWithPhoto(photoUrl, {
          caption: GAME_INTRO,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        return;
      } catch (error) {
        console.error("Bot start photo send failed:", error);
      }
    }

    {
      await ctx.reply(GAME_INTRO, {
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
  });

  bot.on('inline_query', async (ctx) => {
    const referralCode = extractReferralCodeFromInlineQuery(ctx.inlineQuery?.query);
    if (referralCode) {
      try {
        const referralLink = await getReferralLink(referralCode);
        const photoUrl = buildReferralPhotoUrl();
        const webAppUrl = buildWebAppUrl(referralCode);
        const fallbackUrl = buildMiniAppLaunchUrl(`ref_${referralCode}`, ctx.botInfo?.username);

        if (!referralLink || !photoUrl || !webAppUrl) {
          return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
        }

        await answerReferralInlineQuery(ctx, referralCode, photoUrl, webAppUrl, fallbackUrl);
        return;
      } catch (err) {
        console.error('Bot inline referral share error:', err);
        return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      }
    }

    const roomId = extractRoomIdFromInlineQuery(ctx.inlineQuery?.query);

    if (!roomId) {
      return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    }

    try {
      const room = await getRoom(roomId);
      const roomUrl = buildRoomWebAppUrl(room?.id);
      const fallbackUrl = buildMiniAppLaunchUrl(`room_${room?.id}`, ctx.botInfo?.username);

      if (!room || !roomUrl || room.visibility !== "private" || room.status !== "waiting") {
        return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      }

      await answerRoomInlineQuery(ctx, room, roomUrl, fallbackUrl);
    } catch (err) {
      console.error('Bot inline room share error:', err);
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    }
  });

  bot.action(/^withdraw_sent:(.+):(\d+)$/, async (ctx) => {
    try {
      const userId = String(ctx.match?.[1] || "").trim();
      const amount = Number(ctx.match?.[2] || 0);
      const birrAmount = amount * COIN_BIRR_VALUE;

      if (userId) {
        await ctx.telegram.sendMessage(
          userId,
          [
            "✅ Withdrawal sent",
            "",
            `Your withdrawal request for ${birrAmount} Birr has been marked as sent by admin.`,
          ].join("\n")
        );
      }

      await ctx.answerCbQuery('User notified');
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [{ text: 'Done', callback_data: 'withdraw_done' }]
        ]
      });
    } catch (err) {
      console.error('Withdraw button callback error:', err);
      await ctx.answerCbQuery('Could not notify user', { show_alert: true }).catch(() => {});
    }
  });

  bot.action('withdraw_sent', async (ctx) => {
    try {
      await ctx.answerCbQuery('Marked as done');
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [{ text: 'Done', callback_data: 'withdraw_done' }]
        ]
      });
    } catch (err) {
      console.error('Withdraw legacy button callback error:', err);
    }
  });

  bot.action('withdraw_done', async (ctx) => {
    await ctx.answerCbQuery('Already done');
  });

  return bot;
}

/**
 * Start bot safely
 */
async function startBot(bot) {
  console.log(' Bot started');
  console.log('🤖 Bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  await bot.launch();
}

module.exports = {
  createBot,
  startBot,
  buildMiniAppLaunchUrl,
  buildReferralInlineResult,
  buildReferralPhotoUrl,
  buildRoomInlineResult,
  buildRoomWebAppUrl,
  buildWebAppUrl,
};
