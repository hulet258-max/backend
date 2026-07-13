const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateCommissionAmount,
  getCommissionRate,
} = require("../src/db/store");

test("starts paid rooms at a flat 7 percent commission", () => {
  assert.equal(getCommissionRate(10, 0), 0.07);
  assert.equal(getCommissionRate(10, 1), 0.07);
  assert.equal(getCommissionRate(250, 3), 0.07);
});

test("enforces a 1 Birr minimum commission for paid rounds", () => {
  assert.equal(calculateCommissionAmount(4, 2, 1), 1);
});

test("rounds commission to the nearest whole Birr", () => {
  assert.equal(calculateCommissionAmount(20, 10, 1), 1); // 1.40 rounds down
  assert.equal(calculateCommissionAmount(25, 10, 1), 2); // 1.75 rounds up
  assert.equal(calculateCommissionAmount(50, 10, 1), 4); // 3.50 rounds up
});

test("gradually decreases commission as paid rounds are completed", () => {
  assert.equal(getCommissionRate(50, 4), 0.06);
  assert.equal(getCommissionRate(50, 8), 0.05);
  assert.equal(getCommissionRate(50, 16), 0.04);
  assert.equal(getCommissionRate(50, 100), 0.04);

  assert.equal(calculateCommissionAmount(100, 50, 1), 7);
  assert.equal(calculateCommissionAmount(100, 50, 10), 5);
  assert.equal(calculateCommissionAmount(100, 50, 20), 4);
});

test("preserves the entire pot between commission and payout", () => {
  const pot = 14;
  const commission = calculateCommissionAmount(pot, 7, 3);
  const payout = pot - commission;
  assert.equal(commission, 1);
  assert.equal(payout, 13);
  assert.equal(commission + payout, pot);
});

test("never takes more commission than the pot", () => {
  assert.equal(calculateCommissionAmount(0.5, 1, 1), 0.5);
});
