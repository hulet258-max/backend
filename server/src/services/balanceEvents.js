const { redis } = require("../config/redis");
const { getUser } = require("../db/store");

async function emitBalanceUpdates(io, userIds = []) {
  if (!io || !redis.isOpen) return;

  const uniqueIds = [...new Set((userIds || []).map(String).filter(Boolean))];
  for (const userId of uniqueIds) {
    const user = await getUser(userId);
    if (!user) continue;

    const socketId = await redis.get(`user:${userId}:socket`);
    if (socketId) {
      io.to(socketId).emit("balance_update", {
        userId,
        balance: user.balance,
        user,
      });
    }
  }
}

module.exports = {
  emitBalanceUpdates,
};
