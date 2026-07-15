const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRoomUpdatePayload,
  sanitizeGameResult,
  sanitizeRedisData,
  sanitizeRoom,
  sanitizeSettlement,
} = require("../src/services/playerPayload");

function assertNoCommissionFields(value) {
  const json = JSON.stringify(value);
  assert.equal(json.includes("commissionAmount"), false);
  assert.equal(json.includes("commissionRate"), false);
  assert.equal(json.includes("roundCommission"), false);
}

test("player room payloads hide commission fields while preserving money state", () => {
  const room = {
    id: "room-1",
    players: ["u1", "u2"],
    roomStats: {
      entryFee: 2,
      currentRoundPot: 4,
      totalPot: 4,
      commissionAmount: 0.05,
      commissionRate: 0.0125,
      payouts: { u1: 3.95 },
      refunds: {},
      games: [
        {
          winnerId: "u1",
          roundAmountToWin: 4,
          roundPayout: 3.95,
          roundCommission: 0.05,
          commissionRate: 0.0125,
        },
      ],
      lastSettlement: {
        winnerId: "u1",
        winnerPayout: 3.95,
        commissionAmount: 0.05,
        commissionRate: 0.0125,
      },
    },
  };
  const redisData = {
    roomStats: room.roomStats,
    gameResult: {
      winnerId: "u1",
      roundPot: 4,
      roundPayout: 3.95,
      roundCommission: 0.05,
    },
  };

  const payload = buildRoomUpdatePayload(room, redisData);
  assertNoCommissionFields(payload);
  assert.equal(payload.room.roomStats.payouts.u1, 3.95);
  assert.equal(payload.redisData.gameResult.roundPayout, 3.95);
});

test("sanitizers hide commission fields from all player-facing shapes", () => {
  assertNoCommissionFields(sanitizeRoom({
    roomStats: { commissionAmount: 1, commissionRate: 0.1, totalPot: 10 },
  }));
  assertNoCommissionFields(sanitizeRedisData({
    roomStats: { commissionAmount: 1, commissionRate: 0.1 },
    gameResult: { roundCommission: 1, roundPayout: 9 },
  }));
  assertNoCommissionFields(sanitizeGameResult({ roundCommission: 1, roundPayout: 9 }));
  assertNoCommissionFields(sanitizeSettlement({ commissionAmount: 1, winnerPayout: 9 }));
});

test("completed game payloads preserve revealed final hands", () => {
  const result = sanitizeGameResult({
    winnerId: "u1",
    revealedHands: {
      u1: [{ rank: "A", suit: "spades", color: "#111" }],
      u2: [{ rank: "K", suit: "hearts", color: "#e74c3c" }],
    },
  });

  assert.deepEqual(result.revealedHands.u1, [{ rank: "A", suit: "spades", color: "#111" }]);
  assert.deepEqual(result.revealedHands.u2, [{ rank: "K", suit: "hearts", color: "#e74c3c" }]);
});
