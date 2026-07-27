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
  // Hide house-edge knobs from clients (managed bot control).
  const clean = withoutKeys(stats, [
    "commissionAmount",
    "commissionRate",
    "houseControl",
    "housePressure",
    "targetBotWinRate",
    "botDifficulty",
    "scriptedWinner",
    "scriptedBotWins",
    "scriptedWinnerId",
    "scriptedBotWinProbability",
    "scriptedFactors",
    "scriptedForced",
    "scriptedGuaranteed",
    "scriptedForceReason",
    "roundPressure",
    "managedBonusIntroStage",
    "managedLeaveThisRound",
    "managedLeaveAfterBotTurns",
    "managedLeaveReplacementFee",
    "managedRoundContext",
    "managedRoundContextRevision",
    "managedBotDeparted",
    "managedReplacementFee",
    "cardFlowPlan",
    "openingPairTarget",
    "openingPairCalibration",
    "jokerAssistedRound",
    "jokerAssistCount",
    "automatedCallTurnToken",
    "turnGeneration",
    "turnToken",
  ]);
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
  const clean = withoutKeys(redisData, [
    "houseControl",
    "housePressure",
    "targetBotWinRate",
    "botDifficulty",
    "scriptedWinner",
    "scriptedBotWins",
    "scriptedWinnerId",
    "scriptedBotWinProbability",
    "scriptedFactors",
    "scriptedForced",
    "scriptedGuaranteed",
    "scriptedForceReason",
    "roundPressure",
    "botReadyAt",
    "minPicksBeforeWin",
    "cardFlowPlan",
    "openingPairTarget",
    "openingPairCalibration",
    "jokerAssistedRound",
    "jokerAssistCount",
    "managedBonusIntroStage",
    "managedLeaveThisRound",
    "managedLeaveAfterBotTurns",
    "managedLeaveReplacementFee",
    "managedRoundContext",
    "managedRoundContextRevision",
    "managedBotDeparted",
    "managedReplacementFee",
    "automatedCallTurnToken",
    "turnGeneration",
    "turnToken",
  ]);
  return {
    ...clean,
    roomStats: sanitizeRoomStats(redisData.roomStats),
    gameResult: sanitizeGameResult(redisData.gameResult),
  };
}

function sanitizeRedisDataForPlayer(redisData = null, playerId = null) {
  const clean = sanitizeRedisData(redisData);
  if (!clean?.rematch?.active || !playerId) return clean;
  const previousPlayers = (clean.rematch.previousRoundPlayerIds || []).map(String);
  if (previousPlayers.includes(String(playerId))) return clean;
  return {
    ...clean,
    gameResult: null,
    playerCards: {},
    deck: [],
    laidCards: [],
    previousRoundSpectator: true,
  };
}

function sanitizeSettlement(settlement = null) {
  return sanitizeLastSettlement(settlement);
}

function buildRoomUpdatePayload(room, redisData, playerId = null) {
  return {
    room: sanitizeRoom(room),
    players: room?.players || [],
    redisData: playerId
      ? sanitizeRedisDataForPlayer(redisData, playerId)
      : sanitizeRedisData(redisData),
  };
}

module.exports = {
  buildRoomUpdatePayload,
  sanitizeGameResult,
  sanitizeRedisData,
  sanitizeRedisDataForPlayer,
  sanitizeRoom,
  sanitizeSettlement,
};
