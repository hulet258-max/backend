const { pool, query } = require("../config/postgres");

const BROADCAST_LOCK_ID = 72401831;
const MIN_GLOBAL_INTERVAL_MS = 40; // 25 calls/second, below Telegram's ~30/sec limit.
const MIN_CHAT_INTERVAL_MS = 1000;
const IDLE_POLL_MS = 2000;
const PLAY_BUTTON_TEXT = "Play now";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function buildPlayNowMarkup(webAppUrl) {
  if (!webAppUrl) return undefined;
  return {
    inline_keyboard: [[{ text: PLAY_BUTTON_TEXT, web_app: { url: webAppUrl } }]],
  };
}

class TelegramRateLimiter {
  constructor({ now = Date.now, wait = sleep } = {}) {
    this.now = now;
    this.wait = wait;
    this.lastGlobalCallAt = 0;
    this.lastChatCallAt = new Map();
  }

  async throttle(chatId) {
    const now = this.now();
    const globalWait = this.lastGlobalCallAt
      ? MIN_GLOBAL_INTERVAL_MS - (now - this.lastGlobalCallAt)
      : 0;
    const lastChatCallAt = this.lastChatCallAt.get(String(chatId)) || 0;
    const chatWait = lastChatCallAt
      ? MIN_CHAT_INTERVAL_MS - (now - lastChatCallAt)
      : 0;
    const delay = Math.max(0, globalWait, chatWait);
    if (delay > 0) await this.wait(delay);

    const calledAt = this.now();
    this.lastGlobalCallAt = calledAt;
    this.lastChatCallAt.set(String(chatId), calledAt);
  }
}

class TelegramRequestError extends Error {
  constructor(message, {
    status = 0,
    retryable = false,
    attempts = 1,
    retryAfterMs = 0,
  } = {}) {
    super(message);
    this.name = "TelegramRequestError";
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
  }
}

async function callTelegram(method, payload, options = {}) {
  const token = options.token || process.env.BOT_TOKEN;
  const fetchImpl = options.fetchImpl || fetch;
  const wait = options.wait || sleep;
  const limiter = options.limiter;
  const chatId = String(payload.chat_id);
  let attempts = 0;

  if (!token) throw new TelegramRequestError("BOT_TOKEN is not configured.");

  while (attempts < 5) {
    attempts += 1;
    if (limiter) await limiter.throttle(chatId);

    let response;
    let data = {};
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      data = await response.json().catch(() => ({}));
    } catch (error) {
      if (attempts < 3) {
        await wait(250 * (2 ** (attempts - 1)));
        continue;
      }
      throw new TelegramRequestError(error.message || "Telegram network request failed.", {
        retryable: true,
        attempts,
      });
    }

    if (response.ok && data.ok !== false) return { data, attempts };

    const retryAfterSeconds = Number(data?.parameters?.retry_after || 0);
    if (response.status === 429 && retryAfterSeconds > 0 && attempts < 5) {
      await wait((retryAfterSeconds * 1000) + 250);
      continue;
    }
    if (response.status >= 500 && attempts < 3) {
      await wait(250 * (2 ** (attempts - 1)));
      continue;
    }

    throw new TelegramRequestError(
      data.description || `Telegram request failed (${response.status})`,
      {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        attempts,
        retryAfterMs: retryAfterSeconds ? (retryAfterSeconds * 1000) + 250 : 0,
      }
    );
  }

  throw new TelegramRequestError("Telegram request retry limit reached.", {
    retryable: true,
    attempts,
  });
}

