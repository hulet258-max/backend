const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRoomUpdatePayload,
  sanitizeGameResult,
  sanitizeRedisData,
  sanitizeRedisDataForPlayer,
  sanitizeRoom,
  sanitizeSettlement,
} = require("../src/services/playerPayload");

function assertNoCommissionFields(value) {
  const json = JSON.stringify(value);
  assert.equal(json.includes("commissionAmount"), false);
  assert.equal(json.includes("commissionRate"), false);
  assert.equal(json.includes("roundCommission"), false);
}

test("player room payloads hide house-bot control fields", () => {
  const redisData = {
    botDifficulty: { strength: 1, targetBotWinRate: 0.8 },
    housePressure: "take",
    houseControl: { pressure: "take", targetWinRate: 0.7 },
    targetBotWinRate: 0.7,
    minPicksBeforeWin: 5,
    turnToken: "1:user:timestamp",
    turnGeneration: 1,
    managedBonusIntroStage: 2,
    managedLeaveThisRound: true,
    managedLeaveAfterBotTurns: 2,
    managedLeaveReplacementFee: 20,
    cardFlowPlan: { structuralDistance: 2, scheduledWinner: "bot" },
    openingPairTarget: 2,
    openingPairCalibration: { pairRanks: ["A", "K"] },
    jokerAssistedRound: true,
    jokerAssistCount: 2,
    managedRoundContext: { revision: 9, ledgerTotalGames: 20 },
    managedRoundContextRevision: 9,
    roomStats: {
      entryFee: 10,
      housePressure: "take",
      houseControl: { pressure: "take" },
      botDifficulty: { strength: 1 },
      targetBotWinRate: 0.7,
    },
  };
  const clean = sanitizeRedisData(redisData);
  assert.equal(clean.housePressure, undefined);
  assert.equal(clean.houseControl, undefined);
  assert.equal(clean.botDifficulty, undefined);
  assert.equal(clean.targetBotWinRate, undefined);
  assert.equal(clean.minPicksBeforeWin, undefined);
  assert.equal(clean.turnToken, undefined);
  assert.equal(clean.turnGeneration, undefined);
  assert.equal(clean.managedBonusIntroStage, undefined);
  assert.equal(clean.managedLeaveThisRound, undefined);
  assert.equal(clean.cardFlowPlan, undefined);
  assert.equal(clean.openingPairTarget, undefined);
  assert.equal(clean.openingPairCalibration, undefined);
  assert.equal(clean.jokerAssistedRound, undefined);
  assert.equal(clean.jokerAssistCount, undefined);
  assert.equal(clean.managedRoundContext, undefined);
  assert.equal(clean.managedRoundContextRevision, undefined);
  assert.equal(clean.roomStats.housePressure, undefined);
  assert.equal(clean.roomStats.botDifficulty, undefined);
  assert.equal(clean.roomStats.entryFee, 10);
});

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

test("new rematch recruits cannot see the previous round result or cards", () => {
  const redisData = {
    status: "ended",
    rematch: {
      active: true,
      previousRoundPlayerIds: ["u1", "u2"],
    },
    gameResult: { winnerId: "u1", revealedHands: { u1: [{ rank: "A" }] } },
    playerCards: { u1: [{ rank: "A" }], u2: [{ rank: "K" }] },
    deck: [{ rank: "Q" }],
    laidCards: [{ rank: "J" }],
  };

  assert.equal(sanitizeRedisDataForPlayer(redisData, "u1").gameResult.winnerId, "u1");
  const recruitPayload = sanitizeRedisDataForPlayer(redisData, "u3");
  assert.equal(recruitPayload.gameResult, null);
  assert.deepEqual(recruitPayload.playerCards, {});
  assert.deepEqual(recruitPayload.deck, []);
  assert.equal(recruitPayload.previousRoundSpectator, true);
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
