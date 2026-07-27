const test = require("node:test");
const assert = require("node:assert/strict");

const postgresPath = require.resolve("../src/config/postgres");
const clientCalls = [];
const directCalls = [];

const managedRoom = {
  id: "managed-room-1",
  name: "Managed room",
  type: "2-players",
  entry_fee: 10,
  stake: 10,
  creator_id: "botgamer:managed:creator",
  visibility: "public",
  created_at: new Date("2026-07-17T00:00:00.000Z"),
  players: ["botgamer:managed:creator", "human-1"],
  player_count: 2,
  max_players: 2,
  status: "ended",
  room_stats: {
    managedBotRoom: true,
    botProfile: { id: "botgamer:managed:creator" },
    gamesPlayed: 1,
    games: [{ winnerId: "human-1" }],
  },
};

const client = {
  async query(sql, params) {
    const statement = String(sql);
    clientCalls.push({ sql: statement, params });
    if (statement.includes("SELECT * FROM rooms")) {
      return { rows: [managedRoom], rowCount: 1 };
    }
    if (statement.includes("UPDATE rooms") && statement.includes("visibility = 'private'")) {
      return {
        rows: [{
          ...managedRoom,
          creator_id: "human-1",
          visibility: "private",
          players: ["human-1"],
          player_count: 1,
          status: "waiting",
          room_stats: JSON.parse(params[2]),
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  },
  release() {},
};

require.cache[postgresPath] = {
  id: postgresPath,
  filename: postgresPath,
  loaded: true,
  exports: {
    pool: { connect: async () => client },
    query: async (sql, params) => {
      directCalls.push({ sql: String(sql), params });
      return { rows: [managedRoom], rowCount: 1 };
    },
  },
};

const {
  deleteRoom,
  transitionManagedBotRoomToWaiting,
  updateRoomRematchConfig,
} = require("../src/db/store");
const {
  getManagedBalanceBandFee,
  selectManagedRoomEntryFee,
} = require("../src/routes/botgamer");

test.beforeEach(() => {
  clientCalls.length = 0;
  directCalls.length = 0;
});

test("managed rematch configuration keeps the bot creator and disables recruitment", async () => {
  await updateRoomRematchConfig(managedRoom.id, {
    creatorId: "human-1",
    maxPlayers: 4,
    rematchRecruiting: true,
  });

  assert.equal(directCalls.length, 1);
  assert.match(directCalls[0].sql, /managedBotRoom[\s\S]*THEN 2/);
  assert.match(directCalls[0].sql, /botProfile[\s\S]*creator_id/);
  assert.match(directCalls[0].sql, /managedBotRoom[\s\S]*THEN false/);
});

test("managed bot remains creator until the room is deleted", async () => {
  await deleteRoom(managedRoom.id, "managed-room-finished");

  assert.equal(
    clientCalls.some(({ sql }) => sql.includes("UPDATE rooms SET creator_id")),
    false
  );

  const roomDeleteIndex = clientCalls.findIndex(({ sql }) => (
    sql === "DELETE FROM rooms WHERE id = $1"
  ));
  const botDeleteIndex = clientCalls.findIndex(({ sql }) => (
    sql.includes("DELETE FROM users WHERE telegram_id = $1")
  ));

  assert.ok(roomDeleteIndex >= 0);
  assert.ok(botDeleteIndex > roomDeleteIndex);
  assert.deepEqual(clientCalls[botDeleteIndex].params, ["botgamer:managed:creator"]);
});

test("departed managed bot room transfers to a private human waiting room", async () => {
  const room = await transitionManagedBotRoomToWaiting({
    roomId: managedRoom.id,
    humanId: "human-1",
    botId: "botgamer:managed:creator",
    roomStats: managedRoom.room_stats,
    replacementFee: 25,
  });

  assert.equal(room.creatorId, "human-1");
  assert.equal(room.visibility, "private");
  assert.equal(room.status, "waiting");
  assert.deepEqual(room.players, ["human-1"]);
  assert.equal(room.roomStats.managedBotDeparted, true);
  assert.equal(room.roomStats.managedReplacementFee, 25);
  assert.ok(clientCalls.some(({ sql }) => sql.includes("DELETE FROM users")));
});

test("managed room fees follow high-balance bands and replacement minimums", () => {
  assert.equal(getManagedBalanceBandFee(100), null);
  assert.equal(getManagedBalanceBandFee(101), 20);
  assert.equal(getManagedBalanceBandFee(199), 20);
  assert.equal(getManagedBalanceBandFee(200), 25);
  assert.equal(getManagedBalanceBandFee(499), 25);
  assert.equal(getManagedBalanceBandFee(500), 50);
  assert.equal(getManagedBalanceBandFee(999), 50);
  assert.equal(getManagedBalanceBandFee(1000), 100);
  assert.equal(selectManagedRoomEntryFee(100, { random: () => 0 }), 10);
  assert.equal(selectManagedRoomEntryFee(300), 25);
  assert.equal(selectManagedRoomEntryFee(300, { minimumFee: 50 }), 50);
});
