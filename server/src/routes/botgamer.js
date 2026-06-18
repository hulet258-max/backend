const express = require("express");
const router = express.Router();
const { redis } = require("../config/redis");
const {
  createRoom,
  ensureUser,
  getRoom,
  updateRoomStatus,
} = require("../db/store");
const { createInitialGameState } = require("../services/gameService");

const BOT_PREFIX = "botgamer:";
const BOT_TURN_DELAY_MS = 900;

const isBotId = (playerId) => String(playerId || "").startsWith(BOT_PREFIX);
const getBotId = (userId) => `${BOT_PREFIX}${userId}`;
const isJoker = (card) => String(card?.rank || "").toUpperCase() === "JOKER";
const isPracticeState = (redisData) => Boolean(redisData?.practice || redisData?.botGame);

const getRankCounts = (cards = [], includeJokers = false) => cards.reduce((acc, card) => {
  const rank = card?.rank;
  if (!rank) return acc;
  if (!includeJokers && isJoker(card)) return acc;
  acc[rank] = (acc[rank] || 0) + 1;
  return acc;
}, {});

const matchesWinningPattern = (counts = []) => {
  const pattern = counts.slice().sort((a, b) => b - a);
  return pattern.length === 4 &&
    pattern[0] === 4 &&
    pattern[1] === 3 &&
    pattern[2] === 3 &&
    pattern[3] === 1;
};

const canCompletePatternWithJokers = (counts = [], jokerCount = 0) => {
  const search = (currentCounts, remainingJokers) => {
    if (remainingJokers === 0) return matchesWinningPattern(currentCounts);

    for (let index = 0; index < currentCounts.length; index += 1) {
      if (currentCounts[index] >= 4) continue;
      const nextCounts = [...currentCounts];
      nextCounts[index] += 1;
      if (search(nextCounts, remainingJokers - 1)) return true;
    }

    if (currentCounts.length < 4) {
      return search([...currentCounts, 1], remainingJokers - 1);
    }

    return false;
  };

  return search(counts.slice(), jokerCount);
};

const analyzeWinningHand = (cards = []) => {
  const jokerCount = cards.filter(isJoker).length;
  const naturalCounts = Object.values(getRankCounts(cards, false)).sort((a, b) => b - a);
  const allCounts = Object.values(getRankCounts(cards, true)).sort((a, b) => b - a);
  return {
    isWinning: matchesWinningPattern(allCounts) || canCompletePatternWithJokers(naturalCounts, jokerCount),
    jokerCount,
  };
};

const buildWinnerResult = (redisData, winnerId, analysis = analyzeWinningHand(redisData.playerCards?.[winnerId] || [])) => {
  const playerCardCounts = {};
  Object.entries(redisData.playerCards || {}).forEach(([playerId, cards]) => {
    playerCardCounts[playerId] = cards.length;
  });

  return {
    winnerId,
    winners: [winnerId],
    winnerPattern: "4-3-3-1",
    playerCardCounts,
    reason: analysis.jokerCount > 0 ? "joker-completed-hand" : "valid-hand",
    jokerCount: analysis.jokerCount,
    jokerBonus: false,
    practice: true,
    endedAt: new Date().toISOString(),
  };
};

const emitPracticeState = async (req, roomId, redisData) => {
  redisData.lastActivityAt = new Date().toISOString();
  await redis.set(`room:${roomId}`, JSON.stringify(redisData));

  const io = req.app.get("io");
  if (!io) return;

  const room = await getRoom(roomId);
  if (!room) return;

  const payload = {
    room,
    players: room.players,
    redisData,
  };

  (redisData.players || []).forEach((player) => {
    if (player.socketId) {
      io.to(player.socketId).emit("room_update", payload);
    }
  });
};

