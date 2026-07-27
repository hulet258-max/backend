const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DAILY_WITHDRAWAL_LIMIT_BIRR,
  MIN_WITHDRAW_BIRR,
  MIN_REMAINING_BALANCE_BIRR,
  MIN_WITHDRAWAL_GAMES,
  MIN_WITHDRAWAL_PLAY_DAYS,
} = require("../src/config/economy");

test("withdrawals require six completed games across three play days", () => {
  assert.equal(MIN_WITHDRAWAL_GAMES, 6);
  assert.equal(MIN_WITHDRAWAL_PLAY_DAYS, 3);
});

test("withdrawals start at ten Birr and must leave twenty Birr in the account", () => {
  assert.equal(MIN_WITHDRAW_BIRR, 10);
  assert.equal(MIN_REMAINING_BALANCE_BIRR, 20);
});

test("withdrawals are capped at two hundred Birr per Ethiopian calendar day", () => {
  assert.equal(DAILY_WITHDRAWAL_LIMIT_BIRR, 200);
});
