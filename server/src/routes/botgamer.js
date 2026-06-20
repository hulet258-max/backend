const express = require("express");
const { randomUUID } = require("crypto");
const router = express.Router();
const { redis } = require("../config/redis");
const {
  createRoom,
  createSyntheticBot,
  deleteRoom,
  deleteSyntheticBot,
  ensureUser,
  ensureSyntheticBotBalance,
  getAffordableJoinableHumanRoom,
  getRoom,
  getUser,
  getUserActiveRoom,
  getWaitingManagedBotRoomForUser,
  recordRoomGameResult,
  updateRoomStatus,
} = require("../db/store");
const { createInitialGameState } = require("../services/gameService");
const { emitBalanceUpdates } = require("../services/balanceEvents");

const BOT_PREFIX = "botgamer:";
const BOT_TURN_DELAY_MIN_MS = 1200;
const BOT_TURN_DELAY_MAX_MS = 2800;
const BOT_PICK_TO_LAY_MIN_MS = 850;
const BOT_PICK_TO_LAY_MAX_MS = 1800;
const MANAGED_ROOM_TTL_SECONDS = 10 * 60;
const BOT_ENTRY_FEES = [2, 3, 5, 10];
const BOT_FIRST_NAMES = ["Abel", "Dawit", "Elias", "Hana", "Kaleb", "Liya", "Mikael", "Nahom", "Ruth", "Saron"];
const BOT_LAST_NAMES = ["Alem", "Bekele", "Desta", "Fikru", "Kebede", "Mekonnen", "Solomon", "Tadesse", "Tesfaye", "Worku"];
const BOT_ROOM_NAMES = [
  "Addis Card Club",
  "Blue Nile Table",
  "Coffee Break Cards",
  "Golden Hand",
  "Late Night Karta",
  "Merkato Masters",
  "Rift Valley Room",
  "Sunday Shuffle",
  "Unity Table",
  "Victory Corner",
];

const isBotId = (playerId) => String(playerId || "").startsWith(BOT_PREFIX);
const getBotId = (userId) => `${BOT_PREFIX}${userId}`;
const isJoker = (card) => String(card?.rank || "").toUpperCase() === "JOKER";
const isPracticeState = (redisData) => Boolean(redisData?.practice);
const isBotGameState = (redisData) => Boolean(redisData?.botGame || redisData?.practice);

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

    return false;
  };

  return search(counts.slice(), jokerCount);
};

const analyzeWinningHand = (cards = []) => {
  const jokerCount = cards.filter(isJoker).length;
  const naturalCounts = Object.values(getRankCounts(cards, false)).sort((a, b) => b - a);
  return {
    isWinning: matchesWinningPattern(naturalCounts) || canCompletePatternWithJokers(naturalCounts, jokerCount),
    jokerCount,
  };
};

const randomItem = (items) => items[Math.floor(Math.random() * items.length)];
const randomInteger = (minimum, maximum) => (
  Math.floor(Math.random() * (maximum - minimum + 1)) + minimum
);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const buildManagedBotIdentity = () => {
  const suffix = randomInteger(10, 99);
  const displayName = `${randomItem(BOT_FIRST_NAMES)} ${randomItem(BOT_LAST_NAMES)} ${suffix}`;
  return {
    id: `${BOT_PREFIX}managed:${randomUUID()}`,
    displayName,
    balance: randomInteger(40, 200),
  };
};

