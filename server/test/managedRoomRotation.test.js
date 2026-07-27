const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getManagedRoomOwnerId,
  hasLiveSocket,
  rotateManagedRoom,
  shouldWarnForMissingSocket,
} = require("../src/services/managedRoomRotation");

const managedRoomState = (overrides = {}) => ({
  status: "ended",
  generatedFor: "human-1",
  managedBotRoom: true,
  players: [
    { telegramId: "botgamer:managed:bot-1", socketId: null, bot: true },
    { telegramId: "human-1", socketId: "socket-1", bot: false },
  ],
  roomStats: {
    gamesPlayed: 6,
    managedBotRoom: true,
    generatedFor: "human-1",
  },
  ...overrides,
});

const buildDependencies = ({ connected = true } = {}) => {
  const calls = {
    deletedKeys: [],
    emitted: [],
    finalized: [],
    deletedRooms: [],
    replacements: [],
  };
  const socketMap = new Map(connected ? [["socket-1", { id: "socket-1" }]] : []);
  const io = {
    sockets: { sockets: socketMap },
    emit: (event, payload) => calls.emitted.push({ event, payload }),
  };
  const redis = {
    del: async (key) => {
      calls.deletedKeys.push(key);
      return 1;
    },
    get: async (key) => key === "user:human-1:socket" ? "socket-1" : null,
  };
  const finalizeRoomLedger = async (roomId, reason) => {
    calls.finalized.push({ roomId, reason });
  };
  const deleteRoom = async (roomId, reason) => {
    calls.deletedRooms.push({ roomId, reason });
  };
  const ensureManagedBotRoomForUser = async (_io, userId, options) => {
    calls.replacements.push({ userId, options });
    return { id: "replacement-1" };
  };
  return {
    calls,
    deleteRoom,
    ensureManagedBotRoomForUser,
    finalizeRoomLedger,
    io,
    redis,
  };
};

test("managed room owner prefers the requested human, then generatedFor", () => {
  const state = managedRoomState();
  assert.equal(getManagedRoomOwnerId(state, "human-2"), "human-2");
  assert.equal(getManagedRoomOwnerId(state), "human-1");
  assert.equal(getManagedRoomOwnerId({
    players: [{ telegramId: "human-3" }],
  }), "human-3");
});

test("missing socket warnings ignore managed bots but retain human warnings", () => {
  assert.equal(shouldWarnForMissingSocket("botgamer:managed:bot-1"), false);
  assert.equal(shouldWarnForMissingSocket("human-1"), true);
});

test("live socket detection requires the socket to exist in Socket.IO", () => {
  const io = { sockets: { sockets: new Map([["socket-1", {}]]) } };
  assert.equal(hasLiveSocket(io, "socket-1"), true);
  assert.equal(hasLiveSocket(io, "stale-socket"), false);
  assert.equal(hasLiveSocket(null, "socket-1"), false);
});

test("expired managed room is finalized, deleted, and replaced for a connected owner", async () => {
  const dependencies = buildDependencies({ connected: true });
  const result = await rotateManagedRoom({
    ...dependencies,
    roomId: "room-1",
    roomState: managedRoomState(),
    replacementPolicy: "if-connected",
  });

  assert.deepEqual(dependencies.calls.finalized, [{
    roomId: "room-1",
    reason: "managed-room-round-cap",
  }]);
  assert.deepEqual(dependencies.calls.deletedRooms, [{
    roomId: "room-1",
    reason: "managed-room-round-cap",
  }]);
  assert.equal(dependencies.calls.deletedKeys.includes("room:room-1"), true);
  assert.equal(
    dependencies.calls.deletedKeys.includes("room:room-1:turn-action-lock"),
    true
  );
  assert.equal(
    dependencies.calls.deletedKeys.includes("managed-bot-room:human-1"),
    true
  );
  assert.deepEqual(dependencies.calls.replacements, [{
    userId: "human-1",
    options: { forceManaged: true },
  }]);
  assert.equal(result.replacementRoom.id, "replacement-1");
  assert.deepEqual(
    dependencies.calls.emitted.map(({ event }) => event),
    ["room_unavailable", "room_deleted"]
  );
});

test("expired managed room is deleted without replacement for a disconnected owner", async () => {
  const dependencies = buildDependencies({ connected: false });
  const result = await rotateManagedRoom({
    ...dependencies,
    roomId: "room-2",
    roomState: managedRoomState(),
    replacementPolicy: "if-connected",
  });

  assert.equal(dependencies.calls.finalized.length, 1);
  assert.equal(dependencies.calls.deletedRooms.length, 1);
  assert.deepEqual(dependencies.calls.replacements, []);
  assert.equal(result.replacementRoom, null);
});

test("player-triggered rotation creates a replacement without a socket lookup requirement", async () => {
  const dependencies = buildDependencies({ connected: false });
  const result = await rotateManagedRoom({
    ...dependencies,
    roomId: "room-3",
    roomState: managedRoomState(),
    requestedUserId: "human-1",
    replacementPolicy: "always",
  });

  assert.equal(dependencies.calls.replacements.length, 1);
  assert.equal(result.replacementRoom.id, "replacement-1");
});