async function deliverBroadcastRecipient(recipient, options = {}) {
  const limiter = options.limiter;
  const telegramOptions = {
    limiter,
    token: options.token,
    fetchImpl: options.fetchImpl,
    wait: options.wait,
  };
  const chatId = String(recipient.user_id);
  const text = String(recipient.text || "");
  const imageUrl = String(recipient.image_url || "");
  const replyMarkup = buildPlayNowMarkup(recipient.web_app_url);
  let attempts = 0;

  if (imageUrl && text.length > 1024) {
    if (recipient.delivery_step !== "photo_sent") {
      const photoResult = await callTelegram("sendPhoto", {
        chat_id: chatId,
        photo: imageUrl,
      }, telegramOptions);
      attempts += photoResult.attempts;
      if (options.onDeliveryStep) {
        await options.onDeliveryStep("photo_sent", photoResult.attempts);
        attempts -= photoResult.attempts;
      }
    }
    const textResult = await callTelegram("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, telegramOptions);
    attempts += textResult.attempts;
    return { attempts };
  }

  if (imageUrl) {
    const result = await callTelegram("sendPhoto", {
      chat_id: chatId,
      photo: imageUrl,
      ...(text ? { caption: text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, telegramOptions);
    return { attempts: result.attempts };
  }

  const result = await callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }, telegramOptions);
  return { attempts: result.attempts };
}

class TelegramBroadcastWorker {
  constructor() {
    this.running = false;
    this.loopPromise = null;
    this.lockClient = null;
    this.wakeResolver = null;
    this.limiter = new TelegramRateLimiter();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log("[broadcast] Worker started; waiting for queued messages.");
    this.loopPromise = this.run();
  }

  async stop() {
    const wasRunning = this.running || Boolean(this.loopPromise);
    this.running = false;
    this.wake();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
    if (wasRunning) console.log("[broadcast] Worker stopped.");
  }

  wake() {
    if (this.wakeResolver) this.wakeResolver();
    this.wakeResolver = null;
  }

  async waitForWork() {
    await Promise.race([
      sleep(IDLE_POLL_MS),
      new Promise((resolve) => { this.wakeResolver = resolve; }),
    ]);
    this.wakeResolver = null;
  }

  async acquireLock() {
    if (this.lockClient) return true;
    const client = await pool.connect();
    const result = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [BROADCAST_LOCK_ID]);
    if (!result.rows[0]?.acquired) {
      client.release();
      return false;
    }
    this.lockClient = client;
    await query("UPDATE admin_message_recipients SET status = 'pending' WHERE status = 'processing'");
    await query(`
      UPDATE admin_messages m
      SET status = 'completed', completed_at = COALESCE(completed_at, NOW())
      WHERE m.status IN ('queued', 'sending')
        AND NOT EXISTS (
          SELECT 1 FROM admin_message_recipients r
          WHERE r.message_id = m.id AND r.status IN ('pending', 'processing')
        )
    `);
    return true;
  }

  async releaseLock() {
    if (!this.lockClient) return;
    try {
      await this.lockClient.query("SELECT pg_advisory_unlock($1)", [BROADCAST_LOCK_ID]);
    } finally {
      this.lockClient.release();
      this.lockClient = null;
    }
  }

  async claimRecipient() {
    const result = await query(`
      WITH candidate AS (
        SELECT r.id
        FROM admin_message_recipients r
        JOIN admin_messages m ON m.id = r.message_id
        WHERE r.status = 'pending'
          AND r.next_attempt_at <= NOW()
          AND m.status IN ('queued', 'sending')
        ORDER BY m.created_at ASC, r.id ASC
        LIMIT 1
        FOR UPDATE OF r SKIP LOCKED
      )
      UPDATE admin_message_recipients r
      SET status = 'processing'
      FROM candidate c, admin_messages m
      WHERE r.id = c.id AND m.id = r.message_id
      RETURNING r.*, m.text, m.image_url, m.web_app_url
    `);
    const recipient = result.rows[0];
    if (!recipient) return null;

    const started = await query(`
      UPDATE admin_messages
      SET status = 'sending', started_at = COALESCE(started_at, NOW())
      WHERE id = $1 AND status = 'queued'
      RETURNING id, target_count
    `, [recipient.message_id]);
    if (started.rows[0]) {
      console.log(
        `[broadcast:${recipient.message_id}] Started sending to ${Number(started.rows[0].target_count || 0)} recipient(s).`
      );
    }
    return recipient;
  }

  async getMessageProgress(messageId) {
    const result = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status IN ('sent', 'failed'))::int AS processed
      FROM admin_message_recipients
      WHERE message_id = $1
    `, [messageId]);
    const progress = result.rows[0] || {};
    const total = Number(progress.total || 0);
    const processed = Number(progress.processed || 0);
    return {
      total,
      sent: Number(progress.sent || 0),
      failed: Number(progress.failed || 0),
      processed,
      percent: total ? Math.round((processed / total) * 100) : 0,
    };
  }

  async finishMessage(messageId, progress) {
    const result = await query(`
      UPDATE admin_messages m
      SET status = 'completed', completed_at = NOW()
      WHERE m.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM admin_message_recipients r
          WHERE r.message_id = m.id AND r.status IN ('pending', 'processing')
        )
      RETURNING m.id
    `, [messageId]);
    if (result.rows[0]) {
      console.log(
        `[broadcast:${messageId}] Completed: ${progress.sent} sent, ${progress.failed} failed, ${progress.total} total.`
      );
    }
  }

  async processRecipient(recipient) {
    try {
      const result = await deliverBroadcastRecipient(recipient, {
        limiter: this.limiter,
        onDeliveryStep: async (step, attempts) => {
          await query(`
            UPDATE admin_message_recipients
            SET delivery_step = $2, attempt_count = attempt_count + $3
            WHERE id = $1
          `, [recipient.id, step, attempts]);
        },
      });
      await query(`
        UPDATE admin_message_recipients
        SET status = 'sent', error = '', sent_at = NOW(),
          attempt_count = attempt_count + $2, delivery_step = 'complete'
        WHERE id = $1
      `, [recipient.id, result.attempts]);
      const progress = await this.getMessageProgress(recipient.message_id);
      console.log(
        `[broadcast:${recipient.message_id}] Sent to user ${recipient.user_id} `
        + `(${progress.processed}/${progress.total}, ${progress.percent}% — ${progress.sent} sent, ${progress.failed} failed).`
      );
      await this.finishMessage(recipient.message_id, progress);
      return;
    } catch (error) {
      const attempts = Number(error.attempts || 1);
      const totalAttempts = Number(recipient.attempt_count || 0) + attempts;
      const errorMessage = String(error.message || "Telegram delivery failed.").slice(0, 500);
      if (error.retryable && totalAttempts < 10) {
        const retryDelayMs = Number(error.retryAfterMs || Math.min(60000, 1000 * (2 ** totalAttempts)));
        await query(`
          UPDATE admin_message_recipients
          SET status = 'pending', error = $2, attempt_count = attempt_count + $3,
            next_attempt_at = NOW() + ($4 * INTERVAL '1 millisecond')
          WHERE id = $1
        `, [recipient.id, errorMessage, attempts, retryDelayMs]);
        console.warn(
          `[broadcast:${recipient.message_id}] Delivery to user ${recipient.user_id} will retry `
          + `in ${retryDelayMs}ms (attempts: ${totalAttempts}): ${errorMessage}`
        );
      } else {
        await query(`
          UPDATE admin_message_recipients
          SET status = 'failed', error = $2, attempt_count = attempt_count + $3
          WHERE id = $1
        `, [recipient.id, errorMessage, attempts]);
        console.error(
          `[broadcast:${recipient.message_id}] Delivery to user ${recipient.user_id} failed `
          + `after ${totalAttempts} attempt(s): ${errorMessage}`
        );
      }
    }
    const progress = await this.getMessageProgress(recipient.message_id);
    if (progress.processed > 0) {
      console.log(
        `[broadcast:${recipient.message_id}] Progress: ${progress.processed}/${progress.total} `
        + `(${progress.percent}% — ${progress.sent} sent, ${progress.failed} failed).`
      );
    }
    await this.finishMessage(recipient.message_id, progress);
  }

  async run() {
    try {
      while (this.running) {
        try {
          if (!await this.acquireLock()) {
            await this.waitForWork();
            continue;
          }
          const recipient = await this.claimRecipient();
          if (!recipient) {
            await this.waitForWork();
            continue;
          }
          await this.processRecipient(recipient);
        } catch (error) {
          console.error("[broadcast] Worker error:", error);
          await sleep(IDLE_POLL_MS);
        }
      }
    } finally {
      await this.releaseLock();
    }
  }
}

const broadcastWorker = new TelegramBroadcastWorker();

module.exports = {
  MIN_CHAT_INTERVAL_MS,
  MIN_GLOBAL_INTERVAL_MS,
  PLAY_BUTTON_TEXT,
  TelegramBroadcastWorker,
  TelegramRateLimiter,
  buildPlayNowMarkup,
  callTelegram,
  deliverBroadcastRecipient,
  startBroadcastWorker: () => broadcastWorker.start(),
  stopBroadcastWorker: () => broadcastWorker.stop(),
  wakeBroadcastWorker: () => broadcastWorker.wake(),
};
