const test = require("node:test");
const assert = require("node:assert/strict");

const { getGameActionStateError } = require("../src/services/gameActionState");

const activeState = (overrides = {}) => ({
  status: "playing",
  paused: false,
  players: [
    { telegramId: "1163855756" },
    { telegramId: "botgamer:managed:test", bot: true },
  ],
  playerCards: {
    "1163855756": [],
    "botgamer:managed:test": [],
  },
  deck: [],
  laidCards: [],
  ...overrides,
});

test("accepts a complete active game state", () => {
  assert.equal(getGameActionStateError(activeState(), "1163855756"), null);
});

test("rejects a stale action after a managed bot room returns to waiting", () => {
  const result = getGameActionStateError(activeState({
    status: "waiting",
    playerCards: null,
    deck: null,
    managedBotDeparted: true,
  }), "1163855756");

  assert.equal(result.status, 409);
  assert.equal(result.body.code, "GAME_NOT_ACTIVE");
});

test("rejects an incomplete playing state instead of indexing null cards", () => {
  const result = getGameActionStateError(activeState({ playerCards: null }), "1163855756");

  assert.equal(result.status, 409);
  assert.equal(result.body.code, "GAME_STATE_NOT_READY");
});

test("distinguishes a player removed from the room", () => {
  const result = getGameActionStateError(activeState(), "removed-user");

  assert.equal(result.status, 403);
  assert.equal(result.body.code, "PLAYER_NOT_IN_ROOM");
});
