const { randomUUID } = require("crypto");
const { pool, query } = require("../config/postgres");
const {
  DAILY_WITHDRAWAL_LIMIT_BIRR,
  MIN_COMMISSION_BIRR,
  MIN_REMAINING_BALANCE_BIRR,
  MIN_WITHDRAWAL_GAMES,
  MIN_WITHDRAWAL_PLAY_DAYS,
  REFERRAL_REWARD_BIRR,
  WELCOME_GIFT_BIRR,
} = require("../config/economy");

let schemaReadyPromise = null;

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapUser(row) {
  if (!row) return null;
  const telegramId = String(row.telegram_id);
  const balance = parseNumber(row.balance);
  const nonWithdrawableBalance = Math.min(balance, parseNumber(row.non_withdrawable_balance));
  return {
    id: telegramId,
    telegramId,
    phone: row.phone,
    username: row.username || "",
    displayName: row.display_name || row.first_name || row.username || "User",
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    photoUrl: row.photo_url || "",
    welcomeGiftSeen: Boolean(row.welcome_gift_seen),
    balance,
    nonWithdrawableBalance,
    withdrawableBalance: Math.max(balance - nonWithdrawableBalance, 0),
    roomIn: row.room_in,
    depositSum: parseNumber(row.deposit_sum),
    totalWithdrawn: parseNumber(row.total_withdrawn),
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

function mapPublicUser(row) {
  if (!row) return null;
  const telegramId = String(row.telegram_id);
  return {
    telegramId,
    displayName: row.display_name || row.first_name || row.username || "User",
    firstName: row.first_name || "",
    username: row.username || "",
    photoUrl: row.photo_url || "",
  };
}

function mapRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.id,
    name: row.name,
    type: row.type,
    entryFee: parseNumber(row.entry_fee),
    stake: parseNumber(row.stake),
    creatorId: row.creator_id,
    visibility: row.visibility,
    createdAt: row.created_at,
    players: row.players || [],
    playerCount: Number(row.player_count || 0),
    maxPlayers: Number(row.max_players || 0),
    status: row.status,
    roomStats: row.room_stats || { gamesPlayed: 0, winnerCounts: {} },
    isArchived: Boolean(row.is_archived),
    archivedAt: row.archived_at || null,
    archivedReason: row.archived_reason || null,
  };
}

function roundMoney(value) {
  const parsed = Number(value || 0);
  // Keep fractional-Birr precision while removing JavaScript floating-point noise.
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : 0;
}

function mapWithdrawalRequest(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    userName: row.user_name || row.display_name || row.first_name || row.username || "User",
    phone: row.phone || "",
    amount: roundMoney(row.amount),
    balanceBefore: roundMoney(row.balance_before),
    balanceAfter: roundMoney(row.balance_after),
    withdrawableBalanceAfter: roundMoney(row.withdrawable_balance_after),
    status: row.status || "pending",
    requestedAt: row.requested_at || null,
    completedAt: row.completed_at || null,
    adminNotifiedAt: row.admin_notified_at || null,
    telegramAdminMessageId: row.telegram_admin_message_id || null,
    notificationError: row.notification_error || "",
    userNotifiedAt: row.user_notified_at || null,
  };
}

function getCommissionRate(entryFee, gamesPlayed = 0) {
  const fee = roundMoney(entryFee);
  if (fee <= 0) return 0;
  // Reward players who keep replaying in the same room. The rate is based on
  // completed paid-round count (or the round currently being settled), not on
  // the entry-fee tier. A newly escrowed room reports the round-one rate.
  const roundNumber = Math.max(1, Math.floor(Number(gamesPlayed || 0)));
  if (roundNumber <= 3) return 0.07;
  if (roundNumber <= 7) return 0.06;
  if (roundNumber <= 15) return 0.05;
  return 0.04;
}

function calculateCommissionAmount(totalPot, entryFee, gamesPlayed = 0) {
  const pot = roundMoney(totalPot);
  if (pot <= 0) return 0;
  // Commission is always charged in whole Birr. Standard rounding makes
  // fractions below .50 round down and fractions of .50 or more round up.
  const proportionalCommission = Math.round(pot * getCommissionRate(entryFee, gamesPlayed));
  return Math.min(pot, Math.max(MIN_COMMISSION_BIRR, proportionalCommission));
}

function normalizeLastSettlement(settlement = null) {
  if (!settlement || typeof settlement !== "object") return null;
  return {
    round: Number(settlement.round || 0),
    winnerId: settlement.winnerId ? String(settlement.winnerId) : null,
    roundPot: roundMoney(settlement.roundPot || 0),
    commissionAmount: roundMoney(settlement.commissionAmount || 0),
    commissionRate: Number(settlement.commissionRate || 0),
    winnerPayout: roundMoney(settlement.winnerPayout || 0),
    settledAt: settlement.settledAt || null,
  };
}

function normalizeRoomStats(stats = {}) {
  const entryFee = roundMoney(stats.entryFee || 0);
  const botResults = stats.botResults || {};
  return {
    gamesPlayed: Number(stats.gamesPlayed || 0),
    winnerCounts: stats.winnerCounts || {},
    winnerWeights: stats.winnerWeights || {},
    games: stats.games || [],
    feeEscrowed: Boolean(stats.feeEscrowed),
    escrowRefunded: Boolean(stats.escrowRefunded),
    escrowSettled: Boolean(stats.escrowSettled),
    escrowPlayers: (stats.escrowPlayers || []).map(String),
    currentRoundPlayers: (stats.currentRoundPlayers || []).map(String),
    currentRoundBonusEscrow: stats.currentRoundBonusEscrow || {},
    currentRoundPot: roundMoney(stats.currentRoundPot || 0),
    entryFee,
    totalPot: roundMoney(stats.totalPot || 0),
    commissionRate: getCommissionRate(entryFee, Number(stats.gamesPlayed || 0)),
    commissionAmount: roundMoney(stats.commissionAmount || 0),
    roundsEscrowed: Number(stats.roundsEscrowed || 0),
    playerFeesPaid: stats.playerFeesPaid || {},
    payouts: stats.payouts || {},
    refunds: stats.refunds || {},
    bonusRefunds: stats.bonusRefunds || {},
    leavePenaltyAmount: roundMoney(stats.leavePenaltyAmount || 0),
    leavePenalties: Array.isArray(stats.leavePenalties) ? stats.leavePenalties : [],
    lastLeavePenalty: stats.lastLeavePenalty || null,
    topWinnerIds: (stats.topWinnerIds || []).map(String),
    finalizedReason: stats.finalizedReason || null,
    finalizedAt: stats.finalizedAt || null,
    lastSettlement: normalizeLastSettlement(stats.lastSettlement),
    practice: Boolean(stats.practice),
    botGame: Boolean(stats.botGame),
    managedBotRoom: Boolean(stats.managedBotRoom),
    managedBotDeparted: Boolean(stats.managedBotDeparted),
    managedReplacementFee: roundMoney(stats.managedReplacementFee || 0),
    rematchRecruiting: Boolean(stats.rematchRecruiting),
    generatedFor: stats.generatedFor ? String(stats.generatedFor) : null,
    botProfile: stats.botProfile || null,
    targetBotWinRate: Number(stats.targetBotWinRate || 0),
    botDifficulty: stats.botDifficulty || null,
    botResults: {
      gamesPlayed: Number(botResults.gamesPlayed || 0),
      wins: Number(botResults.wins || 0),
      losses: Number(botResults.losses || 0),
    },
  };
}

function roomHasCompletedGame(stats = {}) {
  const roomStats = normalizeRoomStats(stats);
  return roomStats.gamesPlayed > 0 ||
    roomStats.games.length > 0 ||
    roomStats.leavePenaltyAmount > 0;
}

async function getUser(telegramId) {
  const result = await query("SELECT * FROM users WHERE telegram_id = $1", [String(telegramId)]);
  return mapUser(result.rows[0]);
}

async function createSyntheticBot({ telegramId, displayName, balance }) {
  const result = await query(
    `INSERT INTO users (
      telegram_id, username, display_name, first_name, balance, created_at, last_seen
    )
    VALUES ($1, $2, $2, $2, $3, NOW(), NOW())
    ON CONFLICT (telegram_id) DO UPDATE SET
      username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      first_name = EXCLUDED.first_name,
      balance = EXCLUDED.balance,
      last_seen = NOW()
    RETURNING *`,
    [String(telegramId), String(displayName), roundMoney(balance)]
  );
  return mapUser(result.rows[0]);
}

async function ensureSyntheticBotBalance(botId, minimumBalance, fundedBalance) {
  const targetBalance = Math.max(roundMoney(minimumBalance), roundMoney(fundedBalance));
  const result = await query(
    `UPDATE users
    SET balance = CASE WHEN balance < $2 THEN $2 ELSE balance END,
      last_seen = NOW()
    WHERE telegram_id = $1
    RETURNING *`,
    [String(botId), targetBalance]
  );
  return mapUser(result.rows[0]);
}

async function deleteSyntheticBot(botId) {
  await query(
    "DELETE FROM users WHERE telegram_id = $1 AND telegram_id LIKE 'botgamer:managed:%'",
    [String(botId)]
  );
}

async function ensureUser(telegramId, telegramProfile = {}) {
  const cleanTelegramId = String(telegramId);
  const username = String(telegramProfile.username || "").replace(/^@/, "").trim();
  const firstName = String(telegramProfile.firstName || telegramProfile.first_name || "").trim();
  const lastName = String(telegramProfile.lastName || telegramProfile.last_name || "").trim();
  const photoUrl = String(telegramProfile.photoUrl || telegramProfile.photo_url || "").trim();
  const insertResult = await query(
    `INSERT INTO users (
      telegram_id, username, first_name, last_name, photo_url, balance, non_withdrawable_balance, welcome_gift_seen
    )
    VALUES ($1, $2, $3, $4, $5, $6, $6, FALSE)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username = COALESCE(NULLIF(EXCLUDED.username, ''), users.username),
      first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), users.first_name),
      last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), users.last_name),
      photo_url = COALESCE(NULLIF(EXCLUDED.photo_url, ''), users.photo_url),
      last_seen = NOW()
    RETURNING *, (xmax = 0) AS was_inserted`,
    [cleanTelegramId, username, firstName, lastName, photoUrl, WELCOME_GIFT_BIRR]
  );

  const shouldShowWelcomeGift = !Boolean(insertResult.rows[0]?.welcome_gift_seen);
  if (shouldShowWelcomeGift) {
    return {
      ...mapUser(insertResult.rows[0]),
      isFirstRun: true,
      firstRunGiftBirr: WELCOME_GIFT_BIRR,
    };
  }

  return {
    ...mapUser(insertResult.rows[0]),
    isFirstRun: false,
    firstRunGiftBirr: 0,
  };
}