const biasBotInitialHand = (gameState, botId, maximumSwaps = 2) => {
  const hand = gameState.playerCards?.[botId];
  const deck = gameState.deck;
  if (!Array.isArray(hand) || !Array.isArray(deck)) return gameState;

  for (let swap = 0; swap < maximumSwaps; swap += 1) {
    const counts = getRankCounts(hand, false);
    const targetRanks = Object.entries(counts)
      .filter(([, count]) => count >= 2 && count < 4)
      .sort(([, left], [, right]) => right - left)
      .map(([rank]) => rank);
    const targetRank = targetRanks.find((rank) => deck.some((card) => card.rank === rank && !isJoker(card)));
    if (!targetRank) break;

    const discardIndex = hand.findIndex((card) => !isJoker(card) && Number(counts[card.rank] || 0) === 1);
    const deckIndex = deck.findIndex((card) => card.rank === targetRank && !isJoker(card));
    if (discardIndex === -1 || deckIndex === -1) break;

    const previousCard = hand[discardIndex];
    hand[discardIndex] = deck[deckIndex];
    deck[deckIndex] = previousCard;

    if (analyzeWinningHand(hand).isWinning) {
      deck[deckIndex] = hand[discardIndex];
      hand[discardIndex] = previousCard;
      break;
    }
  }

  return gameState;
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
    practice: Boolean(redisData.practice),
    endedAt: new Date().toISOString(),
  };
};

const getIo = (context) => context?.app?.get ? context.app.get("io") : context;

const emitBotState = async (context, roomId, redisData) => {
  redisData.lastActivityAt = new Date().toISOString();
  await redis.set(`room:${roomId}`, JSON.stringify(redisData));

  const io = getIo(context);
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

const shouldPickLaidCard = (hand = [], card, strongBot = false) => {
  if (!card || isJoker(card)) return false;
  const rankCount = hand.filter((item) => item.rank === card.rank).length;
  return rankCount >= (strongBot ? 1 : 2);
};

const runBotTurn = async (req, roomId) => {
  const lockKey = `room:${roomId}:bot-lock`;
  const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 5 });
  if (!lockAcquired) return;

  try {
    const roomStateText = await redis.get(`room:${roomId}`);
    const redisData = roomStateText ? JSON.parse(roomStateText) : null;
    if (!isBotGameState(redisData) || redisData.gameEnded || redisData.status !== "playing") return;

    const botId = String(redisData.turn || "");
    if (!isBotId(botId)) return;

    redisData.botActionCounts = redisData.botActionCounts || { picks: 0, lays: 0 };

    const botHand = redisData.playerCards?.[botId] || [];
    let pickedCard = false;
    if (botHand.length === 10) {
      const topLaid = redisData.laidCards?.[redisData.laidCards.length - 1];
      if (shouldPickLaidCard(botHand, topLaid, Boolean(redisData.managedBotRoom))) {
        redisData.playerCards[botId].push(redisData.laidCards.pop());
        redisData.botActionCounts.picks += 1;
        redisData.lastPick = {
          playerId: botId,
          source: "laid",
          at: new Date().toISOString(),
          nonce: `${Date.now()}-${Math.random()}`,
        };
        pickedCard = true;
      } else if (redisData.deck?.length) {
        redisData.playerCards[botId].push(redisData.deck.pop());
        redisData.botActionCounts.picks += 1;
        redisData.lastPick = {
          playerId: botId,
          source: "deck",
          at: new Date().toISOString(),
          nonce: `${Date.now()}-${Math.random()}`,
        };
        pickedCard = true;
      }
    }

    if (pickedCard) {
      await emitBotState(req, roomId, redisData);
      await wait(randomInteger(BOT_PICK_TO_LAY_MIN_MS, BOT_PICK_TO_LAY_MAX_MS));
    }

    const winAnalysis = analyzeWinningHand(redisData.playerCards?.[botId] || []);
    const botMayDeclare = redisData.botActionCounts.picks >= 4 && redisData.botActionCounts.lays >= 4;
    if (botMayDeclare && winAnalysis.isWinning && (redisData.playerCards?.[botId] || []).length === 11) {
      redisData.status = "ended";
      redisData.gameEnded = true;
      redisData.turn = null;
      redisData.gameResult = buildWinnerResult(redisData, botId, winAnalysis);
      await updateRoomStatus(roomId, "ended");
      const roundPlayers = (redisData.players || []).map((player) => player.telegramId);
      if (isPracticeState(redisData)) {
        redisData.roomStats = {
          ...(redisData.roomStats || {}),
          practice: true,
          botGame: true,
        };
      } else {
        redisData.roomStats = await recordRoomGameResult(roomId, botId, roundPlayers, {
          jokerBonus: false,
        });
        await emitBalanceUpdates(getIo(req), roundPlayers);
      }
      await emitBotState(req, roomId, redisData);
      await reconcileConnectedUsers(getIo(req));
      return;
    }

    const updatedHand = redisData.playerCards?.[botId] || [];
    if (updatedHand.length === 11) {
      const discardIndex = chooseDiscardIndex(updatedHand);
      const [discardedCard] = updatedHand.splice(discardIndex, 1);
      redisData.laidCards = redisData.laidCards || [];
      redisData.laidCards.push(discardedCard);
      redisData.botActionCounts.lays += 1;
    }

    const playerIds = (redisData.players || []).map((player) => player.telegramId);
    const botIndex = playerIds.findIndex((playerId) => String(playerId) === botId);
    redisData.turn = playerIds[(botIndex + 1) % playerIds.length];

    await emitBotState(req, roomId, redisData);
  } finally {
    await redis.del(lockKey);
  }
};