const chooseDiscardIndex = (cards = []) => {
  const counts = getRankCounts(cards, false);
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  cards.forEach((card, index) => {
    const groupCount = isJoker(card) ? 99 : Number(counts[card.rank] || 0);
    const rankScore = ["A", "K", "Q", "J"].includes(card.rank) ? 8 : Number(card.rank || 2);
    const score = groupCount * 20 + rankScore;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex === -1 ? 0 : bestIndex;
};

const shouldPickLaidCard = (hand = [], card) => {
  if (!card || isJoker(card)) return false;
  const rankCount = hand.filter((item) => item.rank === card.rank).length;
  return rankCount >= 2;
};

const runBotTurn = async (req, roomId) => {
  const lockKey = `room:${roomId}:bot-lock`;
  const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 5 });
  if (!lockAcquired) return;

  try {
    const roomStateText = await redis.get(`room:${roomId}`);
    const redisData = roomStateText ? JSON.parse(roomStateText) : null;
    if (!isPracticeState(redisData) || redisData.gameEnded || redisData.status !== "playing") return;

    const botId = String(redisData.turn || "");
    if (!isBotId(botId)) return;

    const botHand = redisData.playerCards?.[botId] || [];
    if (botHand.length === 10) {
      const topLaid = redisData.laidCards?.[redisData.laidCards.length - 1];
      if (shouldPickLaidCard(botHand, topLaid)) {
        redisData.playerCards[botId].push(redisData.laidCards.pop());
      } else if (redisData.deck?.length) {
        redisData.playerCards[botId].push(redisData.deck.pop());
      }
    }

    const winAnalysis = analyzeWinningHand(redisData.playerCards?.[botId] || []);
    if (winAnalysis.isWinning && (redisData.playerCards?.[botId] || []).length === 11) {
      redisData.status = "ended";
      redisData.gameEnded = true;
      redisData.turn = null;
      redisData.gameResult = buildWinnerResult(redisData, botId, winAnalysis);
      redisData.roomStats = {
        ...(redisData.roomStats || {}),
        practice: true,
        botGame: true,
      };
      await updateRoomStatus(roomId, "ended");
      await emitPracticeState(req, roomId, redisData);
      return;
    }

    const updatedHand = redisData.playerCards?.[botId] || [];
    if (updatedHand.length === 11) {
      const discardIndex = chooseDiscardIndex(updatedHand);
      const [discardedCard] = updatedHand.splice(discardIndex, 1);
      redisData.laidCards = redisData.laidCards || [];
      redisData.laidCards.push(discardedCard);
    }

    const playerIds = (redisData.players || []).map((player) => player.telegramId);
    const botIndex = playerIds.findIndex((playerId) => String(playerId) === botId);
    redisData.turn = playerIds[(botIndex + 1) % playerIds.length];

    await emitPracticeState(req, roomId, redisData);
  } finally {
    await redis.del(lockKey);
  }
};

const scheduleBotTurn = (req, roomId) => {
  setTimeout(() => {
    runBotTurn(req, roomId).catch((error) => {
      console.error(`[botgamer] Bot turn failed for room ${roomId}:`, error);
    });
  }, BOT_TURN_DELAY_MS);
};

router.post("/bot-game/start", async (req, res) => {
  try {
    const { userId, socketId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    const cleanUserId = String(userId);
    const botId = getBotId(cleanUserId);
    await ensureUser(cleanUserId);

    if (socketId) {
      await redis.set(`user:${cleanUserId}:socket`, socketId);
    }

    const roomStats = {
      gamesPlayed: 0,
      winnerCounts: {},
      games: [],
      practice: true,
      botGame: true,
      entryFee: 0,
      totalPot: 0,
      currentRoundPot: 0,
      commissionAmount: 0,
    };

    const room = await createRoom({
      name: "Bot Practice",
      type: "2-players",
      entryFee: 0,
      stake: 0,
      creatorId: cleanUserId,
      visibility: "private",
      players: [cleanUserId, botId],
      playerCount: 2,
      maxPlayers: 2,
      status: "playing",
      roomStats,
    });

    const initialGameState = createInitialGameState([botId, cleanUserId]);
    const redisData = {
      ...initialGameState,
      status: "playing",
      players: [
        { telegramId: botId, socketId: null, bot: true },
        { telegramId: cleanUserId, socketId: socketId || null },
      ],
      practice: true,
      botGame: true,
      roomStats,
      lastActivityAt: new Date().toISOString(),
    };

    await redis.set(`room:${room.id}`, JSON.stringify(redisData));
    await redis.del("rooms:list");
    scheduleBotTurn(req, room.id);

    return res.status(201).json({
      success: true,
      room,
      players: room.players,
      redisData,
    });
  } catch (error) {
    console.error("[botgamer] start error:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
module.exports.scheduleBotTurn = scheduleBotTurn;
module.exports.isPracticeState = isPracticeState;
module.exports.isBotId = isBotId;
module.exports.BOT_PREFIX = BOT_PREFIX;
