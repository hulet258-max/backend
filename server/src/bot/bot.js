// server/src/bot/bot.js

const { Telegraf } = require('telegraf');
const { WELCOME_GIFT_COINS } = require("../config/economy");
const { getRoom, getUser, upsertUser } = require("../db/store");

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
    return url.toString();
  } catch (error) {
    const cleanBase = String(webAppUrl).replace(/\/$/, "");
    return `${cleanBase}/second?roomId=${encodeURIComponent(String(roomId))}`;
  }
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

function buildRoomInlineResult(room, roomUrl, useWebAppButton = true) {
  const button = useWebAppButton
    ? { text: "Join this", web_app: { url: roomUrl } }
    : { text: "Join this", url: roomUrl };

  return {
    type: "article",
    id: `room-${room.id}`,
    title: "Join this",
    description: `${room.name} - ${room.playerCount}/${room.maxPlayers} players`,
    input_message_content: {
      message_text: `Karta private room: ${room.name}`,
    },
    reply_markup: {
      inline_keyboard: [[button]],
    },
  };
}

async function answerRoomInlineQuery(ctx, room, roomUrl) {
  const options = { cache_time: 0, is_personal: true };

  try {
    await ctx.answerInlineQuery([buildRoomInlineResult(room, roomUrl, true)], options);
  } catch (error) {
    const message = String(error?.description || error?.message || "");
    if (!/web_app|button_type|BUTTON_TYPE/i.test(message)) {
      throw error;
    }

    await ctx.answerInlineQuery([buildRoomInlineResult(room, roomUrl, false)], options);
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
    await ctx.reply(
      'Welcome 👋\nPlease share your phone number to continue.',
      {
        reply_markup: {
          keyboard: [
            [{ text: '📱 Share Phone Number', request_contact: true }]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );

    if (webAppUrl) {
      await ctx.reply(' Open the Web App', {
        reply_markup: {
          inline_keyboard: [
            [{ text: ' Open Web App', web_app: { url: webAppUrl } }]
          ]
        }
      });
    }
  });

  // contact handler
  bot.on('contact', async (ctx) => {
    try {

      const contact = ctx.message.contact;

      // verify ownership
      if (contact.user_id !== ctx.from.id) {
        return ctx.reply(' Please share your own number.');
      }

      const existingUser = await getUser(ctx.from.id);

      let userData;

      if (!existingUser) {

        // FIRST TIME USER
        userData = {
          telegramId: ctx.from.id,
          phone: contact.phone_number,
          username: ctx.from.username || '',
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',

          // NEW GAME FIELDS
          balance: WELCOME_GIFT_COINS,
          roomIn: null,
          depositSum: 0,

          createdAt: new Date(),
          lastSeen: new Date()
        };

      } else {

        // EXISTING USER
        userData = {
          telegramId: ctx.from.id,
          phone: contact.phone_number,
          username: ctx.from.username || '',
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',
          lastSeen: new Date()
        };

      }

      await upsertUser(userData);


      const webAppUrl = buildWebAppUrl();

      await ctx.reply(' Registration complete.', {
        reply_markup: { remove_keyboard: true }
      });

      if (webAppUrl) {
        await ctx.reply(' Open the Web App', {
          reply_markup: {
            inline_keyboard: [
              [{ text: ' Open Web App', web_app: { url: webAppUrl } }]
            ]
          }
        });
      }

    } catch (err) {

      console.error('Bot contact error:', err);

      ctx.reply(' Failed to save your data.');

    }
  });

  bot.on('inline_query', async (ctx) => {
    const roomId = extractRoomIdFromInlineQuery(ctx.inlineQuery?.query);

    if (!roomId) {
      return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    }

    try {
      const room = await getRoom(roomId);
      const roomUrl = buildRoomWebAppUrl(room?.id);

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
