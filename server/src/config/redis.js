const { createClient } = require("redis");

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

function buildRedisUrl() {
  const url = new URL(process.env.REDIS_URL || DEFAULT_REDIS_URL);

  if (process.env.REDIS_USERNAME) {
    url.username = process.env.REDIS_USERNAME;
  }

  if (process.env.REDIS_PASSWORD) {
    url.password = process.env.REDIS_PASSWORD;
  }

  return url.toString();
}

const redis = createClient({
  url: buildRedisUrl()
});

redis.on("error", (err) => {
  console.error("❌ Redis Error:", err);
});

async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
    console.log("⚡ Redis connected");
  }
}

module.exports = {
  redis,
  connectRedis
};
