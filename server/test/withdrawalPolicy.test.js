const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getDailyWithdrawalLimitBirr,
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

test("daily withdrawal limits increase with completed games", () => {
  assert.equal(getDailyWithdrawalLimitBirr(0), 50);
  assert.equal(getDailyWithdrawalLimitBirr(100), 50);
  assert.equal(getDailyWithdrawalLimitBirr(101), 200);
  assert.equal(getDailyWithdrawalLimitBirr(199), 200);
  assert.equal(getDailyWithdrawalLimitBirr(200), 500);
  assert.equal(getDailyWithdrawalLimitBirr(300), 500);
  assert.equal(getDailyWithdrawalLimitBirr(301), null);
});
