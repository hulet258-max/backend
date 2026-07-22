const MANAGED_ROOM_MAX_COMPLETED_ROUNDS = 6;

const getCompletedRounds = (roomState = {}) => Math.max(
  0,
  Math.floor(Number(roomState?.roomStats?.gamesPlayed || 0))
);

const isManagedRoom = (roomState = {}) => Boolean(
  roomState?.managedBotRoom || roomState?.roomStats?.managedBotRoom
);

const isManagedFirstRound = (roomState = {}) => (
  isManagedRoom(roomState) && getCompletedRounds(roomState) === 0
);

const requiresManagedRoomRotation = (roomState = {}) => (
  isManagedRoom(roomState)
  && getCompletedRounds(roomState) >= MANAGED_ROOM_MAX_COMPLETED_ROUNDS
);

const hasValidPlayingState = (roomState = {}) => Boolean(
  roomState?.status === "playing"
  && roomState?.turn
  && roomState?.playerCards
  && typeof roomState.playerCards === "object"
  && !Array.isArray(roomState.playerCards)
  && Array.isArray(roomState.deck)
  && Array.isArray(roomState.laidCards)
);

const needsManagedRoomEmergencyCleanup = (roomState = {}) => Boolean(
  isManagedRoom(roomState)
  && roomState?.status === "playing"
  && (requiresManagedRoomRotation(roomState) || !hasValidPlayingState(roomState))
);

module.exports = {
  MANAGED_ROOM_MAX_COMPLETED_ROUNDS,
  getCompletedRounds,
  hasValidPlayingState,
  isManagedFirstRound,
  isManagedRoom,
  needsManagedRoomEmergencyCleanup,
  requiresManagedRoomRotation,
};
