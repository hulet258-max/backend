function withoutKeys(source = {}, blockedKeys = []) {
  if (!source || typeof source !== "object") return source;
  const blocked = new Set(blockedKeys);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !blocked.has(key))
  );
}

function sanitizeGameRecord(game = {}) {
  return withoutKeys(game, ["roundCommission", "commissionRate", "commissionAmount"]);
}

function sanitizeLastSettlement(settlement = null) {
  if (!settlement || typeof settlement !== "object") return null;
  return withoutKeys(settlement, ["commissionAmount", "commissionRate"]);
}

function sanitizeRoomStats(stats = null) {
  if (!stats || typeof stats !== "object") return stats;
  const clean = withoutKeys(stats, ["commissionAmount", "commissionRate"]);
  clean.games = Array.isArray(stats.games) ? stats.games.map(sanitizeGameRecord) : [];
  clean.lastSettlement = sanitizeLastSettlement(stats.lastSettlement);
  return clean;
}

function sanitizeGameResult(result = null) {
  if (!result || typeof result !== "object") return result;
  return withoutKeys(result, ["roundCommission", "commissionRate", "commissionAmount"]);
}

function sanitizeRoom(room = null) {
  if (!room || typeof room !== "object") return room;
  return {
    ...room,
    roomStats: sanitizeRoomStats(room.roomStats),
  };
}

function sanitizeRedisData(redisData = null) {
  if (!redisData || typeof redisData !== "object") return redisData;
  return {
    ...redisData,
    roomStats: sanitizeRoomStats(redisData.roomStats),
    gameResult: sanitizeGameResult(redisData.gameResult),
  };
}

function sanitizeSettlement(settlement = null) {
  return sanitizeLastSettlement(settlement);
}

function buildRoomUpdatePayload(room, redisData) {
  return {
    room: sanitizeRoom(room),
    players: room?.players || [],
    redisData: sanitizeRedisData(redisData),
  };
}

module.exports = {
  buildRoomUpdatePayload,
  sanitizeGameResult,
  sanitizeRedisData,
  sanitizeRoom,
  sanitizeSettlement,
};
