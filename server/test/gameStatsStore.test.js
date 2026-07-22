const test = require("node:test");
const assert = require("node:assert/strict");

const postgresPath = require.resolve("../src/config/postgres");
const calls = [];
const directCalls = [];
const roomRow = {
  id: "room-1",
  name: "Bot room",
  type: "2-players",
  entry_fee: 10,
  stake: 10,
  creator_id: "botgamer:managed:1",
  visibility: "public",
  players: ["botgamer:managed:1", "human-1"],
  player_count: 2,
  max_players: 2,
  status: "playing",
  room_stats: {
    gamesPlayed: 0,
    winnerCounts: {},
    winnerWeights: {},
    games: [],
    feeEscrowed: true,
    escrowSettled: false,
    currentRoundPlayers: ["botgamer:managed:1", "human-1"],
    currentRoundPot: 20,
    entryFee: 10,
    botGame: true,
  },
};

const client = {
  async query(sql, params) {
    const statement = String(sql);
    calls.push({ sql: statement, params });
    if (statement.includes("SELECT * FROM rooms")) return { rows: [roomRow], rowCount: 1 };
    if (statement.includes("UPDATE users SET balance")) return { rows: [{ balance: 19 }], rowCount: 1 };
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
      if (String(sql).includes("RETURNING managed_bonus_intro_started")) {
        return {
          rows: [{ managed_bonus_intro_started: true, managed_bonus_intro_games: 0 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  },
};

const { latchManagedBonusIntro, recordRoomGameResult } = require("../src/db/store");

test.beforeEach(() => {
  calls.length = 0;
  directCalls.length = 0;
});

test("bonus introduction latches only through the durable game-stats write", async () => {
  const state = await latchManagedBonusIntro("human-1", 10);
  assert.deepEqual(state, { started: true, games: 0, active: true });
  const write = directCalls.find(({ sql }) => sql.includes("managed_bonus_intro_started"));
  assert.ok(write);
  assert.deepEqual(write.params, ["human-1", true]);
  assert.match(write.sql, /user_game_stats\.games_played = 0/);
});

test("paid settlement increments games for all players and wins only for the human winner", async () => {
  await recordRoomGameResult(
    "room-1",
    "human-1",
    ["botgamer:managed:1", "human-1"]
  );

  const statsWrite = calls.find(({ sql }) => sql.includes("INSERT INTO user_game_stats"));
  assert.ok(statsWrite);
  assert.match(statsWrite.sql, /games_played, wins/);
  assert.match(statsWrite.sql, /id = \$2 AND id NOT LIKE 'botgamer:%'/);
  assert.match(statsWrite.sql, /wins = user_game_stats\.wins \+ EXCLUDED\.wins/);
  assert.deepEqual(statsWrite.params, [
    ["botgamer:managed:1", "human-1"],
    "human-1",
  ]);
  const activityWrite = calls.find(({ sql }) => sql.includes("INSERT INTO user_game_activity_days"));
  assert.ok(activityWrite);
  assert.match(activityWrite.sql, /Africa\/Addis_Ababa/);
  assert.match(activityWrite.sql, /id NOT LIKE 'botgamer:%'/);
  assert.deepEqual(activityWrite.params, [["botgamer:managed:1", "human-1"]]);
});

test("completed managed bonus introductions advance inside settlement", async () => {
  await recordRoomGameResult(
    "room-1",
    "human-1",
    ["botgamer:managed:1", "human-1"],
    { managedBonusIntroPlayerId: "human-1" }
  );

  const introWrite = calls.find(({ sql }) => sql.includes("managed_bonus_intro_games = LEAST"));
  assert.ok(introWrite);
  assert.deepEqual(introWrite.params, ["human-1"]);
});
