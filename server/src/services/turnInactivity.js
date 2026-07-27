const TURN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

const toTimestamp = (value) => {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const getTurnActivityTimestamp = (gameState = {}) => {
  const explicit = toTimestamp(gameState.turnActivityAt);
  if (explicit !== null) return explicit;

  const lastLayTargetsTurn = gameState.lastLay?.targetPlayerId &&
    String(gameState.lastLay.targetPlayerId) === String(gameState.turn || "");
  if (lastLayTargetsTurn) {
    const lastLay = toTimestamp(gameState.lastLay.at);
    if (lastLay !== null) return lastLay;
  }

  return toTimestamp(gameState.lastActivityAt || gameState.createdAt);
};

const markTurnActivity = (gameState, now = Date.now()) => {
  const timestamp = new Date(now).toISOString();
  gameState.turnActivityAt = timestamp;
  gameState.turnGeneration = Math.max(0, Math.floor(Number(gameState.turnGeneration) || 0)) + 1;
  gameState.turnToken = `${gameState.turnGeneration}:${String(gameState.turn || "")}:${timestamp}`;
  return timestamp;
};

const getTimedOutOpponentTurn = (
  gameState,
  requestingUserId,
  now = Date.now(),
  timeoutMs = TURN_INACTIVITY_TIMEOUT_MS
) => {
  if (!gameState || gameState.status !== "playing" || gameState.gameEnded || gameState.paused) {
    return null;
  }

  const inactivePlayerId = String(gameState.turn || "");
  const requesterId = String(requestingUserId || "");
  if (!inactivePlayerId || !requesterId || inactivePlayerId === requesterId) return null;
  const playerIds = (gameState.players || []).map((player) => (
    String(player?.telegramId ?? player)
  ));
  if (!playerIds.includes(inactivePlayerId) || !playerIds.includes(requesterId)) return null;

  const activityTimestamp = getTurnActivityTimestamp(gameState);
  if (activityTimestamp === null) return null;
  const inactiveForMs = Math.max(0, Number(now) - activityTimestamp);
  if (inactiveForMs < timeoutMs) return null;

  return {
    inactivePlayerId,
    inactiveForMs,
    turnActivityAt: new Date(activityTimestamp).toISOString(),
    timeoutMs,
  };
};

module.exports = {
  TURN_INACTIVITY_TIMEOUT_MS,
  getTimedOutOpponentTurn,
  getTurnActivityTimestamp,
  markTurnActivity,
};
