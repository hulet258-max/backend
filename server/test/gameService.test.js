const test = require("node:test");
const assert = require("node:assert/strict");

const { createInitialGameState } = require("../src/services/gameService");

for (const playerCount of [2, 3, 4]) {
  test(`deals a valid ${playerCount}-player opening state`, () => {
    const playerIds = Array.from({ length: playerCount }, (_, index) => `u${index + 1}`);
    const state = createInitialGameState(playerIds);

    assert.equal(state.turn, "u1");
    assert.equal(state.playerCards.u1.length, 11);
    for (const playerId of playerIds.slice(1)) {
      assert.equal(state.playerCards[playerId].length, 10);
    }
    assert.equal(state.laidCards.length, 0);

    const expectedDecks = Math.max(1, Math.min(playerCount - 1, 3));
    const dealtCount = 11 + ((playerCount - 1) * 10);
    assert.equal(state.deck.length, (expectedDecks * 54) - dealtCount);
  });
}
