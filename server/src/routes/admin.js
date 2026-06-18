const express = require("express");
const { query } = require("../config/postgres");
const { ensureAppSchema } = require("../db/store");

const router = express.Router();

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value, maxLength = 5000) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanImageUrl(value) {
  const imageUrl = cleanString(value, 1200);
  if (!imageUrl) return "";

  try {
    const parsed = new URL(imageUrl);
    return ["http:", "https:"].includes(parsed.protocol) ? imageUrl : "";
  } catch (error) {
    return "";
  }
}

function requireAdmin(req, res, next) {
  return next();
}

function normalizeRoomStats(stats = {}) {
  return {
    gamesPlayed: Number(stats.gamesPlayed || 0),
    winnerCounts: stats.winnerCounts || {},
    winnerWeights: stats.winnerWeights || {},
    games: Array.isArray(stats.games) ? stats.games : [],
    feeEscrowed: Boolean(stats.feeEscrowed),
    escrowRefunded: Boolean(stats.escrowRefunded),
    escrowSettled: Boolean(stats.escrowSettled),
    escrowPlayers: (stats.escrowPlayers || []).map(String),
    currentRoundPlayers: (stats.currentRoundPlayers || []).map(String),
    currentRoundPot: parseNumber(stats.currentRoundPot),
    entryFee: parseNumber(stats.entryFee),
    totalPot: parseNumber(stats.totalPot),
    commissionRate: parseNumber(stats.commissionRate),
    commissionAmount: parseNumber(stats.commissionAmount),
    roundsEscrowed: Number(stats.roundsEscrowed || 0),
    playerFeesPaid: stats.playerFeesPaid || {},
    payouts: stats.payouts || {},
    refunds: stats.refunds || {},
    topWinnerIds: (stats.topWinnerIds || []).map(String),
    finalizedReason: stats.finalizedReason || null,
    finalizedAt: stats.finalizedAt || null,
  };
}

function mapRoom(row) {
  const roomStats = normalizeRoomStats(row.room_stats || {});
  const isArchived = Boolean(row.is_archived);
  return {
    id: row.id,
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
    isArchived,
    archivedAt: row.archived_at || null,
    archivedReason: row.archived_reason || "",
    lifecycle: isArchived ? "archived" : "active",
    roomStats,
  };
}

function mapUser(row) {
  const telegramId = String(row.telegram_id);
  return {
    telegramId,
    phone: row.phone || "",
    username: row.username || "",
    displayName: row.display_name || row.username || row.first_name || `Player ${telegramId.slice(-4)}`,
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    balance: parseNumber(row.balance),
    roomIn: row.room_in || "",
    depositSum: parseNumber(row.deposit_sum),
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    gamesPlayed: Number(row.games_played || 0),
    amountPlayed: parseNumber(row.amount_played),
    shareCount: Number(row.share_count || 0),
    rewardCount: Number(row.reward_count || 0),
    maxRewards: Number(row.max_rewards || 0),
  };
}

