const test = require("node:test");
const assert = require("node:assert/strict");

const { testUtils } = require("../src/routes/admin");

test("admin deposit total aggregates the complete transaction table", async () => {
  let statement = "";
  const total = await testUtils.getDepositTotal(async (sql) => {
    statement = sql;
    return { rows: [{ total: "501.25" }] };
  });

  assert.match(statement, /SUM\(amount\)/i);
  assert.doesNotMatch(statement, /LIMIT/i);
  assert.equal(total, 501.25);
});

test("admin user contract converts database values to UI-safe values", () => {
  const user = testUtils.mapUser({
    telegram_id: 123,
    balance: "10",
    deposit_sum: "20.5",
    games_played: "3",
    amount_played: "30",
    share_count: null,
    reward_count: "2",
    max_rewards: "5",
  });

  assert.equal(user.telegramId, "123");
  assert.equal(user.balance, 10);
  assert.equal(user.depositSum, 20.5);
  assert.equal(user.gamesPlayed, 3);
  assert.equal(user.shareCount, 0);
  assert.equal(user.displayName, "User");
});

test("admin room and game contracts tolerate missing nested data", () => {
  const room = testUtils.mapRoom({
    id: "room-1",
    entry_fee: "10",
    stake: null,
    players: null,
    player_count: null,
    max_players: "4",
    room_stats: null,
    is_archived: false,
  });

  assert.deepEqual(room.players, []);
  assert.equal(room.entryFee, 10);
  assert.equal(room.roomStats.gamesPlayed, 0);
  assert.deepEqual(testUtils.flattenGames([room]), []);
  assert.equal(testUtils.summarizeRooms([room]).totalRooms, 1);
});

test("admin content contracts normalize optional fields", () => {
  assert.deepEqual(testUtils.mapPoster({ id: "1", is_active: null }), {
    id: 1,
    imageUrl: undefined,
    title: "",
    isActive: false,
    sortOrder: 0,
    createdAt: undefined,
    updatedAt: undefined,
  });
  assert.equal(testUtils.mapDepositNumber({ id: "2" }).phoneNumber, undefined);
  assert.equal(testUtils.mapAdminMessage({ id: "3" }).targetMode, "filtered");
});
