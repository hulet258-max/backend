const { randomUUID } = require("crypto");
const { pool, query } = require("../config/postgres");
const {
  REFERRAL_REWARD_COINS,
  WELCOME_GIFT_COINS,
} = require("../config/economy");

let schemaReadyPromise = null;

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function mapUser(row) {
  if (!row) return null;
  const telegramId = String(row.telegram_id);
  return {
    id: telegramId,
    telegramId,
    phone: row.phone,
    username: row.username || "",
    displayName: row.display_name || row.username || row.first_name || `Player ${telegramId.slice(-4)}`,
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    balance: parseNumber(row.balance),
    roomIn: row.room_in,
    depositSum: parseNumber(row.deposit_sum),
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

function mapPublicUser(row) {
  if (!row) return null;
  const telegramId = String(row.telegram_id);
  return {
    telegramId,
    displayName: row.display_name || row.username || row.first_name || `Player ${telegramId.slice(-4)}`,
    firstName: row.first_name || "",
    username: row.username || "",
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
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function getCommissionRate(entryFee, gamesPlayed = 0) {
  const fee = roundMoney(entryFee);
  if (fee <= 0) return 0;
  let rate = 0.02;
  if (fee >= 250) rate = 0.12;
  else if (fee >= 100) rate = 0.1;
  else if (fee >= 50) rate = 0.08;
  else if (fee >= 25) rate = 0.06;
  else if (fee >= 10) rate = 0.04;

  const playedGrowth = Math.max(Number(gamesPlayed || 0), 0) * 0.01;
  return Math.min(rate + playedGrowth, 0.25);
}

function calculateCommissionAmount(totalPot, entryFee, gamesPlayed = 0) {
  const pot = roundMoney(totalPot);
  if (pot <= 0) return 0;
  return Math.min(pot, Math.max(1, Math.ceil(pot * getCommissionRate(entryFee, gamesPlayed))));
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
    currentRoundPot: roundMoney(stats.currentRoundPot || 0),
    entryFee,
    totalPot: roundMoney(stats.totalPot || 0),
    commissionRate: getCommissionRate(entryFee, Number(stats.gamesPlayed || 0)),
    commissionAmount: roundMoney(stats.commissionAmount || 0),
    roundsEscrowed: Number(stats.roundsEscrowed || 0),
    playerFeesPaid: stats.playerFeesPaid || {},
    payouts: stats.payouts || {},
    refunds: stats.refunds || {},
    topWinnerIds: (stats.topWinnerIds || []).map(String),
    finalizedReason: stats.finalizedReason || null,
    finalizedAt: stats.finalizedAt || null,
    practice: Boolean(stats.practice),
    botGame: Boolean(stats.botGame),
    managedBotRoom: Boolean(stats.managedBotRoom),
    generatedFor: stats.generatedFor ? String(stats.generatedFor) : null,
    botProfile: stats.botProfile || null,
    targetBotWinRate: Number(stats.targetBotWinRate || 0),
    botResults: {
      gamesPlayed: Number(botResults.gamesPlayed || 0),
      wins: Number(botResults.wins || 0),
      losses: Number(botResults.losses || 0),
    },
  };
}

function roomHasCompletedGame(stats = {}) {
  const roomStats = normalizeRoomStats(stats);
  return roomStats.gamesPlayed > 0 || roomStats.games.length > 0;
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
    VALUES ($1, '', $2, $2, $3, NOW(), NOW())
    ON CONFLICT (telegram_id) DO UPDATE SET
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

async function ensureUser(telegramId) {
  const cleanTelegramId = String(telegramId);
  const insertResult = await query(
    `INSERT INTO users (telegram_id, balance)
    VALUES ($1, $2)
    ON CONFLICT (telegram_id) DO NOTHING
    RETURNING *`,
    [cleanTelegramId, WELCOME_GIFT_COINS]
  );

  if (insertResult.rows[0]) {
    return {
      ...mapUser(insertResult.rows[0]),
      isFirstRun: true,
      firstRunGiftCoins: WELCOME_GIFT_COINS,
    };
  }

  const updateResult = await query(
    `UPDATE users
    SET last_seen = NOW()
    WHERE telegram_id = $1
    RETURNING *`,
    [cleanTelegramId]
  );
  return {
    ...mapUser(updateResult.rows[0]),
    isFirstRun: false,
    firstRunGiftCoins: 0,
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
      balance NUMERIC(12, 0) NOT NULL DEFAULT 0,
      room_in TEXT,
      deposit_sum NUMERIC(12, 0) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 0) NOT NULL DEFAULT 0");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS room_in TEXT");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_sum NUMERIC(12, 0) NOT NULL DEFAULT 0");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()");
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
      entry_fee NUMERIC(12, 0) NOT NULL DEFAULT 0,
      stake NUMERIC(12, 0) NOT NULL DEFAULT 0,
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
  await query(`
    CREATE INDEX IF NOT EXISTS idx_rooms_visibility_created_at
    ON rooms (visibility, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      amount NUMERIC(12, 0) NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp DESC)");

  await query(`
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      total_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);

  await ensureReferralTables();
  await query(`
    CREATE TABLE IF NOT EXISTS user_game_stats (
      user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      games_played INTEGER NOT NULL DEFAULT 0,
      amount_played NUMERIC(12, 0) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ensureRoomArchiveTable();
  await ensureAdminContentTables();
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
  if (!/^[A-Za-z0-9 _.-]+$/.test(cleanName)) {
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
    "SELECT telegram_id, display_name, username, first_name FROM users WHERE telegram_id = ANY($1::text[])",
    [normalizedIds]
  );
  return result.rows.map(mapPublicUser);
}

async function getUserProfile(userId) {
  await ensureAppSchema();
  const user = await getUser(userId);
  if (!user) return null;

  const statsResult = await query(
    "SELECT games_played, amount_played FROM user_game_stats WHERE user_id = $1",
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
      amountPlayed: parseNumber(statsResult.rows[0]?.amount_played || 0),
    },
    referralStats: {
      shareCount,
      rewardCount,
      earnedCoins: rewardCount * REFERRAL_REWARD_COINS,
      earnedBirr: rewardCount * REFERRAL_REWARD_COINS,
      rewardsLeft: Math.max(maxRewards - rewardCount, 0),
      maxRewards,
    },
  };
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
  const initialBalance = telegramUser.balance ?? WELCOME_GIFT_COINS;
  const result = await query(
    `INSERT INTO users (
      telegram_id, phone, username, first_name, last_name, balance, room_in, deposit_sum, created_at, last_seen
    )
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), $7, COALESCE($8, 0), COALESCE($9, NOW()), COALESCE($10, NOW()))
    ON CONFLICT (telegram_id) DO UPDATE SET
      phone = EXCLUDED.phone,
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      last_seen = NOW()
    RETURNING *`,
    [
      telegramId,
      telegramUser.phone,
      telegramUser.username || "",
      telegramUser.firstName || "",
      telegramUser.lastName || "",
      initialBalance,
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
  return mapRoom(result.rows[0]);
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

    await client.query("DELETE FROM rooms WHERE id = $1", [String(roomId)]);
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
      AND status IN ('waiting', 'playing')
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
      AND status IN ('waiting', 'playing')
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
      AND status IN ('waiting', 'playing', 'ended')
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
    WHERE (
        visibility = 'public'
        AND status IN ('waiting', 'playing', 'ended')
        AND COALESCE(room_stats->>'practice', 'false') <> 'true'
      )
      OR (
        players @> ARRAY[$1::text]
        AND status IN ('waiting', 'playing', 'ended')
        AND COALESCE(room_stats->>'practice', 'false') <> 'true'
      )
    ORDER BY
      CASE WHEN players @> ARRAY[$1::text] AND status IN ('waiting', 'playing', 'ended') THEN 0 ELSE 1 END,
      created_at DESC`,
    [String(userId)]
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
  return mapRoom(result.rows[0]);
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
  return mapRoom(result.rows[0]);
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
      "SELECT telegram_id, balance FROM users WHERE telegram_id = ANY($1::text[]) FOR UPDATE",
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

    for (const playerId of normalizedPlayerIds) {
      await client.query(
        "UPDATE users SET balance = balance - $2 WHERE telegram_id = $1",
        [playerId, fee]
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
      escrowPlayers: [...new Set([...(roomStats.escrowPlayers || []), ...normalizedPlayerIds])],
      currentRoundPlayers: normalizedPlayerIds,
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
    const roundNumber = roomStats.gamesPlayed + 1;
    const normalizedWinnerId = String(winnerId);
    const normalizedPlayerIds = playerIds.map(String);
    const roundPlayers = roomStats.currentRoundPlayers.length
      ? roomStats.currentRoundPlayers
      : normalizedPlayerIds;
    const roundPot = roundMoney(roomStats.currentRoundPot || roomStats.entryFee * roundPlayers.length);
    const commissionAmount = calculateCommissionAmount(roundPot, roomStats.entryFee, roundNumber);
    const winnerPayout = roundMoney(roundPot - commissionAmount);

    await client.query(
      "UPDATE users SET balance = balance + $2 WHERE telegram_id = $1",
      [normalizedWinnerId, winnerPayout]
    );

    roomStats.gamesPlayed = roundNumber;
    roomStats.winnerCounts[normalizedWinnerId] = Number(roomStats.winnerCounts[normalizedWinnerId] || 0) + 1;
    roomStats.winnerWeights = roomStats.winnerWeights || {};
    const winWeight = options.jokerBonus ? 2 : 1;
    roomStats.winnerWeights[normalizedWinnerId] = roundMoney(Number(roomStats.winnerWeights[normalizedWinnerId] || 0) + winWeight);
    roomStats.totalPot = roundMoney(Number(roomStats.totalPot || 0) + roundPot);
    roomStats.commissionAmount = roundMoney(Number(roomStats.commissionAmount || 0) + commissionAmount);
    roomStats.commissionRate = getCommissionRate(roomStats.entryFee, roundNumber);
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
    roomStats.games.push({
      round: roundNumber,
      players: roundPlayers,
      entryFee: roomStats.entryFee,
      roundAmountToWin: roundPot,
      roundCommission: commissionAmount,
      roundPayout: winnerPayout,
      totalAmountToWin: roomStats.totalPot,
      winnerId: normalizedWinnerId,
      jokerBonus: Boolean(options.jokerBonus),
      winWeight,
      completedAt: new Date().toISOString(),
    });
    roomStats.feeEscrowed = false;
    roomStats.currentRoundPlayers = [];
    roomStats.currentRoundPot = 0;
    roomStats.escrowRefunded = false;
    roomStats.escrowSettled = false;

    await client.query("UPDATE rooms SET room_stats = $2 WHERE id = $1", [
      String(roomId),
      JSON.stringify(normalizeRoomStats(roomStats)),
    ]);

    await client.query(
      `INSERT INTO user_game_stats (user_id, games_played)
      SELECT id, 1
      FROM UNNEST($1::text[]) AS ids(id)
      ON CONFLICT (user_id) DO UPDATE SET
        games_played = user_game_stats.games_played + 1,
        updated_at = NOW()`,
      [roundPlayers]
    );

    await client.query("COMMIT");
    return normalizeRoomStats(roomStats);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeRoomLedger(roomId, reason = "room-finalized") {
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
    const refundEntries = refundPlayerIds.map((playerId) => [playerId, roomStats.entryFee]);

    for (const [playerId, refundAmount] of refundEntries) {
      await client.query(
        "UPDATE users SET balance = balance + $2 WHERE telegram_id = $1",
        [playerId, refundAmount]
      );
    }

    roomStats.escrowRefunded = true;
    roomStats.feeEscrowed = false;
    roomStats.currentRoundPlayers = [];
    roomStats.currentRoundPot = 0;
    roomStats.finalizedReason = reason;
    roomStats.finalizedAt = new Date().toISOString();
    roomStats.refunds = {
      ...(roomStats.refunds || {}),
      ...Object.fromEntries(refundEntries.map(([playerId, amount]) => [playerId, roundMoney(amount)])),
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
  const coinAmount = roundMoney(amount);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO transactions (id, user_id, amount)
      VALUES ($1, $2, $3)`,
      [String(transactionId), String(userId), coinAmount]
    );
    await client.query(
      `INSERT INTO stats (key, total_amount, count)
      VALUES ('deposits', $1, 1)
      ON CONFLICT (key) DO UPDATE SET
        total_amount = stats.total_amount + EXCLUDED.total_amount,
        count = stats.count + 1`,
      [coinAmount]
    );
    await client.query(
      `INSERT INTO users (telegram_id, balance)
      VALUES ($1, $2)
      ON CONFLICT (telegram_id) DO UPDATE SET
        balance = users.balance + EXCLUDED.balance`,
      [String(userId), coinAmount]
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
  const coinAmount = roundMoney(amount);
  await query(
    `INSERT INTO users (telegram_id, balance)
    VALUES ($1, $2)
    ON CONFLICT (telegram_id) DO UPDATE SET
      balance = users.balance + EXCLUDED.balance`,
    [String(userId), coinAmount]
  );
}

async function withdrawBalance(userId, amount) {
  const coinAmount = roundMoney(amount);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE",
      [String(userId)]
    );

    if (!result.rows[0]) throw new Error("USER_NOT_FOUND");

    const user = mapUser(result.rows[0]);
    if (user.balance < coinAmount) throw new Error("INSUFFICIENT_BALANCE");

    const nextBalance = user.balance - coinAmount;
    await client.query("UPDATE users SET balance = $2 WHERE telegram_id = $1", [
      String(userId),
      nextBalance,
    ]);
    await client.query("COMMIT");

    return {
      currentBalance: user.balance,
      nextBalance,
      phone: user.phone || "N/A",
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
      amount NUMERIC(12, 0) NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (code, referred_user_id)
    )
  `);
}

async function ensureRoomArchiveTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS archived_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      entry_fee NUMERIC(12, 0) NOT NULL DEFAULT 0,
      stake NUMERIC(12, 0) NOT NULL DEFAULT 0,
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
  await query("CREATE INDEX IF NOT EXISTS idx_archived_rooms_archived_at ON archived_rooms (archived_at DESC)");
}

async function ensureAdminContentTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_posters (
      id BIGSERIAL PRIMARY KEY,
      image_url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query("CREATE INDEX IF NOT EXISTS idx_admin_posters_active ON admin_posters (is_active, sort_order, created_at DESC)");

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
      target_mode TEXT NOT NULL DEFAULT 'filtered',
      target_count INTEGER NOT NULL DEFAULT 0,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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
  await query("CREATE INDEX IF NOT EXISTS idx_admin_message_recipients_message ON admin_message_recipients (message_id)");
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
      `INSERT INTO users (telegram_id, balance)
      VALUES ($1, $2)
      ON CONFLICT (telegram_id) DO NOTHING`,
      [cleanReferredUserId, WELCOME_GIFT_COINS]
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
      [cleanCode, String(referralLink.user_id), cleanReferredUserId, REFERRAL_REWARD_COINS]
    );
    await client.query(
      "UPDATE users SET balance = balance + $2 WHERE telegram_id = $1",
      [String(referralLink.user_id), REFERRAL_REWARD_COINS]
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
      amount: REFERRAL_REWARD_COINS,
      referrerId: String(referralLink.user_id),
      rewardCount: Number(updatedLink.rows[0]?.reward_count || 0),
      maxRewards: Number(updatedLink.rows[0]?.max_rewards || 5),
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
  getPublicUsers,
  getUserProfile,
  createRoom,
  getRoom,
  deleteRoom,
  updateRoomStats,
  getCreatorActiveRoom,
  getUserActiveRoom,
  listPublicRooms,
  getAffordableJoinableHumanRoom,
  getWaitingManagedBotRoomForUser,
  listLobbyRooms,
  addPlayerToRoom,
  removePlayerFromRoom,
  updateRoomStatus,
  incrementRoomWinStats,
  escrowRoomEntryFees,
  recordRoomGameResult,
  finalizeRoomLedger,
  transactionExists,
  saveDepositTransaction,
  addBalance,
  withdrawBalance,
  createReferralLink,
  getReferralLink,
  awardReferralIfEligible,
};
