const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WITHDRAWAL_WAIT_DAYS,
  splitRemainingWithdrawalTime,
} = require("../src/services/withdrawalPolicy");

test("withdrawals require a 30-day-old account", () => {
  assert.equal(WITHDRAWAL_WAIT_DAYS, 30);
});

test("remaining withdrawal time is shown as whole days and hours", () => {
  assert.deepEqual(splitRemainingWithdrawalTime((29 * 24 + 5) * 60 * 60), {
    remainingDays: 29,
    remainingHours: 5,
  });
});

test("a partial remaining hour rounds up so eligibility is not shown early", () => {
  assert.deepEqual(splitRemainingWithdrawalTime(1), {
    remainingDays: 0,
    remainingHours: 1,
  });
});

test("eligible accounts have no remaining withdrawal wait", () => {
  assert.deepEqual(splitRemainingWithdrawalTime(0), {
    remainingDays: 0,
    remainingHours: 0,
  });
});