const scheduleBotTurn = (req, roomId) => {
  const delay = randomInteger(BOT_TURN_DELAY_MIN_MS, BOT_TURN_DELAY_MAX_MS);
  setTimeout(() => {
    runBotTurn(req, roomId).catch((error) => {
      console.error(`[botgamer] Bot turn failed for room ${roomId}:`, error);
    });
  }, delay);
};

const deleteManagedBotRoom = async (io, roomId, expectedGeneratedFor = null) => {
  const room = await getRoom(roomId);
  if (!room || room.status !== "waiting" || room.playerCount !== 1 || !room.roomStats?.managedBotRoom) {
    return false;
  }
  if (expectedGeneratedFor && String(room.roomStats.generatedFor) !== String(expectedGeneratedFor)) {
    return false;
  }

  const botId = room.roomStats.botProfile?.id || room.players?.find(isBotId);
  if (!botId || room.players.some((playerId) => !isBotId(playerId))) return false;

  await deleteRoom(roomId, "managed-bot-unclaimed");
  await redis.del(`room:${roomId}`);
  await redis.del("rooms:list");
  if (room.roomStats.generatedFor) {
    await redis.del(`managed-bot-room:${room.roomStats.generatedFor}`);
  }
  await deleteSyntheticBot(botId);

  if (io) {
    io.emit("room_unavailable", { roomId });
    io.emit("room_deleted", { roomId });
  }
  return true;
};