function mapPoster(row) {
  return {
    id: Number(row.id),
    imageUrl: row.image_url,
    title: row.title || "",
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDepositNumber(row) {
  return {
    id: Number(row.id),
    phoneNumber: row.phone_number,
    label: row.label || "",
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAdminMessage(row) {
  return {
    id: Number(row.id),
    text: row.text || "",
    imageUrl: row.image_url || "",
    targetMode: row.target_mode || "filtered",
    targetCount: Number(row.target_count || 0),
    filters: row.filters || {},
    recipientCount: Number(row.recipient_count || row.target_count || 0),
    sentCount: Number(row.sent_count || 0),
    failedCount: Number(row.failed_count || 0),
    createdAt: row.created_at,
  };
}

function flattenGames(rooms = []) {
  return rooms.flatMap((room) => (
    room.roomStats.games.map((game) => ({
      roomId: room.id,
      roomName: room.name,
      roomStatus: room.status,
      lifecycle: room.lifecycle,
      archivedAt: room.archivedAt,
      round: Number(game.round || 0),
      players: game.players || [],
      winnerId: game.winnerId || "",
      entryFee: parseNumber(game.entryFee),
      roundAmountToWin: parseNumber(game.roundAmountToWin),
      roundCommission: parseNumber(game.roundCommission),
      roundPayout: parseNumber(game.roundPayout),
      totalAmountToWin: parseNumber(game.totalAmountToWin),
      jokerBonus: Boolean(game.jokerBonus),
      winWeight: parseNumber(game.winWeight || 1),
      completedAt: game.completedAt || null,
    }))
  ));
}

function summarizeRooms(rooms = []) {
  return rooms.reduce((summary, room) => {
    summary.totalRooms += 1;
    if (room.isArchived) {
      summary.archived += 1;
    } else {
      summary[room.status] = (summary[room.status] || 0) + 1;
      summary.currentRoundPot += room.roomStats.currentRoundPot;
    }
    summary.totalGames += room.roomStats.gamesPlayed;
    summary.totalCommission += room.roomStats.commissionAmount;
    summary.totalPayouts += Object.values(room.roomStats.payouts || {}).reduce((sum, value) => sum + parseNumber(value), 0);
    summary.totalRefunds += Object.values(room.roomStats.refunds || {}).reduce((sum, value) => sum + parseNumber(value), 0);
    return summary;
  }, {
    totalRooms: 0,
    waiting: 0,
    playing: 0,
    ended: 0,
    archived: 0,
    totalGames: 0,
    totalCommission: 0,
    totalPayouts: 0,
    totalRefunds: 0,
    currentRoundPot: 0,
  });
}

async function getUsers() {
  const result = await query(`
    SELECT
      u.*,
      COALESCE(ugs.games_played, 0) AS games_played,
      COALESCE(ugs.amount_played, 0) AS amount_played,
      COALESCE(ref.share_count, 0) AS share_count,
      COALESCE(ref.reward_count, 0) AS reward_count,
      COALESCE(ref.max_rewards, 0) AS max_rewards
    FROM users u
    LEFT JOIN user_game_stats ugs ON ugs.user_id = u.telegram_id
    LEFT JOIN (
      SELECT
        user_id,
        SUM(share_count) AS share_count,
        SUM(reward_count) AS reward_count,
        SUM(max_rewards) AS max_rewards
      FROM referral_links
      GROUP BY user_id
    ) ref ON ref.user_id = u.telegram_id
    ORDER BY u.last_seen DESC
  `);
  return result.rows.map(mapUser);
}

async function getRooms() {
  const result = await query(`
    SELECT *
    FROM (
      SELECT
        id, name, type, entry_fee, stake, creator_id, visibility, created_at,
        players, player_count, max_players, status, room_stats,
        FALSE AS is_archived,
        NULL::TEXT AS archived_reason,
        NULL::TIMESTAMPTZ AS archived_at
      FROM rooms
      UNION ALL
      SELECT
        id, name, type, entry_fee, stake, creator_id, visibility, created_at,
        players, player_count, max_players, status, room_stats,
        TRUE AS is_archived,
        archived_reason,
        archived_at
      FROM archived_rooms
    ) room_rows
    ORDER BY COALESCE(archived_at, created_at) DESC
  `);
  return result.rows.map(mapRoom);
}

async function getDeposits() {
  const result = await query(`
    SELECT
      t.id,
      t.user_id,
      t.amount,
      t.timestamp,
      u.username,
      u.display_name,
      u.first_name
    FROM transactions t
    LEFT JOIN users u ON u.telegram_id = t.user_id
    ORDER BY t.timestamp DESC
    LIMIT 200
  `);
  return result.rows.map((row) => ({
    id: row.id,
    userId: String(row.user_id),
    userName: row.display_name || row.username || row.first_name || `Player ${String(row.user_id).slice(-4)}`,
    amount: parseNumber(row.amount),
    timestamp: row.timestamp,
  }));
}

async function getReferrals() {
  const result = await query(`
    SELECT
      rl.*,
      u.username,
      u.display_name,
      u.first_name,
      COALESCE(awards.referred_users, 0) AS referred_users,
      COALESCE(awards.total_awarded, 0) AS total_awarded
    FROM referral_links rl
    LEFT JOIN users u ON u.telegram_id = rl.user_id
    LEFT JOIN (
      SELECT
        code,
        COUNT(*) AS referred_users,
        SUM(amount) AS total_awarded
      FROM referral_awards
      GROUP BY code
    ) awards ON awards.code = rl.code
    ORDER BY rl.updated_at DESC
  `);

  return result.rows.map((row) => ({
    code: row.code,
    userId: String(row.user_id),
    userName: row.display_name || row.username || row.first_name || `Player ${String(row.user_id).slice(-4)}`,
    link: row.link,
    shareCount: Number(row.share_count || 0),
    rewardCount: Number(row.reward_count || 0),
    maxRewards: Number(row.max_rewards || 0),
    referredUsers: Number(row.referred_users || 0),
    totalAwarded: parseNumber(row.total_awarded),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function getPosters(includeInactive = true) {
  const whereClause = includeInactive ? "" : "WHERE is_active = TRUE";
  const result = await query(`
    SELECT *
    FROM admin_posters
    ${whereClause}
    ORDER BY sort_order ASC, created_at DESC
  `);
  return result.rows.map(mapPoster);
}

async function getDepositNumbers(includeInactive = true) {
  const whereClause = includeInactive ? "" : "WHERE is_active = TRUE";
  const result = await query(`
    SELECT *
    FROM deposit_numbers
    ${whereClause}
    ORDER BY sort_order ASC, created_at DESC
  `);
  return result.rows.map(mapDepositNumber);
}

async function getAdminMessages() {
  const result = await query(`
    SELECT
      m.*,
      COUNT(r.id) AS recipient_count,
      COUNT(r.id) FILTER (WHERE r.status = 'sent') AS sent_count,
      COUNT(r.id) FILTER (WHERE r.status = 'failed') AS failed_count
    FROM admin_messages m
    LEFT JOIN admin_message_recipients r ON r.message_id = m.id
    GROUP BY m.id
    ORDER BY m.created_at DESC
    LIMIT 40
  `);
  return result.rows.map(mapAdminMessage);
}

function matchesRange(value, minValue, maxValue) {
  const number = parseNumber(value);
  const min = parseOptionalNumber(minValue);
  const max = parseOptionalNumber(maxValue);
  if (min !== null && number < min) return false;
  if (max !== null && number > max) return false;
  return true;
}

function filterUsersForMessaging(users, filters = {}) {
  const term = cleanString(filters.search, 120).toLowerCase();
  const hasPhone = filters.hasPhone || "all";
  const roomStatus = filters.roomStatus || "all";
  const lastSeenDays = parseOptionalNumber(filters.lastSeenDays);
  const now = Date.now();

  return users.filter((user) => {
    if (term) {
      const haystack = [
        user.telegramId,
        user.username,
        user.displayName,
        user.firstName,
        user.lastName,
        user.phone,
      ].join(" ").toLowerCase();
      if (!haystack.includes(term)) return false;
    }

    if (!matchesRange(user.balance, filters.minBalance, filters.maxBalance)) return false;
    if (!matchesRange(user.depositSum, filters.minDeposit, filters.maxDeposit)) return false;
    if (!matchesRange(user.gamesPlayed, filters.minGames, filters.maxGames)) return false;
    if (!matchesRange(user.amountPlayed, filters.minAmountPlayed, filters.maxAmountPlayed)) return false;
    if (!matchesRange(user.shareCount, filters.minShares, filters.maxShares)) return false;

    if (hasPhone === "yes" && !user.phone) return false;
    if (hasPhone === "no" && user.phone) return false;
    if (roomStatus === "in-room" && !user.roomIn) return false;
    if (roomStatus === "not-in-room" && user.roomIn) return false;

    if (lastSeenDays !== null && lastSeenDays >= 0) {
      const lastSeenTime = user.lastSeen ? new Date(user.lastSeen).getTime() : 0;
      if (!Number.isFinite(lastSeenTime) || now - lastSeenTime > lastSeenDays * 24 * 60 * 60 * 1000) {
        return false;
      }
    }

    return true;
  });
}

async function callTelegram(method, payload) {
  const token = process.env.BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram request failed (${response.status})`);
  }
  return data;
}

async function sendTelegramMessage(userId, { text, imageUrl }) {
  if (imageUrl) {
    const caption = text ? text.slice(0, 1024) : undefined;
    await callTelegram("sendPhoto", {
      chat_id: String(userId),
      photo: imageUrl,
      caption,
    });

    if (text && text.length > 1024) {
      await callTelegram("sendMessage", {
        chat_id: String(userId),
        text,
      });
    }
    return;
  }

  await callTelegram("sendMessage", {
    chat_id: String(userId),
    text,
  });
}

router.use(requireAdmin);

router.use(async (req, res, next) => {
  try {
    await ensureAppSchema();
    next();
  } catch (error) {
    console.error("Admin schema check failed:", error);
    res.status(500).json({ success: false, error: "Admin schema check failed." });
  }
});

router.get("/overview", async (req, res) => {
  try {
    const [users, rooms, deposits, referrals] = await Promise.all([
      getUsers(),
      getRooms(),
      getDeposits(),
      getReferrals(),
    ]);
    const roomSummary = summarizeRooms(rooms);
    const totalBalance = users.reduce((sum, user) => sum + user.balance, 0);
    const totalDeposits = deposits.reduce((sum, deposit) => sum + deposit.amount, 0);
    const totalReferralRewards = referrals.reduce((sum, referral) => sum + referral.totalAwarded, 0);

    return res.json({
      success: true,
      overview: {
        totalUsers: users.length,
        totalBalance,
        totalDeposits,
        totalWithdrawals: null,
        withdrawalsTracked: false,
        totalReferralRewards,
        activeGames: roomSummary.playing,
        ...roomSummary,
      },
      recent: {
        users: users.slice(0, 8),
        rooms: rooms.slice(0, 8),
        deposits: deposits.slice(0, 8),
        referrals: referrals.slice(0, 8),
      },
    });
  } catch (error) {
    console.error(" /api/admin/overview error:", error);
    return res.status(500).json({ success: false, error: "Could not load admin overview." });
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await getUsers();
    return res.json({ success: true, users });
  } catch (error) {
    console.error(" /api/admin/users error:", error);
    return res.status(500).json({ success: false, error: "Could not load users." });
  }
});

router.get("/rooms", async (req, res) => {
  try {
    const rooms = await getRooms();
    return res.json({
      success: true,
      rooms,
      games: flattenGames(rooms).sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0)),
      summary: summarizeRooms(rooms),
    });
  } catch (error) {
    console.error(" /api/admin/rooms error:", error);
    return res.status(500).json({ success: false, error: "Could not load rooms." });
  }
});

router.get("/money", async (req, res) => {
  try {
    const [rooms, deposits] = await Promise.all([getRooms(), getDeposits()]);
    const roomSummary = summarizeRooms(rooms);
    return res.json({
      success: true,
      money: {
        totalDeposits: deposits.reduce((sum, deposit) => sum + deposit.amount, 0),
        totalWithdrawals: null,
        withdrawalsTracked: false,
        totalCommission: roomSummary.totalCommission,
        totalPayouts: roomSummary.totalPayouts,
        totalRefunds: roomSummary.totalRefunds,
        currentRoundPot: roomSummary.currentRoundPot,
      },
      deposits,
      withdrawals: [],
      games: flattenGames(rooms).sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0)),
    });
  } catch (error) {
    console.error(" /api/admin/money error:", error);
    return res.status(500).json({ success: false, error: "Could not load money data." });
  }
});

router.get("/referrals", async (req, res) => {
  try {
    const referrals = await getReferrals();
    return res.json({
      success: true,
      referrals,
      summary: {
        totalLinks: referrals.length,
        totalShares: referrals.reduce((sum, referral) => sum + referral.shareCount, 0),
        totalRewards: referrals.reduce((sum, referral) => sum + referral.rewardCount, 0),
        totalAwarded: referrals.reduce((sum, referral) => sum + referral.totalAwarded, 0),
      },
    });
  } catch (error) {
    console.error(" /api/admin/referrals error:", error);
    return res.status(500).json({ success: false, error: "Could not load referrals." });
  }
});

router.get("/messages", async (req, res) => {
  try {
    const messages = await getAdminMessages();
    return res.json({ success: true, messages });
  } catch (error) {
    console.error(" /api/admin/messages error:", error);
    return res.status(500).json({ success: false, error: "Could not load messages." });
  }
});

router.post("/messages/send", async (req, res) => {
  try {
    const text = cleanString(req.body?.text, 4096);
    const rawImageUrl = cleanString(req.body?.imageUrl, 1200);
    const imageUrl = cleanImageUrl(rawImageUrl);
    const mode = req.body?.mode === "selected" ? "selected" : "filtered";
    const filters = req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : {};

    if (!text && !rawImageUrl) {
      return res.status(400).json({ success: false, error: "Enter a message or image URL." });
    }
    if (rawImageUrl && !imageUrl) {
      return res.status(400).json({ success: false, error: "Enter a valid http or https image URL." });
    }
    if (!process.env.BOT_TOKEN) {
      return res.status(400).json({ success: false, error: "BOT_TOKEN is not configured." });
    }

    const users = await getUsers();
    const selectedIds = new Set(Array.isArray(req.body?.userIds) ? req.body.userIds.map(String) : []);
    const recipients = mode === "selected"
      ? users.filter((user) => selectedIds.has(user.telegramId))
      : filterUsersForMessaging(users, filters);

    if (!recipients.length) {
      return res.status(400).json({ success: false, error: "No users matched this message target." });
    }

    const messageResult = await query(
      `INSERT INTO admin_messages (text, image_url, target_mode, target_count, filters)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING *`,
      [text, imageUrl, mode, recipients.length, JSON.stringify(filters)]
    );
    const message = messageResult.rows[0];
    const deliveryResults = [];

    for (const user of recipients) {
      let status = "sent";
      let deliveryError = "";

      try {
        await sendTelegramMessage(user.telegramId, { text, imageUrl });
      } catch (error) {
        status = "failed";
        deliveryError = cleanString(error.message, 500);
      }

      await query(
        `INSERT INTO admin_message_recipients (message_id, user_id, status, error, sent_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'sent' THEN NOW() ELSE NULL END)`,
        [message.id, user.telegramId, status, deliveryError]
      );

      deliveryResults.push({
        userId: user.telegramId,
        name: user.displayName,
        status,
        error: deliveryError,
      });
    }

    const sentCount = deliveryResults.filter((result) => result.status === "sent").length;
    const failedCount = deliveryResults.length - sentCount;

    return res.json({
      success: true,
      message: mapAdminMessage({
        ...message,
        recipient_count: deliveryResults.length,
        sent_count: sentCount,
        failed_count: failedCount,
      }),
      sentCount,
      failedCount,
      recipients: deliveryResults,
    });
  } catch (error) {
    console.error(" /api/admin/messages/send error:", error);
    return res.status(500).json({ success: false, error: "Could not send admin message." });
  }
});

router.get("/posters", async (req, res) => {
  try {
    const posters = await getPosters(true);
    return res.json({ success: true, posters });
  } catch (error) {
    console.error(" /api/admin/posters error:", error);
    return res.status(500).json({ success: false, error: "Could not load posters." });
  }
});

router.post("/posters", async (req, res) => {
  try {
    const imageUrl = cleanImageUrl(req.body?.imageUrl);
    if (!imageUrl) {
      return res.status(400).json({ success: false, error: "Enter a valid http or https image URL." });
    }

    const result = await query(
      `INSERT INTO admin_posters (image_url, title, is_active, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING *`,
      [
        imageUrl,
        cleanString(req.body?.title, 120),
        req.body?.isActive !== false,
        parseOptionalNumber(req.body?.sortOrder) || 0,
      ]
    );
    return res.json({ success: true, poster: mapPoster(result.rows[0]) });
  } catch (error) {
    console.error(" /api/admin/posters POST error:", error);
    return res.status(500).json({ success: false, error: "Could not save poster." });
  }
});

router.patch("/posters/:id", async (req, res) => {
  try {
    const current = await query("SELECT * FROM admin_posters WHERE id = $1", [req.params.id]);
    if (!current.rows[0]) {
      return res.status(404).json({ success: false, error: "Poster not found." });
    }

    const nextImageUrl = req.body?.imageUrl === undefined
      ? current.rows[0].image_url
      : cleanImageUrl(req.body.imageUrl);
    if (!nextImageUrl) {
      return res.status(400).json({ success: false, error: "Enter a valid http or https image URL." });
    }

    const result = await query(
      `UPDATE admin_posters
      SET image_url = $2,
        title = $3,
        is_active = $4,
        sort_order = $5,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [
        req.params.id,
        nextImageUrl,
        req.body?.title === undefined ? current.rows[0].title : cleanString(req.body.title, 120),
        req.body?.isActive === undefined ? current.rows[0].is_active : Boolean(req.body.isActive),
        req.body?.sortOrder === undefined ? current.rows[0].sort_order : (parseOptionalNumber(req.body.sortOrder) || 0),
      ]
    );
    return res.json({ success: true, poster: mapPoster(result.rows[0]) });
  } catch (error) {
    console.error(" /api/admin/posters PATCH error:", error);
    return res.status(500).json({ success: false, error: "Could not update poster." });
  }
});

router.delete("/posters/:id", async (req, res) => {
  try {
    await query("DELETE FROM admin_posters WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    console.error(" /api/admin/posters DELETE error:", error);
    return res.status(500).json({ success: false, error: "Could not delete poster." });
  }
});

router.get("/deposit-numbers", async (req, res) => {
  try {
    const numbers = await getDepositNumbers(true);
    return res.json({ success: true, numbers });
  } catch (error) {
    console.error(" /api/admin/deposit-numbers error:", error);
    return res.status(500).json({ success: false, error: "Could not load deposit numbers." });
  }
});

router.post("/deposit-numbers", async (req, res) => {
  try {
    const phoneNumber = cleanString(req.body?.phoneNumber, 60);
    if (phoneNumber.length < 3) {
      return res.status(400).json({ success: false, error: "Enter a phone number." });
    }

    const result = await query(
      `INSERT INTO deposit_numbers (phone_number, label, is_active, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING *`,
      [
        phoneNumber,
        cleanString(req.body?.label, 80),
        req.body?.isActive !== false,
        parseOptionalNumber(req.body?.sortOrder) || 0,
      ]
    );
    return res.json({ success: true, number: mapDepositNumber(result.rows[0]) });
  } catch (error) {
    console.error(" /api/admin/deposit-numbers POST error:", error);
    return res.status(500).json({ success: false, error: "Could not save deposit number." });
  }
});

router.patch("/deposit-numbers/:id", async (req, res) => {
  try {
    const current = await query("SELECT * FROM deposit_numbers WHERE id = $1", [req.params.id]);
    if (!current.rows[0]) {
      return res.status(404).json({ success: false, error: "Deposit number not found." });
    }

    const phoneNumber = req.body?.phoneNumber === undefined
      ? current.rows[0].phone_number
      : cleanString(req.body.phoneNumber, 60);
    if (phoneNumber.length < 3) {
      return res.status(400).json({ success: false, error: "Enter a phone number." });
    }

    const result = await query(
      `UPDATE deposit_numbers
      SET phone_number = $2,
        label = $3,
        is_active = $4,
        sort_order = $5,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [
        req.params.id,
        phoneNumber,
        req.body?.label === undefined ? current.rows[0].label : cleanString(req.body.label, 80),
        req.body?.isActive === undefined ? current.rows[0].is_active : Boolean(req.body.isActive),
        req.body?.sortOrder === undefined ? current.rows[0].sort_order : (parseOptionalNumber(req.body.sortOrder) || 0),
      ]
    );
    return res.json({ success: true, number: mapDepositNumber(result.rows[0]) });
  } catch (error) {
    console.error(" /api/admin/deposit-numbers PATCH error:", error);
    return res.status(500).json({ success: false, error: "Could not update deposit number." });
  }
});

router.delete("/deposit-numbers/:id", async (req, res) => {
  try {
    await query("DELETE FROM deposit_numbers WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    console.error(" /api/admin/deposit-numbers DELETE error:", error);
    return res.status(500).json({ success: false, error: "Could not delete deposit number." });
  }
});

module.exports = router;
