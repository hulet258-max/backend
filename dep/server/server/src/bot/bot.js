// server/src/bot/bot.js

const { Telegraf } = require('telegraf');

/**
 * Create and configure Telegram bot
 */
function createBot(db) {
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN missing in env');
  }

  const bot = new Telegraf(process.env.BOT_TOKEN);

  // /start command
  bot.start(async (ctx) => {
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
  });

  // contact handler
  bot.on('contact', async (ctx) => {
    try {

      const contact = ctx.message.contact;

      // verify ownership
      if (contact.user_id !== ctx.from.id) {
        return ctx.reply(' Please share your own number.');
      }

      const userRef = db.collection('users').doc(String(ctx.from.id));
      const userDoc = await userRef.get();

      let userData;

      if (!userDoc.exists) {

        // FIRST TIME USER
        userData = {
          telegramId: ctx.from.id,
          phone: contact.phone_number,
          username: ctx.from.username || '',
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',

          // NEW GAME FIELDS
          balance: 0,
          roomIn: null,
          depositSum: 0,

          createdAt: new Date(),
          lastSeen: new Date()
        };

      } else {

        // EXISTING USER
        userData = {
          phone: contact.phone_number,
          username: ctx.from.username || '',
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',
          lastSeen: new Date()
        };

      }

      await userRef.set(userData, { merge: true });


      const webAppUrl = process.env.WEB_APP_URL;

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

      if (err.code === 5) {
        console.error(
          ' Firestore Error: Database not found. Create it in Firebase Console.'
        );
      }

      ctx.reply(' Failed to save your data.');

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