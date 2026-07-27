const { requiresManagedRoomRotation } = require("./managedRoomLifecycle");

const getGameActionStateError = (redisData, userId) => {
  if (redisData.paused || redisData.leaveVote?.active) {
    return {
      status: 400,
      body: { error: "Game is paused. Waiting for players to continue." },
    };
  }

  if (redisData.status !== "playing") {
    return {
      status: 409,
      body: {
        error: "This round is no longer active. The game state has been refreshed.",
        code: "GAME_NOT_ACTIVE",
      },
    };
  }

  if (requiresManagedRoomRotation(redisData) || redisData.managedRotationRequired) {
    return {
      status: 409,
      body: {
        error: "This room completed its session. Continue in a new room.",
        code: "MANAGED_ROOM_ROTATION_REQUIRED",
      },
    };
  }

  const playerIsInRoom = (redisData.players || []).some(
    (player) => String(player.telegramId) === String(userId)
  );
  if (!playerIsInRoom) {
    return {
      status: 403,
      body: {
        error: "You are no longer a player in this room.",
        code: "PLAYER_NOT_IN_ROOM",
      },
    };
  }

  const userHand = redisData.playerCards?.[userId];
  if (
    !Array.isArray(userHand) ||
    !Array.isArray(redisData.deck) ||
    !Array.isArray(redisData.laidCards)
  ) {
    return {
      status: 409,
      body: {
        error: "The round is changing. The game state has been refreshed.",
        code: "GAME_STATE_NOT_READY",
      },
    };
  }

  return null;
};

module.exports = { getGameActionStateError };
