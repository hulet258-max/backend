const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TURN_INACTIVITY_TIMEOUT_MS,
  getTimedOutOpponentTurn,
  getTurnActivityTimestamp,
  markTurnActivity,
} = require("../src/services/turnInactivity");

const NOW = Date.parse("2026-07-16T12:05:00.000Z");
const state = (overrides = {}) => ({
  status: "playing",
  gameEnded: false,
  paused: false,
  turn: "opponent",
  players: [{ telegramId: "waiting" }, { telegramId: "opponent" }],
  turnActivityAt: new Date(NOW - TURN_INACTIVITY_TIMEOUT_MS).toISOString(),
  ...overrides,
});

test("turn timeout starts exactly at five minutes", () => {
  const justBefore = state({
    turnActivityAt: new Date(NOW - TURN_INACTIVITY_TIMEOUT_MS + 1).toISOString(),
  });
  assert.equal(getTimedOutOpponentTurn(justBefore, "waiting", NOW), null);

  const timedOut = getTimedOutOpponentTurn(state(), "waiting", NOW);
  assert.equal(timedOut.inactivePlayerId, "opponent");
  assert.equal(timedOut.inactiveForMs, TURN_INACTIVITY_TIMEOUT_MS);
});

test("a player cannot use their own inactive turn for a free exit", () => {
  assert.equal(getTimedOutOpponentTurn(state(), "opponent", NOW), null);
});

test("timeout requires an active participant's current turn", () => {
  assert.equal(getTimedOutOpponentTurn(state({ status: "waiting" }), "waiting", NOW), null);
  assert.equal(getTimedOutOpponentTurn(state({ paused: true }), "waiting", NOW), null);
  assert.equal(getTimedOutOpponentTurn(state({ turn: "missing" }), "waiting", NOW), null);
});

test("valid progress marks turn activity with a server timestamp", () => {
  const gameState = { turn: "player-1" };
  const timestamp = markTurnActivity(gameState, NOW);
  assert.equal(timestamp, "2026-07-16T12:05:00.000Z");
  assert.equal(gameState.turnActivityAt, timestamp);
  assert.equal(gameState.turnGeneration, 1);
  assert.match(gameState.turnToken, /^1:player-1:/);
  const firstToken = gameState.turnToken;
  markTurnActivity(gameState, NOW + 1);
  assert.equal(gameState.turnGeneration, 2);
  assert.notEqual(gameState.turnToken, firstToken);
});

test("legacy rooms fall back to the lay that started the current turn", () => {
  const legacy = state({
    turnActivityAt: null,
    lastLay: {
      targetPlayerId: "opponent",
      at: "2026-07-16T12:00:00.000Z",
    },
    lastActivityAt: "2026-07-16T12:04:00.000Z",
  });
  assert.equal(getTurnActivityTimestamp(legacy), Date.parse("2026-07-16T12:00:00.000Z"));
  assert.equal(getTimedOutOpponentTurn(legacy, "waiting", NOW).inactivePlayerId, "opponent");
});
