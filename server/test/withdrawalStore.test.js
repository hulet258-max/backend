const test = require("node:test");
const assert = require("node:assert/strict");

const postgresPath = require.resolve("../src/config/postgres");
const calls = [];
let selectRows = [];

const client = {
  async query(sql, params) {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes("FROM users")) return { rows: selectRows };
    return { rows: [], rowCount: 1 };
  },
  release() {
    calls.push({ sql: "RELEASE" });
  },
};

require.cache[postgresPath] = {
  id: postgresPath,
  filename: postgresPath,
  loaded: true,
  exports: {
    pool: { connect: async () => client },
    query: async () => ({ rows: [] }),
  },
};

const { withdrawBalance } = require("../src/db/store");

function eligibleUser(overrides = {}) {
  return {
    telegram_id: "user-1",
    balance: "100",
    non_withdrawable_balance: "0",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    withdrawal_eligible_at: new Date("2026-01-31T00:00:00.000Z"),
    withdrawal_eligible: true,
    withdrawal_remaining_seconds: "0",
    ...overrides,
  };
}

test.beforeEach(() => {
  calls.length = 0;
  selectRows = [];
});

test("a too-new account rolls back without changing its balance", async () => {
  selectRows = [eligibleUser({
    withdrawal_eligible: false,
    withdrawal_remaining_seconds: "90061",
  })];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111"),
    (error) => {
      assert.equal(error.message, "WITHDRAWAL_ACCOUNT_TOO_NEW");
      assert.equal(error.remainingSeconds, 90061);
      return true;
    }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("an account eligible according to database time can withdraw", async () => {
  selectRows = [eligibleUser()];

  const result = await withdrawBalance("user-1", 10, "+251911111111");

  assert.equal(result.nextBalance, 90);
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  const eligibilityQuery = calls.find(({ sql }) => sql.includes("FROM users"));
  assert.match(eligibilityQuery.sql, /NOW\(\) >= created_at \+ INTERVAL '30 days'/);
});

test("missing users keep the existing error and rollback behavior", async () => {
  await assert.rejects(
    withdrawBalance("missing", 10, "+251911111111"),
    { message: "USER_NOT_FOUND" }
  );
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("non-withdrawable bonus restrictions still apply after age eligibility", async () => {
  selectRows = [eligibleUser({ balance: "100", non_withdrawable_balance: "95" })];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111"),
    { message: "INSUFFICIENT_WITHDRAWABLE_BALANCE" }
  );
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});
