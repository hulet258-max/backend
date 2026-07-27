const MANAGED_ROOM_ROTATION_REASON = "managed-room-round-cap";

const getManagedRoomOwnerId = (roomState = {}, requestedUserId = null) => {
  const requested = String(requestedUserId || "").trim();
  if (requested && !requested.startsWith("botgamer:")) return requested;

  const generatedFor = String(
    roomState.generatedFor || roomState.roomStats?.generatedFor || ""
  ).trim();
  if (generatedFor && !generatedFor.startsWith("botgamer:")) return generatedFor;

  const human = (roomState.players || []).find(
    (player) => !String(player?.telegramId || "").startsWith("botgamer:")
  );
  return human ? String(human.telegramId) : "";
};

const hasLiveSocket = (io, socketId) => Boolean(
  socketId && io?.sockets?.sockets?.has(String(socketId))
);

const shouldWarnForMissingSocket = (playerId) => (
  !String(playerId || "").startsWith("botgamer:")
);

const rotateManagedRoom = async ({
  io,
  redis,
  roomId,
  roomState,
  requestedUserId = null,
  replacementPolicy = "always",
  finalizeRoomLedger,
  deleteRoom,
  ensureManagedBotRoomForUser,
}) => {
  const cleanRoomId = String(roomId);
  const ownerId = getManagedRoomOwnerId(roomState, requestedUserId);

  if (!roomState?.practice) {
    await finalizeRoomLedger(cleanRoomId, MANAGED_ROOM_ROTATION_REASON);
  }
  await deleteRoom(cleanRoomId, MANAGED_ROOM_ROTATION_REASON);

  const redisKeys = [
    `room:${cleanRoomId}`,
    `room:${cleanRoomId}:bot-lock`,
    `room:${cleanRoomId}:bot-start-lock`,
    `room:${cleanRoomId}:turn-action-lock`,
    `room:${cleanRoomId}:declare-win-lock`,
    "rooms:list",
  ];
  if (ownerId) redisKeys.push(`managed-bot-room:${ownerId}`);
  await Promise.all(redisKeys.map((key) => redis.del(key)));

  io?.emit("room_unavailable", {
    roomId: cleanRoomId,
    reason: MANAGED_ROOM_ROTATION_REASON,
  });
  io?.emit("room_deleted", {
    roomId: cleanRoomId,
    reason: MANAGED_ROOM_ROTATION_REASON,
  });

  let shouldCreateReplacement = Boolean(ownerId);
  if (shouldCreateReplacement && replacementPolicy === "if-connected") {
    const socketId = await redis.get(`user:${ownerId}:socket`);
    shouldCreateReplacement = hasLiveSocket(io, socketId);
  }

  const replacementRoom = shouldCreateReplacement
    ? await ensureManagedBotRoomForUser(io, ownerId, { forceManaged: true })
    : null;

  console.info("[managed-room] rotated", {
    event: "managed_room_rotated",
    roomId: cleanRoomId,
    userId: ownerId || null,
    completedRounds: Number(roomState?.roomStats?.gamesPlayed || 0),
    replacementRoomId: replacementRoom?.id || null,
    replacementPolicy,
  });

  return {
    deleted: true,
    ownerId: ownerId || null,
    replacementRoom,
    rotationRequired: true,
  };
};

module.exports = {
  MANAGED_ROOM_ROTATION_REASON,
  getManagedRoomOwnerId,
  hasLiveSocket,
  rotateManagedRoom,
  shouldWarnForMissingSocket,
};
