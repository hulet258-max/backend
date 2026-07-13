const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MANAGED_BOT_STARTING_BALANCE_BIRR,
  MIN_COMMISSION_BIRR,
  MIN_ROOM_ENTRY_BIRR,
  ROOM_ENTRY_STEP_BIRR,
  REFERRAL_REWARD_BIRR,
  WELCOME_GIFT_BIRR,
  birrToBalance,
  isValidRoomEntryBirr,
} = require("../src/config/economy");

test("money is Birr-native with no balance conversion", () => {
  assert.equal(birrToBalance(125), 125);
});

test("managed bot accounts are funded with 20,000 Birr", () => {
  assert.equal(MANAGED_BOT_STARTING_BALANCE_BIRR, 20000);
});

test("new users receive a 10 Birr welcome gift", () => {
  assert.equal(WELCOME_GIFT_BIRR, 10);
});

test("referrers receive 2 Birr for each eligible referral", () => {
  assert.equal(REFERRAL_REWARD_BIRR, 2);
});

test("paid round commission floor is 1 Birr", () => {
  assert.equal(MIN_COMMISSION_BIRR, 1);
});

test("room entry fees are at least 10 Birr and multiples of 5", () => {
  assert.equal(MIN_ROOM_ENTRY_BIRR, 10);
  assert.equal(ROOM_ENTRY_STEP_BIRR, 5);
  assert.equal(isValidRoomEntryBirr(5), false);
  assert.equal(isValidRoomEntryBirr(10), true);
  assert.equal(isValidRoomEntryBirr(15), true);
  assert.equal(isValidRoomEntryBirr(12), false);
});
