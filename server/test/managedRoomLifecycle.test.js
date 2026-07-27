const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MANAGED_ROOM_MAX_COMPLETED_ROUNDS,
  isManagedFirstRound,
  needsManagedRoomEmergencyCleanup,
  requiresManagedRoomRotation,
} = require("../src/services/managedRoomLifecycle");
const {
  decideScriptedOutcome,
  generateGuaranteedWinSchedule,
  getGameBlockContext,
} = require("../src/services/houseBotController");

const managedState = (gamesPlayed, overrides = {}) => ({
  managedBotRoom: true,
  status: "playing",
  turn: "human",
  playerCards: { human: [], "botgamer:managed:test": [] },
  deck: [],
  laidCards: [],
  roomStats: { managedBotRoom: true, gamesPlayed },
  ...overrides,
});

test("protects only the first round from managed departure", () => {
  assert.equal(isManagedFirstRound(managedState(0)), true);
  assert.equal(isManagedFirstRound(managedState(1)), false);
});

test("requires rotation after six completed rounds", () => {
  assert.equal(MANAGED_ROOM_MAX_COMPLETED_ROUNDS, 6);
  assert.equal(requiresManagedRoomRotation(managedState(5)), false);
  assert.equal(requiresManagedRoomRotation(managedState(6)), true);
});

test("flags corrupt or over-cap playing rooms for emergency cleanup", () => {
  assert.equal(needsManagedRoomEmergencyCleanup(managedState(6)), true);
  assert.equal(needsManagedRoomEmergencyCleanup(managedState(2, { playerCards: null })), true);
  assert.equal(needsManagedRoomEmergencyCleanup(managedState(2)), false);
});

test("six-round room rotation does not reset the durable nine-of-twelve schedule", () => {
  const schedule = generateGuaranteedWinSchedule(() => 0.4);
  const outcomes = Array.from({ length: 12 }, (_, totalGames) => {
    const block = getGameBlockContext(totalGames);
    return decideScriptedOutcome({
      gamesPlayed: totalGames,
      totalGames,
      ...block,
      ...schedule,
    }).botWins;
  });

  assert.equal(outcomes.slice(0, 6).length, 6);
  assert.equal(outcomes.slice(6).length, 6);
  assert.equal(outcomes.filter(Boolean).length, 9);
  assert.equal(outcomes.filter((botWon) => !botWon).length, 3);
});