const ensureManagedBotRoomForUser = async (io, userId) => {
  const cleanUserId = String(userId || "");
  if (!cleanUserId || isBotId(cleanUserId)) return null;

  const lockKey = `managed-bot-generation:${cleanUserId}`;
  const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 10 });
  if (!lockAcquired) return null;

  try {
    const user = await getUser(cleanUserId);
    if (!user || Number(user.balance || 0) < 2) return null;

    const activeRoom = await getUserActiveRoom(cleanUserId);
    if (activeRoom) return null;

    const humanRoom = await getAffordableJoinableHumanRoom(user.balance);
    if (humanRoom) return null;

    const existingRoom = await getWaitingManagedBotRoomForUser(cleanUserId);
    if (existingRoom) return existingRoom;

    const affordableFees = BOT_ENTRY_FEES.filter((fee) => fee <= Number(user.balance || 0));
    if (!affordableFees.length) return null;

    const entryFee = randomItem(affordableFees);
    const identity = buildManagedBotIdentity();
    identity.balance = Math.max(identity.balance, entryFee * 4);
    const botUser = await createSyntheticBot({
      telegramId: identity.id,
      displayName: identity.displayName,
      balance: identity.balance,
    });
    const botProfile = {
      id: botUser.telegramId,
      displayName: botUser.displayName,
      balance: botUser.balance,
    };
    const roomStats = {
      gamesPlayed: 0,
      winnerCounts: {},
      games: [],
      practice: false,
      botGame: true,
      managedBotRoom: true,
      generatedFor: cleanUserId,
      botProfile,
      targetBotWinRate: 0.6,
      botResults: { gamesPlayed: 0, wins: 0, losses: 0 },
      entryFee,
    };

    const room = await createRoom({
      name: randomItem(BOT_ROOM_NAMES),
      type: "2-players",
      entryFee,
      stake: entryFee,
      creatorId: botUser.telegramId,
      visibility: "public",
      players: [botUser.telegramId],
      playerCount: 1,
      maxPlayers: 2,
      status: "waiting",
      roomStats,
    });
    const redisData = {
      status: "waiting",
      players: [{ telegramId: botUser.telegramId, socketId: null, bot: true }],
      practice: false,
      botGame: true,
      managedBotRoom: true,
      generatedFor: cleanUserId,
      botProfile,
      roomStats,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    await redis.set(`room:${room.id}`, JSON.stringify(redisData));
    await redis.set(`managed-bot-room:${cleanUserId}`, room.id, { EX: MANAGED_ROOM_TTL_SECONDS });
    await redis.del("rooms:list");
    if (io) io.emit("new_room_created", room);
    return room;
  } finally {
    await redis.del(lockKey);
  }
};

const reconcileConnectedUsers = async (io) => {
  if (!redis.isOpen) return;
  const socketKeys = await redis.keys("user:*:socket");
  const userIds = socketKeys
    .map((key) => key.match(/^user:(.+):socket$/)?.[1])
    .filter((userId) => userId && !isBotId(userId));

  for (const userId of [...new Set(userIds)]) {
    try {
      await ensureManagedBotRoomForUser(io, userId);
    } catch (error) {
      console.error(`[botgamer] Could not reconcile bot room for ${userId}:`, error);
    }
  }
};

const cleanupManagedBotRoomForUser = async (io, userId) => {
  const room = await getWaitingManagedBotRoomForUser(userId);
  if (!room) return false;
  return deleteManagedBotRoom(io, room.id, userId);
};

const fundManagedBotForRound = async (redisData, entryFee) => {
  if (!redisData?.managedBotRoom || !redisData.botProfile?.id) return null;
  const botUser = await ensureSyntheticBotBalance(
    redisData.botProfile.id,
    Number(entryFee || 0),
    randomInteger(40, 200)
  );
  if (!botUser) return null;

  redisData.botProfile = {
    ...redisData.botProfile,
    displayName: botUser.displayName,
    balance: botUser.balance,
  };
  redisData.roomStats = {
    ...(redisData.roomStats || {}),
    botProfile: redisData.botProfile,
  };
  return botUser;
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
      botActionCounts: { picks: 0, lays: 0 },
      lastPick: null,
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
module.exports.isBotGameState = isBotGameState;
module.exports.isBotId = isBotId;
module.exports.biasBotInitialHand = biasBotInitialHand;
module.exports.analyzeWinningHand = analyzeWinningHand;
module.exports.chooseDiscardIndex = chooseDiscardIndex;
module.exports.shouldPickLaidCard = shouldPickLaidCard;
module.exports.ensureManagedBotRoomForUser = ensureManagedBotRoomForUser;
module.exports.reconcileConnectedUsers = reconcileConnectedUsers;
module.exports.cleanupManagedBotRoomForUser = cleanupManagedBotRoomForUser;
module.exports.deleteManagedBotRoom = deleteManagedBotRoom;
module.exports.fundManagedBotForRound = fundManagedBotForRound;
module.exports.BOT_PREFIX = BOT_PREFIX;