async function ensureAppSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = ensureAppSchemaOnce().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

async function ensureAppSchemaOnce() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      phone TEXT,
      username TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      balance NUMERIC(16, 4) NOT NULL DEFAULT 0,
      non_withdrawable_balance NUMERIC(16, 4) NOT NULL DEFAULT 0,
      room_in TEXT,
      deposit_sum NUMERIC(16, 4) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      welcome_gift_seen BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(16, 4) NOT NULL DEFAULT 0");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS non_withdrawable_balance NUMERIC(16, 4) NOT NULL DEFAULT 0");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS room_in TEXT");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_sum NUMERIC(16, 4) NOT NULL DEFAULT 0");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS total_withdrawn NUMERIC(16, 4) NOT NULL DEFAULT 0");
  await query("ALTER TABLE users ALTER COLUMN balance TYPE NUMERIC(16, 4) USING balance::NUMERIC(16, 4)");
  await query("ALTER TABLE users ALTER COLUMN non_withdrawable_balance TYPE NUMERIC(16, 4) USING non_withdrawable_balance::NUMERIC(16, 4)");
  await query("ALTER TABLE users ALTER COLUMN deposit_sum TYPE NUMERIC(16, 4) USING deposit_sum::NUMERIC(16, 4)");
  await query("ALTER TABLE users ALTER COLUMN total_withdrawn TYPE NUMERIC(16, 4) USING total_withdrawn::NUMERIC(16, 4)");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_gift_seen BOOLEAN");
  await query("UPDATE users SET welcome_gift_seen = TRUE WHERE welcome_gift_seen IS NULL");
  await query("ALTER TABLE users ALTER COLUMN welcome_gift_seen SET DEFAULT FALSE");
  await query("ALTER TABLE users ALTER COLUMN welcome_gift_seen SET NOT NULL");
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name_unique
    ON users (LOWER(display_name))
    WHERE display_name IS NOT NULL AND display_name <> ''
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      entry_fee NUMERIC(16, 4) NOT NULL DEFAULT 0,
      stake NUMERIC(16, 4) NOT NULL DEFAULT 0,
      creator_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      players TEXT[] NOT NULL DEFAULT '{}',
      player_count INTEGER NOT NULL DEFAULT 0,
      max_players INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'waiting',
      room_stats JSONB NOT NULL DEFAULT '{"gamesPlayed":0,"winnerCounts":{}}'::jsonb
    )
  `);
  await query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public'");
  await query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS players TEXT[] NOT NULL DEFAULT '{}'");
  await query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS player_count INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_players INTEGER NOT NULL DEFAULT 2");
  await query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'waiting'");
  await query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_stats JSONB NOT NULL DEFAULT '{\"gamesPlayed\":0,\"winnerCounts\":{}}'::jsonb");
  await query("ALTER TABLE rooms ALTER COLUMN entry_fee TYPE NUMERIC(16, 4) USING entry_fee::NUMERIC(16, 4)");
  await query("ALTER TABLE rooms ALTER COLUMN stake TYPE NUMERIC(16, 4) USING stake::NUMERIC(16, 4)");
  await query(`
    CREATE INDEX IF NOT EXISTS idx_rooms_visibility_created_at
    ON rooms (visibility, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      amount NUMERIC(16, 4) NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(16, 4) USING amount::NUMERIC(16, 4)");
  await query("CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp DESC)");

  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    INSERT INTO app_settings (key, value)
    VALUES ('withdrawals_enabled', 'true')
    ON CONFLICT (key) DO NOTHING
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      amount NUMERIC(16, 4) NOT NULL,
      balance_before NUMERIC(16, 4) NOT NULL,
      balance_after NUMERIC(16, 4) NOT NULL,
      withdrawable_balance_after NUMERIC(16, 4) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      admin_notified_at TIMESTAMPTZ,
      telegram_admin_message_id TEXT,
      notification_error TEXT NOT NULL DEFAULT '',
      user_notification_started_at TIMESTAMPTZ,
      user_notified_at TIMESTAMPTZ
    )
  `);
  await query("ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS user_notification_started_at TIMESTAMPTZ");
  await query("CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status_requested ON withdrawal_requests (status, requested_at DESC)");
  await query("CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_requested ON withdrawal_requests (user_id, requested_at DESC)");

  await query(`
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      total_amount NUMERIC(16, 4) NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await query("ALTER TABLE stats ALTER COLUMN total_amount TYPE NUMERIC(16, 4) USING total_amount::NUMERIC(16, 4)");

  await ensureReferralTables();
  await query(`
    CREATE TABLE IF NOT EXISTS user_game_stats (
      user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      amount_played NUMERIC(16, 4) NOT NULL DEFAULT 0,
      managed_bonus_intro_started BOOLEAN NOT NULL DEFAULT FALSE,
      managed_bonus_intro_games INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("ALTER TABLE user_game_stats ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE user_game_stats ADD COLUMN IF NOT EXISTS managed_bonus_intro_started BOOLEAN NOT NULL DEFAULT FALSE");
  await query("ALTER TABLE user_game_stats ADD COLUMN IF NOT EXISTS managed_bonus_intro_games INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE user_game_stats ALTER COLUMN amount_played TYPE NUMERIC(16, 4) USING amount_played::NUMERIC(16, 4)");
  await query(`
    CREATE TABLE IF NOT EXISTS user_game_activity_days (
      user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      played_on DATE NOT NULL,
      games_played INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, played_on)
    )
  `);
  await query("CREATE INDEX IF NOT EXISTS idx_user_game_activity_days_user ON user_game_activity_days (user_id, played_on DESC)");
  await query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications (user_id, created_at DESC) WHERE read_at IS NULL");
  await query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      session_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '/',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events (created_at DESC)");
  await query("CREATE INDEX IF NOT EXISTS idx_analytics_events_name_created ON analytics_events (event_name, created_at DESC)");
  await backfillNonWithdrawableGiftBalance();
  await ensureRoomArchiveTable();
  await backfillUserGameActivityDays();
  await backfillUserWins();
  await ensureAdminContentTables();
}

async function backfillUserGameActivityDays() {
  await query(`
    WITH retained_games AS (
      SELECT room_stats, created_at FROM rooms
      UNION ALL
      SELECT room_stats, created_at FROM archived_rooms
    ), historical_activity AS (
      SELECT
        player.user_id,
        (
          COALESCE(NULLIF(game.value->>'completedAt', '')::timestamptz, retained_games.created_at)
          AT TIME ZONE 'Africa/Addis_Ababa'
        )::date AS played_on,
        COUNT(*)::integer AS games_played
      FROM retained_games
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(COALESCE(retained_games.room_stats->'games', '[]'::jsonb)) = 'array'
          THEN COALESCE(retained_games.room_stats->'games', '[]'::jsonb)
          ELSE '[]'::jsonb
        END
      ) game(value)
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(COALESCE(game.value->'players', '[]'::jsonb)) = 'array'
          THEN COALESCE(game.value->'players', '[]'::jsonb)
          ELSE '[]'::jsonb
        END
      ) player(user_id)
      WHERE player.user_id NOT LIKE 'botgamer:%'
      GROUP BY player.user_id, played_on
    )
    INSERT INTO user_game_activity_days (user_id, played_on, games_played)
    SELECT activity.user_id, activity.played_on, activity.games_played
    FROM historical_activity activity
    INNER JOIN users ON users.telegram_id = activity.user_id
    ON CONFLICT (user_id, played_on) DO NOTHING
  `);
}

async function backfillUserWins() {
  await query(`
    WITH retained_wins AS (
      SELECT winner.user_id, SUM(winner.win_count)::integer AS wins
      FROM (
        SELECT entry.key AS user_id, entry.value::integer AS win_count
        FROM rooms r
        CROSS JOIN LATERAL jsonb_each_text(COALESCE(r.room_stats->'winnerCounts', '{}'::jsonb)) entry
        UNION ALL
        SELECT entry.key AS user_id, entry.value::integer AS win_count
        FROM archived_rooms ar
        CROSS JOIN LATERAL jsonb_each_text(COALESCE(ar.room_stats->'winnerCounts', '{}'::jsonb)) entry
      ) winner
      WHERE winner.user_id NOT LIKE 'botgamer:%'
      GROUP BY winner.user_id
    )
    INSERT INTO user_game_stats (user_id, wins)
    SELECT retained_wins.user_id, retained_wins.wins
    FROM retained_wins
    INNER JOIN users ON users.telegram_id = retained_wins.user_id
    ON CONFLICT (user_id) DO UPDATE SET
      wins = CASE WHEN user_game_stats.wins = 0 THEN EXCLUDED.wins ELSE user_game_stats.wins END,
      updated_at = CASE
        WHEN user_game_stats.wins = 0 THEN NOW()
        ELSE user_game_stats.updated_at
      END
  `);
}

async function backfillNonWithdrawableGiftBalance() {
  await query(
    `UPDATE users u
    SET non_withdrawable_balance = LEAST(
      u.balance,
      GREATEST(
        0,
        $1::numeric
        + COALESCE((
          SELECT SUM(ra.amount)
          FROM referral_awards ra
          WHERE ra.referrer_id = u.telegram_id
        ), 0)
        - COALESCE((
          SELECT ugs.amount_played
          FROM user_game_stats ugs
          WHERE ugs.user_id = u.telegram_id
        ), 0)
      )
    )
    WHERE u.non_withdrawable_balance = 0
      AND LEAST(
        u.balance,
        GREATEST(
          0,
          $1::numeric
          + COALESCE((
            SELECT SUM(ra.amount)
            FROM referral_awards ra
            WHERE ra.referrer_id = u.telegram_id
          ), 0)
          - COALESCE((
            SELECT ugs.amount_played
            FROM user_game_stats ugs
            WHERE ugs.user_id = u.telegram_id
          ), 0)
        )
      ) > 0`,
    [WELCOME_GIFT_BIRR]
  );
}

function normalizeDisplayName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

async function updateUserDisplayName(userId, displayName) {
  await ensureAppSchema();
  const cleanName = normalizeDisplayName(displayName);
  if (cleanName.length < 3 || cleanName.length > 24) {
    const error = new Error("Display name must be 3 to 24 characters.");
    error.code = "INVALID_DISPLAY_NAME";
    throw error;
  }
  if (!/^[\p{L}\p{N} _.-]+$/u.test(cleanName)) {
    const error = new Error("Display name can use letters, numbers, spaces, dots, dashes, and underscores.");
    error.code = "INVALID_DISPLAY_NAME";
    throw error;
  }

  try {
    const result = await query(
      `UPDATE users
      SET display_name = $2, last_seen = NOW()
      WHERE telegram_id = $1
      RETURNING *`,
      [String(userId), cleanName]
    );
    return mapUser(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      const duplicate = new Error("This visible name is already used.");
      duplicate.code = "DISPLAY_NAME_TAKEN";
      throw duplicate;
    }
    throw error;
  }
}

async function getPublicUsers(userIds = []) {
  await ensureAppSchema();
  const normalizedIds = [...new Set(userIds.map(String).filter(Boolean))];
  if (!normalizedIds.length) return [];
  const result = await query(
    "SELECT telegram_id, display_name, username, first_name, photo_url FROM users WHERE telegram_id = ANY($1::text[])",
    [normalizedIds]
  );
  return result.rows.map(mapPublicUser);
}

async function getUserProfile(userId) {
  await ensureAppSchema();
  const user = await getUser(userId);
  if (!user) return null;

  const statsResult = await query(
    "SELECT games_played, wins, amount_played FROM user_game_stats WHERE user_id = $1",
    [String(userId)]
  );
  const referralResult = await query(
    `SELECT
      COALESCE(SUM(share_count), 0) AS share_count,
      COALESCE(SUM(reward_count), 0) AS reward_count,
      COALESCE(SUM(max_rewards), 0) AS max_rewards
    FROM referral_links
    WHERE user_id = $1`,
    [String(userId)]
  );
  const row = referralResult.rows[0] || {};
  const shareCount = Number(row.share_count || 0);
  const rewardCount = Number(row.reward_count || 0);
  const maxRewards = Number(row.max_rewards || 0);

  return {
    user,
    gameStats: {
      gamesPlayed: Number(statsResult.rows[0]?.games_played || 0),
      wins: Number(statsResult.rows[0]?.wins || 0),
      amountPlayed: parseNumber(statsResult.rows[0]?.amount_played || 0),
    },
    referralStats: {
      shareCount,
      rewardCount,
      earnedBirr: rewardCount * REFERRAL_REWARD_BIRR,
      rewardsLeft: Math.max(maxRewards - rewardCount, 0),
      maxRewards,
    },
  };
}

async function getUserGameStats(userId) {
  const result = await query(
    `SELECT games_played, wins, managed_bonus_intro_started, managed_bonus_intro_games
    FROM user_game_stats WHERE user_id = $1`,
    [String(userId)]
  );
  return {
    gamesPlayed: Number(result.rows[0]?.games_played || 0),
    wins: Number(result.rows[0]?.wins || 0),
    managedBonusIntroStarted: Boolean(result.rows[0]?.managed_bonus_intro_started),
    managedBonusIntroGames: Math.max(0, Number(result.rows[0]?.managed_bonus_intro_games || 0)),
  };
}

async function latchManagedBonusIntro(userId, bonusUsed = 0) {
  const cleanUserId = String(userId || "");
  if (!cleanUserId) return { started: false, games: 0, active: false };
  const usedBonus = Math.max(0, roundMoney(bonusUsed));
  const result = await query(
    `INSERT INTO user_game_stats (
      user_id, managed_bonus_intro_started, managed_bonus_intro_games
    ) VALUES ($1, $2, 0)
    ON CONFLICT (user_id) DO UPDATE SET
      managed_bonus_intro_started = CASE
        WHEN user_game_stats.managed_bonus_intro_started THEN TRUE
        WHEN user_game_stats.games_played = 0 AND $2::boolean THEN TRUE
        ELSE FALSE
      END,
      updated_at = NOW()
    RETURNING managed_bonus_intro_started, managed_bonus_intro_games`,
    [cleanUserId, usedBonus > 0]
  );
  const started = Boolean(result.rows[0]?.managed_bonus_intro_started);
  const games = Math.max(0, Number(result.rows[0]?.managed_bonus_intro_games || 0));
  return { started, games, active: started && games < 3 };
}

async function acknowledgeWelcomeGift(userId) {
  const result = await query(
    `UPDATE users SET welcome_gift_seen = TRUE, last_seen = NOW()
    WHERE telegram_id = $1 RETURNING *`,
    [String(userId)]
  );
  return mapUser(result.rows[0]);
}

function mapNotification(row) {
  return {
    id: Number(row.id),
    type: row.type,
    data: row.data || {},
    createdAt: row.created_at,
  };
}

async function getUnreadNotifications(userId) {
  const result = await query(
    `SELECT * FROM user_notifications
    WHERE user_id = $1 AND read_at IS NULL
    ORDER BY created_at ASC LIMIT 20`,
    [String(userId)]
  );
  return result.rows.map(mapNotification);
}

async function acknowledgeNotification(userId, notificationId) {
  const result = await query(
    `UPDATE user_notifications SET read_at = NOW()
    WHERE id = $1 AND user_id = $2 AND read_at IS NULL
    RETURNING *`,
    [Number(notificationId), String(userId)]
  );
  return mapNotification(result.rows[0]);
}

async function incrementUserAmountPlayed(userIds, amount) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  const fee = roundMoney(amount);
  if (!ids.length || fee <= 0) return;

  await query(
    `INSERT INTO user_game_stats (user_id, amount_played)
    SELECT id, $2::numeric
    FROM UNNEST($1::text[]) AS ids(id)
    ON CONFLICT (user_id) DO UPDATE SET
      amount_played = user_game_stats.amount_played + EXCLUDED.amount_played,
      updated_at = NOW()`,
    [ids, fee]
  );
}

async function incrementUserGamesPlayed(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length) return;

  await query(
    `INSERT INTO user_game_stats (user_id, games_played)
    SELECT id, 1
    FROM UNNEST($1::text[]) AS ids(id)
    ON CONFLICT (user_id) DO UPDATE SET
      games_played = user_game_stats.games_played + 1,
      updated_at = NOW()`,
    [ids]
  );
}

async function upsertUser(telegramUser) {
  const telegramId = String(telegramUser.telegramId);
  const initialBalance = telegramUser.balance ?? WELCOME_GIFT_BIRR;
  const initialNonWithdrawable = telegramUser.nonWithdrawableBalance ?? (
    telegramUser.balance === undefined ? WELCOME_GIFT_BIRR : 0
  );
  const result = await query(
    `INSERT INTO users (
      telegram_id, phone, username, first_name, last_name, photo_url, balance, non_withdrawable_balance,
      room_in, deposit_sum, created_at, last_seen
    )
    VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), COALESCE($8, 0), $9, COALESCE($10, 0), COALESCE($11, NOW()), COALESCE($12, NOW()))
    ON CONFLICT (telegram_id) DO UPDATE SET
      phone = EXCLUDED.phone,
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      photo_url = COALESCE(NULLIF(EXCLUDED.photo_url, ''), users.photo_url),
      last_seen = NOW()
    RETURNING *`,
    [
      telegramId,
      telegramUser.phone,
      telegramUser.username || "",
      telegramUser.firstName || "",
      telegramUser.lastName || "",
      telegramUser.photoUrl || telegramUser.photo || "",
      initialBalance,
      initialNonWithdrawable,
      telegramUser.roomIn || null,
      telegramUser.depositSum,
      telegramUser.createdAt || null,
      telegramUser.lastSeen || null,
    ]
  );
  return mapUser(result.rows[0]);
}

async function createRoom(room) {
  const id = randomUUID();
  const result = await query(
    `INSERT INTO rooms (
      id, name, type, entry_fee, stake, creator_id, visibility, players,
      player_count, max_players, status, room_stats
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *`,
    [
      id,
      room.name,
      room.type,
      room.entryFee,
      room.stake,
      String(room.creatorId),
      room.visibility,
      (room.players || []).map(String),
      room.playerCount,
      room.maxPlayers,
      room.status,
      JSON.stringify(room.roomStats || { gamesPlayed: 0, winnerCounts: {} }),
    ]
  );
  const createdRoom = mapRoom(result.rows[0]);
  await query(
    "UPDATE users SET room_in = $1 WHERE telegram_id = ANY($2::text[])",
    [String(createdRoom.id), (createdRoom.players || []).map(String)]
  );
  return createdRoom;
}

async function createSystemRoomWithAvailableName(room, names) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Transaction-scoped and shared by every application instance using this DB.
    await client.query("SELECT pg_advisory_xact_lock($1)", [73425109]);

    const usedResult = await client.query(
      `SELECT name FROM rooms
      WHERE status IN ('waiting', 'playing', 'ended')
        AND COALESCE(room_stats->>'managedBotRoom', 'false') = 'true'`
    );
    const usedNames = new Set(usedResult.rows.map((row) => row.name));
    const availableNames = names.filter((name) => !usedNames.has(name));
    if (!availableNames.length) {
      await client.query("ROLLBACK");
      return null;
    }

    const name = availableNames[Math.floor(Math.random() * availableNames.length)];
    const id = randomUUID();
    const result = await client.query(
      `INSERT INTO rooms (
        id, name, type, entry_fee, stake, creator_id, visibility, players,
        player_count, max_players, status, room_stats
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        id,
        name,
        room.type,
        room.entryFee,
        room.stake,
        String(room.creatorId),
        room.visibility,
        (room.players || []).map(String),
        room.playerCount,
        room.maxPlayers,
        room.status,
        JSON.stringify(room.roomStats || { gamesPlayed: 0, winnerCounts: {} }),
      ]
    );
    const createdRoom = mapRoom(result.rows[0]);
    await client.query(
      "UPDATE users SET room_in = $1 WHERE telegram_id = ANY($2::text[])",
      [String(createdRoom.id), (createdRoom.players || []).map(String)]
    );
    await client.query("COMMIT");
    return createdRoom;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getRoom(roomId) {
  const result = await query("SELECT * FROM rooms WHERE id = $1", [String(roomId)]);
  return mapRoom(result.rows[0]);
}

