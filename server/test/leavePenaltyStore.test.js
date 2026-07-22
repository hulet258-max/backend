const test = require("node:test");
const assert = require("node:assert/strict");

const postgresPath = require.resolve("../src/config/postgres");
const calls = [];
let roomRow;

const resetRoom = ({ entryFee = 10, bonusEscrow = { leaving: 4, remaining: 3 } } = {}) => {
  roomRow = {
    id: "room-penalty",
    name: "Penalty room",
    type: "2-players",
    entry_fee: entryFee,
    stake: entryFee,
    creator_id: "leaving",
    visibility: "public",
    players: ["leaving", "remaining"],
    player_count: 2,
    max_players: 2,
    status: "playing",
    room_stats: {
      gamesPlayed: 12,
      winnerCounts: {},
      games: [],
      feeEscrowed: true,
      escrowRefunded: false,
      escrowSettled: false,
      currentRoundPlayers: ["leaving", "remaining"],
      currentRoundBonusEscrow: bonusEscrow,
      currentRoundPot: entryFee * 2,
      entryFee,
      refunds: {},
      bonusRefunds: {},
    },
  };
};

const client = {
  async query(sql, params) {
    const statement = String(sql);
    calls.push({ sql: statement, params });
    if (statement.includes("SELECT * FROM rooms")) {
      return { rows: [JSON.parse(JSON.stringify(roomRow))], rowCount: 1 };
    }
    if (statement.includes("UPDATE rooms SET room_stats")) {
      roomRow.room_stats = JSON.parse(params[1]);
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
    query: async () => ({ rows: [], rowCount: 0 }),
  },
};

const { finalizeRoomLedger } = require("../src/db/store");

test.beforeEach(() => {
  calls.length = 0;
  resetRoom();
});

const refundCalls = () => calls.filter(({ sql }) => (
  sql.includes("SET balance = balance + $2")
));

test("confirmed active-round leave refunds half to the leaver and all to remaining players", async () => {
  const stats = await finalizeRoomLedger("room-penalty", "active-round-abandoned", {
    leavePenaltyPlayerId: "leaving",
    leavePenaltyRate: 0.5,
  });

  assert.deepEqual(refundCalls().map(({ params }) => params), [
    ["leaving", 5, 2],
    ["remaining", 10, 3],
  ]);
  assert.equal(stats.gamesPlayed, 12);
  assert.equal(stats.refunds.leaving, 5);
  assert.equal(stats.refunds.remaining, 10);
  assert.equal(stats.leavePenaltyAmount, 5);
  assert.deepEqual(stats.lastLeavePenalty, {
    playerId: "leaving",
    entryFee: 10,
    rate: 0.5,
    amount: 5,
    reason: "active-round-abandoned",
    appliedAt: stats.finalizedAt,
  });
});

test("half-entry penalty preserves fractional Birr", async () => {
  resetRoom({ entryFee: 15, bonusEscrow: {} });
  const stats = await finalizeRoomLedger("room-penalty", "active-round-abandoned", {
    leavePenaltyPlayerId: "leaving",
    leavePenaltyRate: 0.5,
  });

  assert.equal(stats.refunds.leaving, 7.5);
  assert.equal(stats.refunds.remaining, 15);
  assert.equal(stats.leavePenaltyAmount, 7.5);
});

test("repeated finalization cannot charge the leave penalty twice", async () => {
  const options = { leavePenaltyPlayerId: "leaving", leavePenaltyRate: 0.5 };
  await finalizeRoomLedger("room-penalty", "active-round-abandoned", options);
  const refundCountAfterFirstCall = refundCalls().length;
  const stats = await finalizeRoomLedger("room-penalty", "active-round-abandoned", options);

  assert.equal(refundCalls().length, refundCountAfterFirstCall);
  assert.equal(stats.leavePenaltyAmount, 5);
  assert.equal(stats.leavePenalties.length, 1);
});

test("ordinary cleanup still refunds every player in full", async () => {
  const stats = await finalizeRoomLedger("room-penalty", "room-finalized");

  assert.equal(stats.refunds.leaving, 10);
  assert.equal(stats.refunds.remaining, 10);
  assert.equal(stats.leavePenaltyAmount, 0);
  assert.equal(stats.lastLeavePenalty, null);
});

test("opponent timeout refunds the leaver fully and penalizes the inactive player", async () => {
  const stats = await finalizeRoomLedger("room-penalty", "active-round-abandoned", {
    leavePenaltyPlayerId: "remaining",
    leavePenaltyRate: 0.5,
    leavePenaltyReason: "opponent-turn-timeout",
  });

  assert.equal(stats.refunds.leaving, 10);
  assert.equal(stats.refunds.remaining, 5);
  assert.equal(stats.lastLeavePenalty.playerId, "remaining");
  assert.equal(stats.lastLeavePenalty.reason, "opponent-turn-timeout");
});
