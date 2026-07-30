const test = require("node:test");
const assert = require("node:assert/strict");

const postgresPath = require.resolve("../src/config/postgres");
const calls = [];
let selectRows = [];
let settingsRows = [];
let withdrawalRows = [];
let dailyWithdrawalRows = [];

const client = {
  async query(sql, params) {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes("FROM app_settings")) return { rows: settingsRows };
    if (String(sql).includes("AS withdrawn_today")) return { rows: dailyWithdrawalRows };
    if (String(sql).includes("FROM withdrawal_requests")) return { rows: withdrawalRows };
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
    games_played: "6",
    play_days: "3",
    has_positive_deposit: true,
    ...overrides,
  };
}

test.beforeEach(() => {
  calls.length = 0;
  selectRows = [];
  settingsRows = [];
  withdrawalRows = [];
  dailyWithdrawalRows = [];
});

test("a user with fewer than six games rolls back without changing balance", async () => {
  selectRows = [eligibleUser({
    games_played: "5",
  })];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111"),
    (error) => {
      assert.equal(error.message, "WITHDRAWAL_ACTIVITY_REQUIRED");
      assert.equal(error.gamesPlayed, 5);
      assert.equal(error.gamesRequired, 6);
      assert.equal(error.remainingGames, 1);
      assert.equal(error.playDays, 3);
      return true;
    }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("a user who never deposited cannot withdraw", async () => {
  selectRows = [eligibleUser({ has_positive_deposit: false })];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111"),
    { message: "WITHDRAWAL_DEPOSIT_REQUIRED" }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO withdrawal_requests")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("a user with six games across three days can withdraw", async () => {
  selectRows = [eligibleUser()];

  const result = await withdrawBalance("user-1", 10, "+251911111111");

  assert.equal(result.nextBalance, 90);
  assert.equal(result.nextMaxWithdraw, 40);
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  const eligibilityQuery = calls.find(({ sql }) => sql.includes("FROM users"));
  assert.match(eligibilityQuery.sql, /COALESCE\(ugs\.games_played, 0\)/);
  assert.match(eligibilityQuery.sql, /user_game_activity_days/);
  assert.match(eligibilityQuery.sql, /FROM transactions deposit/);
  assert.match(eligibilityQuery.sql, /deposit\.amount > 0/);
  assert.doesNotMatch(eligibilityQuery.sql, /30 days/);
});

test("six games played on fewer than three days cannot withdraw", async () => {
  selectRows = [eligibleUser({ play_days: "2" })];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111"),
    (error) => {
      assert.equal(error.message, "WITHDRAWAL_ACTIVITY_REQUIRED");
      assert.equal(error.remainingGames, 0);
      assert.equal(error.remainingPlayDays, 1);
      return true;
    }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
});

test("a withdrawal that leaves exactly twenty Birr succeeds", async () => {
  selectRows = [eligibleUser({ balance: "30" })];

  const result = await withdrawBalance("user-1", 10, "+251911111111");

  assert.equal(result.nextBalance, 20);
  assert.equal(result.nextMaxWithdraw, 0);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
});

test("a player with 101 games can reach the 200 Birr daily limit", async () => {
  selectRows = [eligibleUser({ balance: "300", games_played: "101" })];
  dailyWithdrawalRows = [{ withdrawn_today: "150" }];

  const result = await withdrawBalance("user-1", 50, "+251911111111");

  assert.equal(result.nextBalance, 250);
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  const dailyQuery = calls.find(({ sql }) => sql.includes("AS withdrawn_today"));
  assert.match(dailyQuery.sql, /Africa\/Addis_Ababa/);
  assert.match(dailyQuery.sql, /date_trunc\('day'/);
});

test("a withdrawal that would exceed the player's daily tier limit rolls back", async () => {
  selectRows = [eligibleUser({ balance: "100" })];
  dailyWithdrawalRows = [{ withdrawn_today: "40" }];

  await assert.rejects(
    withdrawBalance("user-1", 11, "+251911111111"),
    (error) => {
      assert.equal(error.message, "WITHDRAWAL_DAILY_LIMIT_EXCEEDED");
      assert.equal(error.dailyLimit, 50);
      return true;
    }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO withdrawal_requests")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("a player above 300 games has no daily withdrawal cap", async () => {
  selectRows = [eligibleUser({ balance: "1000", games_played: "301" })];

  const result = await withdrawBalance("user-1", 600, "+251911111111");

  assert.equal(result.dailyLimit, null);
  assert.equal(result.remainingDailyLimit, null);
  assert.equal(calls.some(({ sql }) => sql.includes("AS withdrawn_today")), false);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
});

test("a withdrawal that leaves less than twenty Birr rolls back", async () => {
  selectRows = [eligibleUser({ balance: "30" })];

  await assert.rejects(
    withdrawBalance("user-1", 11, "+251911111111"),
    (error) => {
      assert.equal(error.message, "WITHDRAWAL_MIN_BALANCE_REQUIRED");
      assert.equal(error.minimumRemainingBalance, 20);
      assert.equal(error.maxWithdraw, 10);
      return true;
    }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("a user with only twenty Birr cannot withdraw", async () => {
  selectRows = [eligibleUser({ balance: "20" })];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111"),
    (error) => {
      assert.equal(error.message, "WITHDRAWAL_MIN_BALANCE_REQUIRED");
      assert.equal(error.minimumRemainingBalance, 20);
      assert.equal(error.maxWithdraw, 0);
      return true;
    }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
});

test("missing users keep the existing error and rollback behavior", async () => {
  await assert.rejects(
    withdrawBalance("missing", 10, "+251911111111"),
    { message: "USER_NOT_FOUND" }
  );
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("non-withdrawable bonus restrictions still apply after game eligibility", async () => {
  selectRows = [eligibleUser({ balance: "100", non_withdrawable_balance: "95" })];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111"),
    { message: "INSUFFICIENT_WITHDRAWABLE_BALANCE" }
  );
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("locked gift Birr counts toward the retained total balance", async () => {
  selectRows = [eligibleUser({ balance: "30", non_withdrawable_balance: "20" })];

  const result = await withdrawBalance("user-1", 10, "+251911111111");

  assert.equal(result.nextBalance, 20);
  assert.equal(result.nextWithdrawableBalance, 0);
});

test("disabled withdrawals reject before changing balance", async () => {
  settingsRows = [{ value: "false" }];
  selectRows = [eligibleUser()];

  await assert.rejects(
    withdrawBalance("user-1", 10, "+251911111111", { requestId: "request-disabled" }),
    { message: "WITHDRAWALS_DISABLED" }
  );

  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO withdrawal_requests")), false);
});

test("accepted withdrawals persist a request in the debit transaction", async () => {
  selectRows = [eligibleUser()];
  const result = await withdrawBalance("user-1", 10, "+251911111111", {
    requestId: "request-accepted",
  });

  assert.equal(result.request.id, "request-accepted");
  assert.equal(result.request.status, "pending");
  assert.equal(result.duplicate, false);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO withdrawal_requests")), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
});

test("an existing request ID returns without a second debit", async () => {
  withdrawalRows = [{
    id: "request-existing",
    user_id: "user-1",
    phone: "+251911111111",
    amount: "10",
    balance_before: "100",
    balance_after: "90",
    withdrawable_balance_after: "90",
    status: "pending",
  }];

  const result = await withdrawBalance("user-1", 10, "+251911111111", {
    requestId: "request-existing",
  });

  assert.equal(result.duplicate, true);
  assert.equal(result.nextBalance, 90);
  assert.equal(calls.some(({ sql }) => sql.startsWith("UPDATE users")), false);
  assert.equal(calls.some(({ sql }) => sql.includes("AS withdrawn_today")), false);
});