async function deleteRoom(roomId, archiveReason = "") {
  await ensureRoomArchiveTable();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const roomResult = await client.query("SELECT * FROM rooms WHERE id = $1 FOR UPDATE", [String(roomId)]);
    const room = roomResult.rows[0];

    if (!room) {
      await client.query("COMMIT");
      return null;
    }

    const roomStats = normalizeRoomStats(room.room_stats || {});
    const finalArchiveReason = archiveReason || roomStats.finalizedReason || "room-deleted";
    const managedBotId = roomStats.managedBotRoom
      ? String(roomStats.botProfile?.id || (room.players || []).find((playerId) => (
        String(playerId).startsWith("botgamer:managed:")
      )) || "")
      : "";

    if (roomHasCompletedGame(roomStats)) {
      await client.query(
        `INSERT INTO archived_rooms (
          id, name, type, entry_fee, stake, creator_id, visibility, created_at,
          players, player_count, max_players, status, room_stats, archived_reason, archived_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          entry_fee = EXCLUDED.entry_fee,
          stake = EXCLUDED.stake,
          creator_id = EXCLUDED.creator_id,
          visibility = EXCLUDED.visibility,
          created_at = EXCLUDED.created_at,
          players = EXCLUDED.players,
          player_count = EXCLUDED.player_count,
          max_players = EXCLUDED.max_players,
          status = EXCLUDED.status,
          room_stats = EXCLUDED.room_stats,
          archived_reason = EXCLUDED.archived_reason,
          archived_at = NOW()`,
        [
          room.id,
          room.name,
          room.type,
          room.entry_fee,
          room.stake,
          room.creator_id,
          room.visibility,
          room.created_at,
          room.players || [],
          room.player_count,
          room.max_players,
          room.status,
          JSON.stringify(roomStats),
          finalArchiveReason,
        ]
      );
    }

    await client.query(
      `UPDATE users
      SET room_in = NULL
      WHERE room_in = $1 OR telegram_id = ANY($2::text[])`,
      [String(roomId), (room.players || []).map(String)]
    );
    await client.query("DELETE FROM rooms WHERE id = $1", [String(roomId)]);
    if (managedBotId.startsWith("botgamer:managed:")) {
      await client.query(
        "DELETE FROM users WHERE telegram_id = $1 AND telegram_id LIKE 'botgamer:managed:%'",
        [managedBotId]
      );
    }
    await client.query("COMMIT");

    return mapRoom({
      ...room,
      room_stats: roomStats,
      is_archived: roomHasCompletedGame(roomStats),
      archived_reason: roomHasCompletedGame(roomStats) ? finalArchiveReason : null,
      archived_at: roomHasCompletedGame(roomStats) ? new Date().toISOString() : null,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateRoomStats(roomId, roomStats) {
  const result = await query(
    "UPDATE rooms SET room_stats = $2 WHERE id = $1 RETURNING *",
    [String(roomId), JSON.stringify(normalizeRoomStats(roomStats))]
  );
  return mapRoom(result.rows[0]);
}

async function getUserActiveRoom(userId, excludeRoomId = null) {
  const params = [String(userId)];
  let excludeClause = "";

  if (excludeRoomId) {
    params.push(String(excludeRoomId));
    excludeClause = "AND id <> $2";
  }

  const result = await query(
    `SELECT * FROM rooms
    WHERE players @> ARRAY[$1::text]
      AND status IN ('waiting', 'playing', 'ended')
      AND COALESCE(room_stats->>'practice', 'false') <> 'true'
      ${excludeClause}
    ORDER BY
      CASE WHEN status = 'playing' THEN 0 WHEN status = 'waiting' THEN 1 ELSE 2 END,
      created_at DESC
    LIMIT 1`,
    params
  );
  return mapRoom(result.rows[0]);
}

async function getCreatorActiveRoom(creatorId) {
  const result = await query(
    `SELECT * FROM rooms
    WHERE creator_id = $1
      AND status IN ('waiting', 'playing', 'ended')
      AND COALESCE(room_stats->>'practice', 'false') <> 'true'
    ORDER BY
      CASE WHEN status = 'playing' THEN 0 WHEN status = 'waiting' THEN 1 ELSE 2 END,
      created_at DESC
    LIMIT 1`,
    [String(creatorId)]
  );
  return mapRoom(result.rows[0]);
}

async function listPublicRooms() {
  const result = await query(
    `SELECT * FROM rooms
    WHERE visibility = 'public'
      AND (
        status = 'waiting' OR
        (status = 'ended' AND COALESCE(room_stats->>'rematchRecruiting', 'false') = 'true')
      )
      AND player_count < max_players
      AND COALESCE(room_stats->>'practice', 'false') <> 'true'
    ORDER BY created_at DESC`
  );
  return result.rows.map(mapRoom);
}

async function getAffordableJoinableHumanRoom(balance) {
  const result = await query(
    `SELECT * FROM rooms
    WHERE visibility = 'public'
      AND status = 'waiting'
      AND player_count < max_players
      AND entry_fee <= $1
      AND COALESCE(room_stats->>'botGame', 'false') <> 'true'
    ORDER BY created_at ASC
    LIMIT 1`,
    [roundMoney(balance)]
  );
  return mapRoom(result.rows[0]);
}

async function getWaitingManagedBotRoomForUser(userId) {
  const result = await query(
    `SELECT * FROM rooms
    WHERE status = 'waiting'
      AND player_count = 1
      AND COALESCE(room_stats->>'managedBotRoom', 'false') = 'true'
      AND room_stats->>'generatedFor' = $1
    ORDER BY created_at DESC
    LIMIT 1`,
    [String(userId)]
  );
  return mapRoom(result.rows[0]);
}

async function listLobbyRooms(userId) {
  if (!userId) return listPublicRooms();

  const result = await query(
    `SELECT * FROM rooms
    WHERE COALESCE(room_stats->>'practice', 'false') <> 'true'
      AND ((
        visibility = 'public'
        AND (
          status = 'waiting' OR
          (status = 'ended' AND COALESCE(room_stats->>'rematchRecruiting', 'false') = 'true')
        )
        AND player_count < max_players
      )
      OR (
        players @> ARRAY[$1::text]
        AND status IN ('waiting', 'playing', 'ended')
      ))
    ORDER BY
      CASE WHEN players @> ARRAY[$1::text] AND status IN ('waiting', 'playing', 'ended') THEN 0 ELSE 1 END,
      created_at DESC`,
    [String(userId)]
  );
  return result.rows.map(mapRoom);
}

async function listActiveRoomsForCleanup(olderThanDate) {
  const result = await query(
    `SELECT * FROM rooms
    WHERE status IN ('waiting', 'playing', 'ended')
      AND created_at <= $1
    ORDER BY created_at ASC`,
    [olderThanDate]
  );
  return result.rows.map(mapRoom);
}

async function updateRoomStatus(roomId, status) {
  const result = await query(
    "UPDATE rooms SET status = $2 WHERE id = $1 RETURNING *",
    [String(roomId), status]
  );
  return mapRoom(result.rows[0]);
}

async function updateRoomRematchConfig(roomId, options = {}) {
  const maxPlayers = options.maxPlayers == null ? null : Number(options.maxPlayers);
  const entryFee = options.entryFee == null ? null : roundMoney(options.entryFee);
  const creatorId = options.creatorId == null ? null : String(options.creatorId);
  const recruiting = Boolean(options.rematchRecruiting);
  const result = await query(
    `UPDATE rooms
    SET max_players = CASE
        WHEN COALESCE(room_stats->>'managedBotRoom', 'false') = 'true' THEN 2
        ELSE COALESCE($2, max_players)
      END,
      type = CASE
        WHEN COALESCE(room_stats->>'managedBotRoom', 'false') = 'true' THEN '2-players'
        WHEN $2 IS NULL THEN type
        ELSE $2::text || '-players'
      END,
      entry_fee = COALESCE($3, entry_fee),
      stake = COALESCE($3, stake),
      creator_id = CASE
        WHEN COALESCE(room_stats->>'managedBotRoom', 'false') = 'true'
          THEN COALESCE(room_stats->'botProfile'->>'id', creator_id)
        ELSE COALESCE($4, creator_id)
      END,
      room_stats = jsonb_set(
        COALESCE(room_stats, '{}'::jsonb),
        '{rematchRecruiting}',
        to_jsonb(CASE
          WHEN COALESCE(room_stats->>'managedBotRoom', 'false') = 'true' THEN false
          ELSE $5::boolean
        END),
        true
      )
    WHERE id = $1
    RETURNING *`,
    [String(roomId), maxPlayers, entryFee, creatorId, recruiting]
  );
  return mapRoom(result.rows[0]);
}

async function addPlayerToRoom(roomId, userId) {
  const result = await query(
    `UPDATE rooms
    SET players = CASE
        WHEN players @> ARRAY[$2::text] THEN players
        ELSE array_append(players, $2::text)
      END,
      player_count = CASE
        WHEN players @> ARRAY[$2::text] THEN player_count
        ELSE player_count + 1
      END
    WHERE id = $1
    RETURNING *`,
    [String(roomId), String(userId)]
  );
  const room = mapRoom(result.rows[0]);
  if (room) {
    await query(
      "UPDATE users SET room_in = $1 WHERE telegram_id = $2",
      [String(roomId), String(userId)]
    );
  }
  return room;
}

async function removePlayerFromRoom(roomId, userId) {
  const result = await query(
    `UPDATE rooms
    SET players = array_remove(players, $2::text),
      player_count = GREATEST(player_count - CASE WHEN players @> ARRAY[$2::text] THEN 1 ELSE 0 END, 0)
    WHERE id = $1
    RETURNING *`,
    [String(roomId), String(userId)]
  );
  await query(
    "UPDATE users SET room_in = NULL WHERE telegram_id = $1 AND room_in = $2",
    [String(userId), String(roomId)]
  );
  return mapRoom(result.rows[0]);
}

async function transitionManagedBotRoomToWaiting({
  roomId,
  humanId,
  botId,
  roomStats,
  replacementFee,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const normalizedStats = normalizeRoomStats({
      ...(roomStats || {}),
      managedBotDeparted: true,
      managedReplacementFee: replacementFee,
    });
    const result = await client.query(
      `UPDATE rooms
      SET creator_id = $2,
        visibility = 'private',
        players = ARRAY[$2::text],
        player_count = 1,
        max_players = 2,
        status = 'waiting',
        room_stats = $3::jsonb
      WHERE id = $1
        AND COALESCE(room_stats->>'managedBotRoom', 'false') = 'true'
      RETURNING *`,
      [String(roomId), String(humanId), JSON.stringify(normalizedStats)]
    );
    if (result.rowCount !== 1) throw new Error("MANAGED_ROOM_TRANSITION_FAILED");

    await client.query(
      "UPDATE users SET room_in = $1 WHERE telegram_id = $2",
      [String(roomId), String(humanId)]
    );
    await client.query(
      "DELETE FROM users WHERE telegram_id = $1 AND telegram_id LIKE 'botgamer:managed:%'",
      [String(botId)]
    );
    await client.query("COMMIT");
    return mapRoom(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function incrementRoomWinStats(roomId, winnerId) {
  const room = await getRoom(roomId);
  if (!room) throw new Error("ROOM_NOT_FOUND");

  const roomStats = room.roomStats || { gamesPlayed: 0, winnerCounts: {} };
  roomStats.gamesPlayed = Number(roomStats.gamesPlayed || 0) + 1;
  roomStats.winnerCounts = roomStats.winnerCounts || {};
  roomStats.winnerCounts[String(winnerId)] = Number(roomStats.winnerCounts[String(winnerId)] || 0) + 1;

  await query("UPDATE rooms SET room_stats = $2 WHERE id = $1", [
    String(roomId),
    JSON.stringify(roomStats),
  ]);
}

async function escrowRoomEntryFees(roomId, playerIds, entryFee) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const roomResult = await client.query("SELECT * FROM rooms WHERE id = $1 FOR UPDATE", [String(roomId)]);
    const room = mapRoom(roomResult.rows[0]);
    if (!room) throw new Error("ROOM_NOT_FOUND");

    const roomStats = normalizeRoomStats(room.roomStats);
    const targetRound = roomStats.gamesPlayed + 1;
    if (roomStats.roundsEscrowed >= targetRound && roomStats.feeEscrowed) {
      await client.query("COMMIT");
      return roomStats;
    }

    const normalizedPlayerIds = playerIds.map(String);
    const fee = roundMoney(entryFee);
    const usersResult = await client.query(
      "SELECT telegram_id, balance, non_withdrawable_balance FROM users WHERE telegram_id = ANY($1::text[]) FOR UPDATE",
      [normalizedPlayerIds]
    );

    const usersById = new Map(usersResult.rows.map((row) => [String(row.telegram_id), row]));
    const missingPlayer = normalizedPlayerIds.find((playerId) => !usersById.has(playerId));
    if (missingPlayer) {
      throw new Error(`PLAYER_NOT_FOUND:${missingPlayer}`);
    }

    const insufficientPlayer = normalizedPlayerIds.find((playerId) => {
      const balance = Number(usersById.get(playerId).balance || 0);
      return balance < fee;
    });
    if (insufficientPlayer) {
      throw new Error(`INSUFFICIENT_BALANCE:${insufficientPlayer}`);
    }

    const currentRoundBonusEscrow = {};
    for (const playerId of normalizedPlayerIds) {
      const playerRow = usersById.get(playerId);
      const bonusUsed = Math.min(parseNumber(playerRow.non_withdrawable_balance), fee);
      if (bonusUsed > 0) {
        currentRoundBonusEscrow[playerId] = bonusUsed;
      }
      await client.query(
        `UPDATE users
        SET balance = balance - $2,
          non_withdrawable_balance = GREATEST(0, non_withdrawable_balance - $3)
        WHERE telegram_id = $1`,
        [playerId, fee, bonusUsed]
      );
      await client.query(
        `INSERT INTO user_game_stats (user_id, amount_played)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET
          amount_played = user_game_stats.amount_played + EXCLUDED.amount_played,
          updated_at = NOW()`,
        [playerId, fee]
      );
    }

    const playerFeesPaid = { ...roomStats.playerFeesPaid };
    normalizedPlayerIds.forEach((playerId) => {
      playerFeesPaid[playerId] = roundMoney(Number(playerFeesPaid[playerId] || 0) + fee);
    });

    const roundPot = roundMoney(fee * normalizedPlayerIds.length);
    let botProfile = roomStats.botProfile;
    if (roomStats.botGame && botProfile?.id) {
      const botResult = await client.query(
        "SELECT balance FROM users WHERE telegram_id = $1",
        [String(botProfile.id)]
      );
      if (botResult.rows[0]) {
        botProfile = {
          ...botProfile,
          balance: parseNumber(botResult.rows[0].balance),
        };
      }
    }
    const nextStats = normalizeRoomStats({
      ...roomStats,
      feeEscrowed: true,
      escrowRefunded: false,
      escrowSettled: false,
      lastSettlement: null,
      escrowPlayers: [...new Set([...(roomStats.escrowPlayers || []), ...normalizedPlayerIds])],
      currentRoundPlayers: normalizedPlayerIds,
      currentRoundBonusEscrow,
      currentRoundPot: roundPot,
      entryFee: fee,
      commissionRate: getCommissionRate(fee, roomStats.gamesPlayed),
      roundsEscrowed: targetRound,
      playerFeesPaid,
      botProfile,
    });

    await client.query("UPDATE rooms SET room_stats = $2 WHERE id = $1", [
      String(roomId),
      JSON.stringify(nextStats),
    ]);

    await client.query("COMMIT");
    return nextStats;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordRoomGameResult(roomId, winnerId, playerIds, options = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const roomResult = await client.query("SELECT * FROM rooms WHERE id = $1 FOR UPDATE", [String(roomId)]);
    const room = mapRoom(roomResult.rows[0]);
    if (!room) throw new Error("ROOM_NOT_FOUND");

    const roomStats = normalizeRoomStats(room.roomStats);

    // Idempotent: only settle once while fees are still escrowed for this round.
    if (!roomStats.feeEscrowed || roomStats.escrowSettled || roomStats.escrowRefunded) {
      await client.query("COMMIT");
      return normalizeRoomStats(roomStats);
    }

    const roundNumber = roomStats.gamesPlayed + 1;
    const normalizedWinnerId = String(winnerId);
    const normalizedPlayerIds = (playerIds || []).map(String);
    const roundPlayers = roomStats.currentRoundPlayers.length
      ? roomStats.currentRoundPlayers
      : normalizedPlayerIds;
    const roundPot = roundMoney(
      roomStats.currentRoundPot > 0
        ? roomStats.currentRoundPot
        : roomStats.entryFee * Math.max(roundPlayers.length, 1)
    );
    if (roundPot <= 0) {
      throw new Error("ROUND_POT_EMPTY");
    }

    const commissionRate = getCommissionRate(roomStats.entryFee, roundNumber);
    const commissionAmount = calculateCommissionAmount(roundPot, roomStats.entryFee, roundNumber);
    const winnerPayout = roundMoney(roundPot - commissionAmount);

    const payoutResult = await client.query(
      "UPDATE users SET balance = balance + $2 WHERE telegram_id = $1 RETURNING balance",
      [normalizedWinnerId, winnerPayout]
    );
    if (payoutResult.rowCount !== 1) {
      throw new Error(`WINNER_NOT_FOUND:${normalizedWinnerId}`);
    }

    roomStats.gamesPlayed = roundNumber;
    roomStats.winnerCounts[normalizedWinnerId] = Number(roomStats.winnerCounts[normalizedWinnerId] || 0) + 1;
    roomStats.winnerWeights = roomStats.winnerWeights || {};
    const winWeight = options.jokerBonus ? 2 : 1;
    roomStats.winnerWeights[normalizedWinnerId] = roundMoney(Number(roomStats.winnerWeights[normalizedWinnerId] || 0) + winWeight);
    roomStats.totalPot = roundMoney(Number(roomStats.totalPot || 0) + roundPot);
    roomStats.commissionAmount = roundMoney(Number(roomStats.commissionAmount || 0) + commissionAmount);
    roomStats.commissionRate = commissionRate;
    roomStats.payouts = {
      ...(roomStats.payouts || {}),
      [normalizedWinnerId]: roundMoney(Number(roomStats.payouts?.[normalizedWinnerId] || 0) + winnerPayout),
    };
    if (roomStats.botGame) {
      const botWon = normalizedWinnerId.startsWith("botgamer:");
      roomStats.botResults = {
        gamesPlayed: Number(roomStats.botResults?.gamesPlayed || 0) + 1,
        wins: Number(roomStats.botResults?.wins || 0) + (botWon ? 1 : 0),
        losses: Number(roomStats.botResults?.losses || 0) + (botWon ? 0 : 1),
      };
      if (roomStats.botProfile?.id) {
        const botResult = await client.query(
          "SELECT balance FROM users WHERE telegram_id = $1",
          [String(roomStats.botProfile.id)]
        );
        if (botResult.rows[0]) {
          roomStats.botProfile = {
            ...roomStats.botProfile,
            balance: parseNumber(botResult.rows[0].balance),
          };
        }
      }
    }
    roomStats.topWinnerIds = Object.entries(roomStats.winnerWeights)
      .sort(([, a], [, b]) => Number(b || 0) - Number(a || 0))
      .map(([playerId]) => playerId);
    const settledAt = new Date().toISOString();
    roomStats.games.push({
      round: roundNumber,
      players: roundPlayers,
      entryFee: roomStats.entryFee,
      roundAmountToWin: roundPot,
      roundCommission: commissionAmount,
      commissionRate,
      roundPayout: winnerPayout,
      totalAmountToWin: roomStats.totalPot,
      winnerId: normalizedWinnerId,
      jokerBonus: Boolean(options.jokerBonus),
      winWeight,
      completedAt: settledAt,
    });
    roomStats.lastSettlement = {
      round: roundNumber,
      winnerId: normalizedWinnerId,
      roundPot,
      commissionAmount,
      commissionRate,
      winnerPayout,
      settledAt,
    };
    roomStats.feeEscrowed = false;
    roomStats.currentRoundPlayers = [];
    roomStats.currentRoundBonusEscrow = {};
    roomStats.currentRoundPot = 0;
    roomStats.escrowRefunded = false;
    roomStats.escrowSettled = true;

    const normalized = normalizeRoomStats(roomStats);
    await client.query("UPDATE rooms SET room_stats = $2 WHERE id = $1", [
      String(roomId),
      JSON.stringify(normalized),
    ]);

    await client.query(
      `INSERT INTO user_game_stats (user_id, games_played, wins)
      SELECT id, 1, CASE WHEN id = $2 AND id NOT LIKE 'botgamer:%' THEN 1 ELSE 0 END
      FROM UNNEST($1::text[]) AS ids(id)
      ON CONFLICT (user_id) DO UPDATE SET
        games_played = user_game_stats.games_played + 1,
        wins = user_game_stats.wins + EXCLUDED.wins,
        updated_at = NOW()`,
      [roundPlayers, normalizedWinnerId]
    );
    await client.query(
      `INSERT INTO user_game_activity_days (user_id, played_on, games_played)
      SELECT id, (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date, 1
      FROM UNNEST($1::text[]) AS ids(id)
      WHERE id NOT LIKE 'botgamer:%'
      ON CONFLICT (user_id, played_on) DO UPDATE SET
        games_played = user_game_activity_days.games_played + 1`,
      [roundPlayers]
    );

    if (options.managedBonusIntroPlayerId) {
      await client.query(
        `UPDATE user_game_stats
        SET managed_bonus_intro_games = LEAST(3, managed_bonus_intro_games + 1),
          updated_at = NOW()
        WHERE user_id = $1 AND managed_bonus_intro_started = TRUE`,
        [String(options.managedBonusIntroPlayerId)]
      );
    }

    await client.query("COMMIT");
    return normalized;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeRoomLedger(roomId, reason = "room-finalized", options = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const roomResult = await client.query("SELECT * FROM rooms WHERE id = $1 FOR UPDATE", [String(roomId)]);
    const room = mapRoom(roomResult.rows[0]);
    if (!room) {
      await client.query("COMMIT");
      return null;
    }

    const roomStats = normalizeRoomStats(room.roomStats);
    if (!roomStats.feeEscrowed || roomStats.escrowRefunded) {
      await client.query("COMMIT");
      return roomStats;
    }

    const refundPlayerIds = roomStats.currentRoundPlayers.length
      ? roomStats.currentRoundPlayers
      : (roomStats.escrowPlayers.length ? roomStats.escrowPlayers : (room.players || []).map(String));
    const requestedPenaltyPlayerId = options.leavePenaltyPlayerId
      ? String(options.leavePenaltyPlayerId)
      : null;
    const requestedPenaltyRate = Math.min(1, Math.max(0, Number(options.leavePenaltyRate || 0)));
    const penaltyApplies = Boolean(
      requestedPenaltyPlayerId &&
      requestedPenaltyRate > 0 &&
      room.status === "playing" &&
      refundPlayerIds.some((playerId) => String(playerId) === requestedPenaltyPlayerId)
    );
    const refundEntries = refundPlayerIds.map((playerId) => {
      const refundRate = penaltyApplies && String(playerId) === requestedPenaltyPlayerId
        ? 1 - requestedPenaltyRate
        : 1;
      return [playerId, roundMoney(roomStats.entryFee * refundRate), refundRate];
    });
    const bonusRefundEntries = [];

    for (const [playerId, refundAmount, refundRate] of refundEntries) {
      const bonusRefundAmount = Math.min(
        roundMoney(Number(roomStats.currentRoundBonusEscrow?.[playerId] || 0) * refundRate),
        roundMoney(refundAmount)
      );
      if (bonusRefundAmount > 0) {
        bonusRefundEntries.push([playerId, bonusRefundAmount]);
      }
      await client.query(
        `UPDATE users
        SET balance = balance + $2,
          non_withdrawable_balance = LEAST(balance + $2, non_withdrawable_balance + $3)
        WHERE telegram_id = $1`,
        [playerId, refundAmount, bonusRefundAmount]
      );
    }

    roomStats.escrowRefunded = true;
    roomStats.feeEscrowed = false;
    roomStats.currentRoundPlayers = [];
    roomStats.currentRoundBonusEscrow = {};
    roomStats.currentRoundPot = 0;
    roomStats.finalizedReason = reason;
    roomStats.finalizedAt = new Date().toISOString();
    if (penaltyApplies) {
      const penaltyAmount = roundMoney(roomStats.entryFee * requestedPenaltyRate);
      const leavePenalty = {
        playerId: requestedPenaltyPlayerId,
        entryFee: roomStats.entryFee,
        rate: requestedPenaltyRate,
        amount: penaltyAmount,
        reason: options.leavePenaltyReason || reason,
        appliedAt: roomStats.finalizedAt,
      };
      roomStats.leavePenaltyAmount = roundMoney(
        Number(roomStats.leavePenaltyAmount || 0) + penaltyAmount
      );
      roomStats.leavePenalties = [...(roomStats.leavePenalties || []), leavePenalty];
      roomStats.lastLeavePenalty = leavePenalty;
    }
    roomStats.refunds = {
      ...(roomStats.refunds || {}),
      ...Object.fromEntries(refundEntries.map(([playerId, amount]) => [playerId, roundMoney(amount)])),
    };
    roomStats.bonusRefunds = {
      ...(roomStats.bonusRefunds || {}),
      ...Object.fromEntries(bonusRefundEntries.map(([playerId, amount]) => [playerId, roundMoney(amount)])),
    };

    await client.query("UPDATE rooms SET room_stats = $2 WHERE id = $1", [
      String(roomId),
      JSON.stringify(roomStats),
    ]);

    await client.query("COMMIT");
    return roomStats;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function transactionExists(transactionId) {
  await ensureAppSchema();
  const result = await query("SELECT 1 FROM transactions WHERE id = $1", [String(transactionId)]);
  return result.rowCount > 0;
}

async function saveDepositTransaction(transactionId, userId, amount) {
  await ensureAppSchema();
  const birrAmount = roundMoney(amount);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO transactions (id, user_id, amount)
      VALUES ($1, $2, $3)`,
      [String(transactionId), String(userId), birrAmount]
    );
    await client.query(
      `INSERT INTO stats (key, total_amount, count)
      VALUES ('deposits', $1, 1)
      ON CONFLICT (key) DO UPDATE SET
        total_amount = stats.total_amount + EXCLUDED.total_amount,
        count = stats.count + 1`,
      [birrAmount]
    );
    await client.query(
      `INSERT INTO users (telegram_id, balance)
      VALUES ($1, $2)
      ON CONFLICT (telegram_id) DO UPDATE SET
        balance = users.balance + EXCLUDED.balance`,
      [String(userId), birrAmount]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function addBalance(userId, amount) {
  const birrAmount = roundMoney(amount);
  await query(
    `INSERT INTO users (telegram_id, balance)
    VALUES ($1, $2)
    ON CONFLICT (telegram_id) DO UPDATE SET
      balance = users.balance + EXCLUDED.balance`,
    [String(userId), birrAmount]
  );
}

async function getWithdrawalsEnabled(queryFn = query) {
  const result = await queryFn(
    "SELECT value FROM app_settings WHERE key = 'withdrawals_enabled'"
  );
  return result.rows[0]?.value !== "false";
}

async function setWithdrawalsEnabled(enabled) {
  const result = await query(
    `INSERT INTO app_settings (key, value, updated_at)
    VALUES ('withdrawals_enabled', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    RETURNING value, updated_at`,
    [enabled ? "true" : "false"]
  );
  return {
    enabled: result.rows[0]?.value !== "false",
    updatedAt: result.rows[0]?.updated_at || null,
  };
}

async function getWithdrawalRequest(requestId, queryFn = query) {
  const result = await queryFn(
    `SELECT wr.*, COALESCE(u.display_name, u.first_name, u.username, 'User') AS user_name
    FROM withdrawal_requests wr
    LEFT JOIN users u ON u.telegram_id = wr.user_id
    WHERE wr.id = $1`,
    [String(requestId)]
  );
  return mapWithdrawalRequest(result.rows[0]);
}

async function listWithdrawalRequests({ limit = 200 } = {}, queryFn = query) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 200)));
  const result = await queryFn(
    `SELECT wr.*, COALESCE(u.display_name, u.first_name, u.username, 'User') AS user_name
    FROM withdrawal_requests wr
    LEFT JOIN users u ON u.telegram_id = wr.user_id
    ORDER BY wr.requested_at DESC
    LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map(mapWithdrawalRequest);
}

async function getWithdrawalSummary(queryFn = query) {
  const result = await queryFn(`
    SELECT
      COALESCE(SUM(amount), 0) AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
    FROM withdrawal_requests
  `);
  return {
    totalWithdrawals: roundMoney(result.rows[0]?.total),
    pendingWithdrawalCount: Number(result.rows[0]?.pending_count || 0),
  };
}

async function completeWithdrawalRequest(requestId) {
  const result = await query(
    `UPDATE withdrawal_requests
    SET status = 'sent', completed_at = COALESCE(completed_at, NOW())
    WHERE id = $1
    RETURNING *`,
    [String(requestId)]
  );
  if (!result.rows[0]) throw new Error("WITHDRAWAL_REQUEST_NOT_FOUND");
  return mapWithdrawalRequest(result.rows[0]);
}

async function claimWithdrawalUserNotification(requestId) {
  const result = await query(
    `UPDATE withdrawal_requests
    SET user_notification_started_at = NOW()
    WHERE id = $1
      AND user_notified_at IS NULL
      AND (
        user_notification_started_at IS NULL
        OR user_notification_started_at < NOW() - INTERVAL '5 minutes'
      )
    RETURNING *`,
    [String(requestId)]
  );
  return mapWithdrawalRequest(result.rows[0]);
}

async function releaseWithdrawalUserNotification(requestId, errorMessage = "") {
  const result = await query(
    `UPDATE withdrawal_requests
    SET user_notification_started_at = NULL,
      notification_error = $2
    WHERE id = $1
    RETURNING *`,
    [String(requestId), String(errorMessage).slice(0, 500)]
  );
  return mapWithdrawalRequest(result.rows[0]);
}

async function updateWithdrawalNotification(requestId, fields = {}) {
  const result = await query(
    `UPDATE withdrawal_requests
    SET admin_notified_at = CASE WHEN $2::boolean THEN COALESCE(admin_notified_at, NOW()) ELSE admin_notified_at END,
      telegram_admin_message_id = COALESCE($3, telegram_admin_message_id),
      notification_error = COALESCE($4, notification_error),
      user_notified_at = CASE WHEN $5::boolean THEN COALESCE(user_notified_at, NOW()) ELSE user_notified_at END,
      user_notification_started_at = CASE WHEN $5::boolean THEN NULL ELSE user_notification_started_at END
    WHERE id = $1
    RETURNING *`,
    [
      String(requestId),
      Boolean(fields.adminNotified),
      fields.telegramAdminMessageId == null ? null : String(fields.telegramAdminMessageId),
      fields.notificationError == null ? null : String(fields.notificationError).slice(0, 500),
      Boolean(fields.userNotified),
    ]
  );
  return mapWithdrawalRequest(result.rows[0]);
}

async function withdrawBalance(userId, amount, phone, options = {}) {
  const birrAmount = roundMoney(amount);
  const normalizedPhone = String(phone || "").trim().replace(/\s+/g, " ");
  const requestId = String(options.requestId || randomUUID());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const availability = await client.query(
      "SELECT value FROM app_settings WHERE key = 'withdrawals_enabled' FOR SHARE"
    );
    if (availability.rows[0]?.value === "false") {
      throw new Error("WITHDRAWALS_DISABLED");
    }

    const existing = await client.query(
      "SELECT * FROM withdrawal_requests WHERE id = $1",
      [requestId]
    );
    if (existing.rows[0]) {
      const request = mapWithdrawalRequest(existing.rows[0]);
      if (
        request.userId !== String(userId)
        || request.amount !== birrAmount
        || request.phone !== normalizedPhone
      ) {
        throw new Error("WITHDRAWAL_REQUEST_CONFLICT");
      }
      await client.query("COMMIT");
      return {
        request,
        duplicate: true,
        currentBalance: request.balanceBefore,
        withdrawableBalance: request.balanceBefore,
        nonWithdrawableBalance: Math.max(0, request.balanceAfter - request.withdrawableBalanceAfter),
        totalWithdrawn: 0,
        nextBalance: request.balanceAfter,
        nextWithdrawableBalance: request.withdrawableBalanceAfter,
        nextMaxWithdraw: Math.max(
          0,
          Math.min(
            request.withdrawableBalanceAfter,
            request.balanceAfter - MIN_REMAINING_BALANCE_BIRR
          )
        ),
        phone: request.phone,
      };
    }

    const result = await client.query(
      `SELECT u.*, COALESCE(ugs.games_played, 0) AS games_played,
        EXISTS (
          SELECT 1
          FROM transactions deposit
          WHERE deposit.user_id = u.telegram_id
            AND deposit.amount > 0
        ) AS has_positive_deposit,
        COALESCE((
          SELECT COUNT(*)
          FROM user_game_activity_days activity
          WHERE activity.user_id = u.telegram_id
        ), 0) AS play_days
      FROM users AS u
      LEFT JOIN user_game_stats AS ugs ON ugs.user_id = u.telegram_id
      WHERE u.telegram_id = $1
      FOR UPDATE OF u`,
      [String(userId)]
    );

    if (!result.rows[0]) throw new Error("USER_NOT_FOUND");

    const userRow = result.rows[0];
    if (userRow.has_positive_deposit !== true && userRow.has_positive_deposit !== "true") {
      throw new Error("WITHDRAWAL_DEPOSIT_REQUIRED");
    }
    const gamesPlayed = Math.max(0, Math.floor(parseNumber(userRow.games_played)));
    const playDays = Math.max(0, Math.floor(parseNumber(userRow.play_days)));
    if (gamesPlayed < MIN_WITHDRAWAL_GAMES || playDays < MIN_WITHDRAWAL_PLAY_DAYS) {
      const error = new Error("WITHDRAWAL_ACTIVITY_REQUIRED");
      error.gamesPlayed = gamesPlayed;
      error.gamesRequired = MIN_WITHDRAWAL_GAMES;
      error.remainingGames = Math.max(0, MIN_WITHDRAWAL_GAMES - gamesPlayed);
      error.playDays = playDays;
      error.playDaysRequired = MIN_WITHDRAWAL_PLAY_DAYS;
      error.remainingPlayDays = Math.max(0, MIN_WITHDRAWAL_PLAY_DAYS - playDays);
      throw error;
    }

    const dailyWithdrawalResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS withdrawn_today
      FROM withdrawal_requests
      WHERE user_id = $1
        AND requested_at >= (
          date_trunc('day', NOW() AT TIME ZONE 'Africa/Addis_Ababa')
          AT TIME ZONE 'Africa/Addis_Ababa'
        )`,
      [String(userId)]
    );
    const withdrawnToday = roundMoney(dailyWithdrawalResult.rows[0]?.withdrawn_today);
    if (roundMoney(withdrawnToday + birrAmount) > DAILY_WITHDRAWAL_LIMIT_BIRR) {
      const error = new Error("WITHDRAWAL_DAILY_LIMIT_EXCEEDED");
      error.dailyLimit = DAILY_WITHDRAWAL_LIMIT_BIRR;
      throw error;
    }

    const user = mapUser(userRow);
    const maxWithdraw = Math.max(
      0,
      Math.min(user.withdrawableBalance, user.balance - MIN_REMAINING_BALANCE_BIRR)
    );
    if (user.withdrawableBalance < birrAmount) {
      const error = new Error("INSUFFICIENT_WITHDRAWABLE_BALANCE");
      error.withdrawableBalance = user.withdrawableBalance;
      error.nonWithdrawableBalance = user.nonWithdrawableBalance;
      error.maxWithdraw = maxWithdraw;
      throw error;
    }

    const nextBalance = user.balance - birrAmount;
    if (nextBalance < MIN_REMAINING_BALANCE_BIRR) {
      const error = new Error("WITHDRAWAL_MIN_BALANCE_REQUIRED");
      error.currentBalance = user.balance;
      error.minimumRemainingBalance = MIN_REMAINING_BALANCE_BIRR;
      error.maxWithdraw = maxWithdraw;
      throw error;
    }

    const nextTotalWithdrawn = roundMoney(
      parseNumber(user.totalWithdrawn) + birrAmount
    );
    await client.query(
      `UPDATE users
      SET balance = $2, phone = $3, total_withdrawn = $4
      WHERE telegram_id = $1`,
      [String(userId), nextBalance, normalizedPhone, nextTotalWithdrawn]
    );
    const nextWithdrawableBalance = Math.max(nextBalance - user.nonWithdrawableBalance, 0);
    const requestResult = await client.query(
      `INSERT INTO withdrawal_requests (
        id, user_id, phone, amount, balance_before, balance_after, withdrawable_balance_after
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        requestId,
        String(userId),
        normalizedPhone,
        birrAmount,
        user.balance,
        nextBalance,
        nextWithdrawableBalance,
      ]
    );
    await client.query("COMMIT");

    return {
      request: mapWithdrawalRequest(requestResult.rows[0]) || mapWithdrawalRequest({
        id: requestId,
        user_id: String(userId),
        phone: normalizedPhone,
        amount: birrAmount,
        balance_before: user.balance,
        balance_after: nextBalance,
        withdrawable_balance_after: nextWithdrawableBalance,
        status: "pending",
      }),
      duplicate: false,
      currentBalance: user.balance,
      withdrawableBalance: user.withdrawableBalance,
      nonWithdrawableBalance: user.nonWithdrawableBalance,
      totalWithdrawn: nextTotalWithdrawn,
      nextBalance,
      nextWithdrawableBalance,
      nextMaxWithdraw: Math.max(
        0,
        Math.min(
          Math.max(nextBalance - user.nonWithdrawableBalance, 0),
          nextBalance - MIN_REMAINING_BALANCE_BIRR
        )
      ),
      gamesPlayed,
      playDays,
      phone: normalizedPhone,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureReferralTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS referral_links (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      link TEXT NOT NULL,
      reward_count INTEGER NOT NULL DEFAULT 0,
      max_rewards INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("ALTER TABLE referral_links ADD COLUMN IF NOT EXISTS share_count INTEGER NOT NULL DEFAULT 0");
  await query("CREATE INDEX IF NOT EXISTS idx_referral_links_user_id ON referral_links (user_id)");
  await query(`
    CREATE TABLE IF NOT EXISTS referral_awards (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL REFERENCES referral_links(code) ON DELETE CASCADE,
      referrer_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      referred_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      amount NUMERIC(16, 4) NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (code, referred_user_id)
    )
  `);
  await query("ALTER TABLE referral_awards ALTER COLUMN amount TYPE NUMERIC(16, 4) USING amount::NUMERIC(16, 4)");
}

async function ensureRoomArchiveTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS archived_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      entry_fee NUMERIC(16, 4) NOT NULL DEFAULT 0,
      stake NUMERIC(16, 4) NOT NULL DEFAULT 0,
      creator_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      players TEXT[] NOT NULL DEFAULT '{}',
      player_count INTEGER NOT NULL DEFAULT 0,
      max_players INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'ended',
      room_stats JSONB NOT NULL DEFAULT '{"gamesPlayed":0,"winnerCounts":{}}'::jsonb,
      archived_reason TEXT NOT NULL DEFAULT 'room-deleted',
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("ALTER TABLE archived_rooms ALTER COLUMN entry_fee TYPE NUMERIC(16, 4) USING entry_fee::NUMERIC(16, 4)");
  await query("ALTER TABLE archived_rooms ALTER COLUMN stake TYPE NUMERIC(16, 4) USING stake::NUMERIC(16, 4)");
  await query("CREATE INDEX IF NOT EXISTS idx_archived_rooms_archived_at ON archived_rooms (archived_at DESC)");
}

async function ensureAdminContentTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_posters (
      id BIGSERIAL PRIMARY KEY,
      image_url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      target_url TEXT NOT NULL DEFAULT '',
      alt_text TEXT NOT NULL DEFAULT '',
      show_overlay BOOLEAN NOT NULL DEFAULT TRUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("ALTER TABLE admin_posters ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE admin_posters ADD COLUMN IF NOT EXISTS detail TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE admin_posters ADD COLUMN IF NOT EXISTS target_url TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE admin_posters ADD COLUMN IF NOT EXISTS alt_text TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE admin_posters ADD COLUMN IF NOT EXISTS show_overlay BOOLEAN NOT NULL DEFAULT TRUE");
  await query("CREATE INDEX IF NOT EXISTS idx_admin_posters_active ON admin_posters (is_active, sort_order, created_at DESC)");

  // Seed default social lobby banners once (admin can edit/delete after)
  const posterCount = await query("SELECT COUNT(*)::int AS count FROM admin_posters");
  if (Number(posterCount.rows[0]?.count || 0) === 0) {
    const defaults = [
      {
        image: "/lobby-tiktok-cartagame.jpg",
        title: "@cartagame",
        platform: "TikTok",
        detail: "tiktok.com/@cartagame",
        url: "https://www.tiktok.com/@cartagame",
        alt: "Carta on TikTok",
        sort: 0,
      },
      {
        image: "/lobby-instagram-carta_game.jpg",
        title: "@carta_game",
        platform: "Instagram",
        detail: "instagram.com/carta_game",
        url: "https://www.instagram.com/carta_game",
        alt: "Carta on Instagram",
        sort: 1,
      },
      {
        image: "/lobby-facebook-carta.jpg",
        title: "Carta",
        platform: "Facebook",
        detail: "Search Carta",
        url: "https://www.facebook.com/search/top?q=carta",
        alt: "Carta on Facebook",
        sort: 2,
      },
    ];
    for (const poster of defaults) {
      await query(
        `INSERT INTO admin_posters
          (image_url, title, platform, detail, target_url, alt_text, show_overlay, is_active, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, $7)`,
        [
          poster.image,
          poster.title,
          poster.platform,
          poster.detail,
          poster.url,
          poster.alt,
          poster.sort,
        ]
      );
    }
  }

  await query(`
    CREATE TABLE IF NOT EXISTS deposit_numbers (
      id BIGSERIAL PRIMARY KEY,
      phone_number TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("CREATE INDEX IF NOT EXISTS idx_deposit_numbers_active ON deposit_numbers (is_active, sort_order, created_at DESC)");

  await query(`
    CREATE TABLE IF NOT EXISTS admin_messages (
      id BIGSERIAL PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      button_text TEXT NOT NULL DEFAULT '',
      web_app_url TEXT NOT NULL DEFAULT '',
      target_mode TEXT NOT NULL DEFAULT 'filtered',
      target_count INTEGER NOT NULL DEFAULT 0,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS button_text TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS web_app_url TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'");
  await query("ALTER TABLE admin_messages ALTER COLUMN status SET DEFAULT 'queued'");
  await query("ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ");
  await query("ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ");

  await query(`
    CREATE TABLE IF NOT EXISTS admin_message_recipients (
      id BIGSERIAL PRIMARY KEY,
      message_id BIGINT NOT NULL REFERENCES admin_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      sent_at TIMESTAMPTZ
    )
  `);
  await query("ALTER TABLE admin_message_recipients ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE admin_message_recipients ADD COLUMN IF NOT EXISTS delivery_step TEXT NOT NULL DEFAULT 'initial'");
  await query("ALTER TABLE admin_message_recipients ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("CREATE INDEX IF NOT EXISTS idx_admin_message_recipients_message ON admin_message_recipients (message_id)");
  await query("CREATE INDEX IF NOT EXISTS idx_admin_message_recipients_pending ON admin_message_recipients (status, next_attempt_at, id)");
}

function sanitizeBotUsername(value) {
  const username = String(value || "").replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : "";
}

function buildReferralLink(code, origin, botUsername) {
  const cleanBotUsername = sanitizeBotUsername(botUsername || process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME);
  if (cleanBotUsername) {
    return `https://t.me/${cleanBotUsername}?start=ref_${encodeURIComponent(code)}`;
  }

  const cleanOrigin = String(origin || "").startsWith("http")
    ? String(origin).replace(/\/$/, "")
    : "";
  return `${cleanOrigin || "https://t.me"}?ref=${encodeURIComponent(code)}`;
}

async function createReferralLink(userId, options = {}) {
  await ensureReferralTables();
  await ensureUser(userId);

  const existing = await query("SELECT * FROM referral_links WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [
    String(userId),
  ]);

  if (existing.rows[0]) {
    const link = buildReferralLink(existing.rows[0].code, options.origin, options.botUsername);
    const updated = await query(
      `UPDATE referral_links
      SET link = $2, share_count = share_count + 1, updated_at = NOW()
      WHERE code = $1
      RETURNING *`,
      [existing.rows[0].code, link]
    );
    return updated.rows[0];
  }

  const code = randomUUID().replace(/-/g, "").slice(0, 18);
  const link = buildReferralLink(code, options.origin, options.botUsername);
  const result = await query(
    `INSERT INTO referral_links (code, user_id, link, share_count)
    VALUES ($1, $2, $3, 1)
    RETURNING *`,
    [code, String(userId), link]
  );
  return result.rows[0];
}

async function getReferralLink(code) {
  await ensureReferralTables();
  const cleanCode = String(code || "").replace(/^ref_/, "").trim();
  if (!cleanCode) return null;

  const result = await query(
    "SELECT * FROM referral_links WHERE code = $1 LIMIT 1",
    [cleanCode]
  );
  return result.rows[0] || null;
}

async function awardReferralIfEligible(code, referredUserId) {
  await ensureReferralTables();
  const cleanCode = String(code || "").replace(/^ref_/, "");
  const cleanReferredUserId = String(referredUserId || "");
  if (!cleanCode || !cleanReferredUserId) {
    return { awarded: false, reason: "missing-referral-data" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const linkResult = await client.query(
      "SELECT * FROM referral_links WHERE code = $1 FOR UPDATE",
      [cleanCode]
    );
    const referralLink = linkResult.rows[0];
    if (!referralLink) {
      await client.query("COMMIT");
      return { awarded: false, reason: "referral-link-not-found" };
    }

    if (String(referralLink.user_id) === cleanReferredUserId) {
      await client.query("COMMIT");
      return { awarded: false, reason: "self-referral" };
    }

    if (Number(referralLink.reward_count || 0) >= Number(referralLink.max_rewards || 5)) {
      await client.query("COMMIT");
      return { awarded: false, reason: "referral-limit-reached" };
    }

    await client.query(
      `INSERT INTO users (telegram_id, balance, non_withdrawable_balance)
      VALUES ($1, $2, $2)
      ON CONFLICT (telegram_id) DO NOTHING`,
      [cleanReferredUserId, WELCOME_GIFT_BIRR]
    );

    const existingAward = await client.query(
      "SELECT 1 FROM referral_awards WHERE code = $1 AND referred_user_id = $2",
      [cleanCode, cleanReferredUserId]
    );
    if (existingAward.rowCount > 0) {
      await client.query("COMMIT");
      return { awarded: false, reason: "already-awarded" };
    }

    await client.query(
      `INSERT INTO referral_awards (code, referrer_id, referred_user_id, amount)
      VALUES ($1, $2, $3, $4)`,
      [cleanCode, String(referralLink.user_id), cleanReferredUserId, REFERRAL_REWARD_BIRR]
    );
    const referredUserResult = await client.query(
      "SELECT username, display_name, first_name FROM users WHERE telegram_id = $1",
      [cleanReferredUserId]
    );
    const referredUser = referredUserResult.rows[0] || {};
    const referredUserName = referredUser.display_name || referredUser.first_name || referredUser.username || "A new player";
    const notificationResult = await client.query(
      `INSERT INTO user_notifications (user_id, type, data)
      VALUES ($1, 'referral_reward', $2::jsonb)
      RETURNING *`,
      [String(referralLink.user_id), JSON.stringify({
        amount: REFERRAL_REWARD_BIRR,
        referredUserId: cleanReferredUserId,
        referredUserName,
      })]
    );
    await client.query(
      `UPDATE users
      SET balance = balance + $2,
        non_withdrawable_balance = non_withdrawable_balance + $2
      WHERE telegram_id = $1`,
      [String(referralLink.user_id), REFERRAL_REWARD_BIRR]
    );
    const updatedLink = await client.query(
      `UPDATE referral_links
      SET reward_count = reward_count + 1, updated_at = NOW()
      WHERE code = $1
      RETURNING *`,
      [cleanCode]
    );

    await client.query("COMMIT");
    return {
      awarded: true,
      amount: REFERRAL_REWARD_BIRR,
      referrerId: String(referralLink.user_id),
      rewardCount: Number(updatedLink.rows[0]?.reward_count || 0),
      maxRewards: Number(updatedLink.rows[0]?.max_rewards || 5),
      notification: mapNotification(notificationResult.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return { awarded: false, reason: "already-awarded" };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getCommissionRate,
  calculateCommissionAmount,
  ensureAppSchema,
  getUser,
  ensureUser,
  createSyntheticBot,
  ensureSyntheticBotBalance,
  deleteSyntheticBot,
  upsertUser,
  updateUserDisplayName,
  acknowledgeWelcomeGift,
  getUnreadNotifications,
  acknowledgeNotification,
  getPublicUsers,
  getUserProfile,
  getUserGameStats,
  latchManagedBonusIntro,
  createRoom,
  createSystemRoomWithAvailableName,
  getRoom,
  deleteRoom,
  updateRoomStats,
  getCreatorActiveRoom,
  getUserActiveRoom,
  listPublicRooms,
  getAffordableJoinableHumanRoom,
  getWaitingManagedBotRoomForUser,
  listLobbyRooms,
  listActiveRoomsForCleanup,
  addPlayerToRoom,
  removePlayerFromRoom,
  transitionManagedBotRoomToWaiting,
  updateRoomStatus,
  updateRoomRematchConfig,
  incrementRoomWinStats,
  escrowRoomEntryFees,
  recordRoomGameResult,
  finalizeRoomLedger,
  transactionExists,
  saveDepositTransaction,
  addBalance,
  claimWithdrawalUserNotification,
  completeWithdrawalRequest,
  getWithdrawalRequest,
  getWithdrawalSummary,
  getWithdrawalsEnabled,
  listWithdrawalRequests,
  mapWithdrawalRequest,
  releaseWithdrawalUserNotification,
  setWithdrawalsEnabled,
  updateWithdrawalNotification,
  withdrawBalance,
  createReferralLink,
  getReferralLink,
  awardReferralIfEligible,
};
