const REMATCH_READY_TIMEOUT_MS = 40 * 1000;

const isBotPlayerId = (playerId) => String(playerId || "").startsWith("botgamer:");

const uniqueIds = (playerIds = []) => [...new Set(playerIds.map(String))];

const createRematchState = (playerIds, now = Date.now(), options = {}) => {
  const participantIds = uniqueIds(playerIds);
  // autoReadyBots defaults true (tests / pure human rooms). Bot games pass false
  // and schedule a 1–4s delayed ready so it looks human.
  const autoReadyBots = options.autoReadyBots !== false;
  return {
    active: true,
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + REMATCH_READY_TIMEOUT_MS).toISOString(),
    participantIds,
    previousRoundPlayerIds: participantIds,
    readyPlayerIds: autoReadyBots ? participantIds.filter(isBotPlayerId) : [],
    removedPlayerIds: [],
    recruiting: false,
    countdownPaused: false,
    holdReason: null,
    targetPlayerCount: participantIds.length,
    proposedEntryFee: Number(options.entryFee || 0),
    feeVersion: 1,
    feeUpdatedAt: null,
    previousEntryFee: null,
  };
};

const normalizeRematchState = (rematch, currentPlayerIds = []) => {
  if (!rematch?.active) return null;
  const current = uniqueIds(currentPlayerIds);
  const currentSet = new Set(current);
  return {
    ...rematch,
    participantIds: current,
    previousRoundPlayerIds: uniqueIds(rematch.previousRoundPlayerIds || rematch.participantIds),
    readyPlayerIds: uniqueIds(rematch.readyPlayerIds)
      .filter((id) => currentSet.has(id)),
    removedPlayerIds: uniqueIds(rematch.removedPlayerIds),
    recruiting: Boolean(rematch.recruiting),
    countdownPaused: Boolean(rematch.countdownPaused),
    holdReason: rematch.holdReason || null,
    targetPlayerCount: Math.min(4, Math.max(current.length, Number(rematch.targetPlayerCount || current.length))),
    proposedEntryFee: Number(rematch.proposedEntryFee || 0),
    feeVersion: Math.max(1, Number(rematch.feeVersion || 1)),
    feeUpdatedAt: rematch.feeUpdatedAt || null,
    previousEntryFee: rematch.previousEntryFee == null
      ? null
      : Number(rematch.previousEntryFee),
  };
};

const getRematchStatus = (rematch, currentPlayerIds, now = Date.now()) => {
  const normalized = normalizeRematchState(rematch, currentPlayerIds);
  if (!normalized) return null;
  const readySet = new Set(normalized.readyPlayerIds);
  const readyPlayerIds = normalized.participantIds.filter((id) => readySet.has(id));
  const waitingPlayerIds = normalized.participantIds.filter((id) => !readySet.has(id));
  const deadline = new Date(normalized.deadlineAt).getTime();
  return {
    rematch: normalized,
    readyPlayerIds,
    waitingPlayerIds,
    expired: !normalized.countdownPaused && Number.isFinite(deadline) && now >= deadline,
    allReady: waitingPlayerIds.length === 0,
  };
};

const restartRematchCountdown = (rematch, now = Date.now()) => ({
  ...rematch,
  countdownPaused: false,
  recruiting: false,
  holdReason: null,
  startedAt: new Date(now).toISOString(),
  deadlineAt: new Date(now + REMATCH_READY_TIMEOUT_MS).toISOString(),
});

const getRematchOutcome = (status, { forceDeadline = false } = {}) => {
  if (!status) return "inactive";

  // Everyone currently in the room is ready (including creator) → start immediately.
  // Works even if the countdown was held/paused by the creator.
  // Recruitment pause still waits for a new player (seat open).
  if (
    status.allReady &&
    status.readyPlayerIds.length >= 2 &&
    !status.rematch.recruiting
  ) {
    return "start";
  }

  if (status.rematch.countdownPaused) return "paused";
  if ((forceDeadline || status.expired) && (!status.allReady || status.readyPlayerIds.length < 2)) {
    return "return-to-lobby";
  }
  if (!status.allReady || status.readyPlayerIds.length < 2) return "waiting";
  return "start";
};

module.exports = {
  REMATCH_READY_TIMEOUT_MS,
  createRematchState,
  getRematchStatus,
  getRematchOutcome,
  isBotPlayerId,
  normalizeRematchState,
  restartRematchCountdown,
};
