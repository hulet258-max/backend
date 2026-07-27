const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decideScriptedOutcome,
  pressureForScriptedOutcome,
} = require("../src/services/houseBotController");

/**
 * Documented contract for managed rounds:
 * 1) Winner chosen without cards
 * 2) Deal happens after
 * 3) Bot only declares if scripted winner is bot
 */

test("scripted outcome does not require cards — only player/room context", () => {
  const outcome = decideScriptedOutcome({
    gamesPlayed: 12,
    wins: 5,
    balance: 80,
    entryFee: 20,
  }, () => 0.1);
  assert.ok(outcome.scriptedWinner === "bot" || outcome.scriptedWinner === "human");
  assert.equal(typeof outcome.botWinProbability, "number");
  assert.ok(outcome.factors);
  assert.equal(outcome.factors.entryFee, 20);
  assert.equal(outcome.factors.gamesPlayed, 12);
  assert.equal(outcome.factors.wins, 5);
});

test("bot/human scripts map to natural play pressure", () => {
  assert.equal(pressureForScriptedOutcome(true, "fair"), "take");
  assert.equal(pressureForScriptedOutcome(true, "take"), "take");
  assert.equal(pressureForScriptedOutcome(false, "take"), "give");
});

test("allowBotWinDeclare rule: only when scripted bot", () => {
  const allow = (scriptedWinner, scriptedBotWins) => (
    scriptedWinner === "bot" || scriptedBotWins === true
  );
  assert.equal(allow("bot", true), true);
  assert.equal(allow("human", false), false);
  assert.equal(allow(null, null), false);
  assert.equal(allow(undefined, undefined), false);
});
