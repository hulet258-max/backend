const { redis } = require("../config/redis");
const { getUser } = require("../db/store");
const { sanitizeSettlement } = require("./playerPayload");

function buildSocketByUserId(players = []) {
  const map = {};
  (players || []).forEach((player) => {
    const userId = String(player?.telegramId || player?.id || player || "");
    const socketId = player?.socketId;
    if (userId && socketId) {
      map[userId] = String(socketId);
    }
  });
  return map;
}

async function resolveSocketId(userId, socketByUserId = {}) {
  const fromMap = socketByUserId[String(userId)];
  if (fromMap) return String(fromMap);
  if (!redis.isOpen) return null;
  return redis.get(`user:${userId}:socket`);
}

async function emitBalanceUpdates(io, userIds = [], options = {}) {
  if (!io) return;

  const uniqueIds = [...new Set((userIds || []).map(String).filter(Boolean))];
  const socketByUserId = options.socketByUserId || {};
  const settlement = sanitizeSettlement(options.settlement || null);

  for (const userId of uniqueIds) {
    const user = await getUser(userId);
    if (!user) continue;

    const socketId = await resolveSocketId(userId, socketByUserId);
    if (!socketId) {
      console.warn(`[balanceEvents] No socket for user ${userId}; balance not pushed`);
      continue;
    }

    io.to(socketId).emit("balance_update", {
      userId,
      balance: user.balance,
      user,
      settlement,
    });
  }
}

module.exports = {
  buildSocketByUserId,
  emitBalanceUpdates,
};
