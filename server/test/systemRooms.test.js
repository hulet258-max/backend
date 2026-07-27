const test = require("node:test");
const assert = require("node:assert/strict");

const { SYSTEM_ROOM_NAMES } = require("../src/config/systemRoomNames");

test("system room names preserve the supplied values and duplicates", () => {
  assert.equal(SYSTEM_ROOM_NAMES[0], "Addis_King");
  assert.equal(SYSTEM_ROOM_NAMES.at(-1), "ካሽሽ");
  assert.equal(SYSTEM_ROOM_NAMES.filter((name) => name === "FriendsOnlyyy").length, 2);
  assert.equal(SYSTEM_ROOM_NAMES.includes("Yene❤️Karta"), true);
  assert.equal(SYSTEM_ROOM_NAMES.includes("Bunna☕EnaKarta"), true);
});

const postgresPath = require.resolve("../src/config/postgres");
const clientCalls = [];
const directCalls = [];
let usedNames = [];

const client = {
  async query(sql, params) {
    const text = String(sql);
    clientCalls.push({ sql: text, params });
    if (text.includes("SELECT name FROM rooms")) {
      return { rows: usedNames.map((name) => ({ name })) };
    }
    if (text.includes("INSERT INTO rooms")) {
      return {
        rows: [{
          id: params[0], name: params[1], type: params[2], entry_fee: params[3], stake: params[4],
          creator_id: params[5], visibility: params[6], players: params[7], player_count: params[8],
          max_players: params[9], status: params[10], room_stats: JSON.parse(params[11]),
        }],
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
      return { rows: [] };
    },
  },
};

const {
  createSystemRoomWithAvailableName,
  listLobbyRooms,
  listPublicRooms,
} = require("../src/db/store");

const room = {
  type: "2-players", entryFee: 10, stake: 10, creatorId: "botgamer:1",
  visibility: "public", players: ["botgamer:1"], playerCount: 1, maxPlayers: 2,
  status: "waiting", roomStats: { managedBotRoom: true },
};

test.beforeEach(() => {
  clientCalls.length = 0;
  directCalls.length = 0;
  usedNames = [];
});

test("occupied values exclude every matching duplicate candidate", async () => {
  usedNames = ["FriendsOnlyyy"];
  const created = await createSystemRoomWithAvailableName(room, ["FriendsOnlyyy", "Open", "FriendsOnlyyy"]);
  assert.equal(created.name, "Open");
  assert.equal(clientCalls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")), true);
  assert.equal(clientCalls.at(-1).sql, "COMMIT");
});

test("name exhaustion rolls back without inserting a room", async () => {
  usedNames = ["OnlyName"];
  const created = await createSystemRoomWithAvailableName(room, ["OnlyName"]);
  assert.equal(created, null);
  assert.equal(clientCalls.some(({ sql }) => sql.includes("INSERT INTO rooms")), false);
  assert.equal(clientCalls.at(-1).sql, "ROLLBACK");
});

test("public lobby query hides every full room", async () => {
  await listPublicRooms();
  assert.match(directCalls[0].sql, /player_count < max_players/);
});

test("personalized lobby hides other full rooms but retains the user's own room", async () => {
  await listLobbyRooms("user-1");
  const sql = directCalls[0].sql;
  assert.match(sql, /visibility = 'public'[\s\S]*player_count < max_players/);
  assert.match(sql, /OR \([\s\S]*players @> ARRAY\[\$1::text\]/);
});
