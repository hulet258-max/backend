// server/src/bot/bot.js

const { Telegraf } = require('telegraf');
const { ensureUser, getRoom } = require("../db/store");

const GAME_INTRO = [
  "Welcome to Karta!",
  "",
  "How to play:",
  "1. Join a room or practice against the bot.",
  "2. On your turn, pick one card from the deck or the laid pile, then lay one card.",
  "3. Arrange your 11 cards into matching-rank groups of 4-3-3-1.",
  "4. When your hand is ready, tap Win to declare it.",
  "",
  "Public and private rooms use coins; practice games are free.",
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
    url.pathname = `${basePath}/game/${encodeURIComponent(String(roomId))}`;
    url.search = "";
    return url.toString();
  } catch (error) {
    const cleanBase = String(webAppUrl).replace(/\/$/, "");
    return `${cleanBase}/game/${encodeURIComponent(String(roomId))}`;
  }
}

function buildRoomLaunchUrl(roomId, botUsername = "") {
  const cleanUsername = String(botUsername || "").replace(/^@/, "").trim();
  if (cleanUsername && roomId) {
    const startParam = `room_${roomId}`;
    return `https://t.me/${cleanUsername}?startapp=${encodeURIComponent(startParam)}`;
  }

  return buildRoomWebAppUrl(roomId);
}

function extractRoomIdFromInlineQuery(query = "") {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return "";

  const directMatch = cleanQuery.match(/^join[_\s-]?room[_\s:-]+([A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*)$/i);
  if (directMatch?.[1]) return directMatch[1];

  try {
    const parsed = new URL(cleanQuery);
    return parsed.searchParams.get("roomId") || "";
  } catch (error) {
    const queryParamMatch = cleanQuery.match(/[?&]roomId=([A-Za-z0-9_-]+)/i);
    return queryParamMatch?.[1] || "";
  }
}

function buildRoomInlineResult(room, roomUrl) {
  const roomName = room.name || "Private room";
  const playerCount = Number(room.playerCount || 0);
  const maxPlayers = Number(room.maxPlayers || 0);
  const entryFee = Number(room.entryFee || 0);

  return {
    type: "article",
    id: `room-${room.id}`,
    title: "Share private Karta game",
    description: `${roomName} | ${playerCount}/${maxPlayers} players | ${entryFee} coins`,
    input_message_content: {
      message_text: [
        "Private Karta game",
        `Room: ${roomName}`,
        `Players: ${playerCount}/${maxPlayers}`,
        `Entry: ${entryFee} coins`,
        "",
        "Tap Play now to join the game.",
      ].join("\n"),
    },
    reply_markup: {
      inline_keyboard: [[{ text: "Play now", url: roomUrl }]],
    },
  };
}

async function answerRoomInlineQuery(ctx, room, roomUrl) {
  const options = { cache_time: 0, is_personal: true };
  await ctx.answerInlineQuery([buildRoomInlineResult(room, roomUrl)], options);
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

    await ctx.reply(GAME_INTRO, {
      reply_markup: { remove_keyboard: true },
    });

    if (webAppUrl) {
      await ctx.reply('Ready to play?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Play now', web_app: { url: webAppUrl } }]
          ]
        }
      });
    }
  });

  bot.on('inline_query', async (ctx) => {
    const roomId = extractRoomIdFromInlineQuery(ctx.inlineQuery?.query);

    if (!roomId) {
      return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    }

    try {
      const room = await getRoom(roomId);
      const roomUrl = buildRoomLaunchUrl(room?.id, ctx.botInfo?.username);

      if (!room || !roomUrl || room.visibility !== "private" || room.status !== "waiting") {
        return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      }

      await answerRoomInlineQuery(ctx, room, roomUrl);
    } catch (err) {
      console.error('Bot inline room share error:', err);
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
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
      console.error('Withdraw button callback error:', err);
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

module.exports = { createBot, startBot };
