const test = require("node:test");
const assert = require("node:assert/strict");

const { withdrawalCompletedText } = require("../src/services/withdrawals");

test("withdrawal completion tells the user the payment amount was sent", () => {
  const message = withdrawalCompletedText({ amount: 125 });

  assert.match(message, /The payment for 125 Birr has been sent to you\./);
  assert.match(message, /Check your account\./);
  assert.doesNotMatch(message, /marked/i);
});
