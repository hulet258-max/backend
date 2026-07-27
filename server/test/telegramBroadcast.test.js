const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MIN_CHAT_INTERVAL_MS,
  MIN_GLOBAL_INTERVAL_MS,
  TelegramRateLimiter,
  buildPlayNowMarkup,
  callTelegram,
  deliverBroadcastRecipient,
} = require("../src/services/telegramBroadcast");

function telegramResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

test("Play now markup always opens the configured Web App", () => {
  assert.deepEqual(buildPlayNowMarkup("https://example.com/play"), {
    inline_keyboard: [[{
      text: "Play now",
      web_app: { url: "https://example.com/play" },
    }]],
  });
});

test("Play now markup is omitted when no Web App button was requested", () => {
  assert.equal(buildPlayNowMarkup(""), undefined);
});

test("rate limiter stays below the global limit and spaces calls in one chat", async () => {
  let currentTime = 1000;
  const waits = [];
  const limiter = new TelegramRateLimiter({
    now: () => currentTime,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      currentTime += milliseconds;
    },
  });

  await limiter.throttle("chat-1");
  await limiter.throttle("chat-2");
  await limiter.throttle("chat-2");

  assert.equal(waits[0], MIN_GLOBAL_INTERVAL_MS);
  assert.equal(waits[1], MIN_CHAT_INTERVAL_MS);
});

test("Telegram 429 responses honor retry_after before retrying", async () => {
  const waits = [];
  const responses = [
    telegramResponse(429, { ok: false, parameters: { retry_after: 2 } }),
    telegramResponse(200, { ok: true, result: {} }),
  ];

  const result = await callTelegram("sendMessage", { chat_id: "1", text: "hello" }, {
    token: "test-token",
    fetchImpl: async () => responses.shift(),
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(waits, [2250]);
});

test("text and image broadcasts attach the fixed Play now button", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return telegramResponse(200, { ok: true, result: {} });
  };

  await deliverBroadcastRecipient({
    user_id: "42",
    text: "Join a game",
    image_url: "https://example.com/poster.jpg",
    web_app_url: "https://example.com/play",
    delivery_step: "initial",
  }, { token: "test-token", fetchImpl });

  assert.match(calls[0].url, /sendPhoto$/);
  assert.equal(calls[0].payload.caption, "Join a game");
  assert.equal(calls[0].payload.reply_markup.inline_keyboard[0][0].text, "Play now");
});

test("broadcasts without a Web App URL send no inline button", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return telegramResponse(200, { ok: true, result: {} });
  };

  await deliverBroadcastRecipient({
    user_id: "42",
    text: "News update",
    image_url: "",
    web_app_url: "",
    delivery_step: "initial",
  }, { token: "test-token", fetchImpl });

  assert.equal(calls[0].text, "News update");
  assert.equal("reply_markup" in calls[0], false);
});

test("long image broadcasts resume after the saved photo step", async () => {
  const methods = [];
  const fetchImpl = async (url) => {
    methods.push(url.split("/").pop());
    return telegramResponse(200, { ok: true, result: {} });
  };

  await deliverBroadcastRecipient({
    user_id: "42",
    text: "x".repeat(1025),
    image_url: "https://example.com/poster.jpg",
    web_app_url: "https://example.com/play",
    delivery_step: "photo_sent",
  }, { token: "test-token", fetchImpl });

  assert.deepEqual(methods, ["sendMessage"]);
});
