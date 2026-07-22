const express = require("express");
const { randomUUID } = require("crypto");
const router = express.Router();
const { redis } = require("../config/redis");
const {
  MANAGED_BOT_STARTING_BALANCE_BIRR,
  MIN_ROOM_ENTRY_BIRR,
} = require("../config/economy");
const {
  createRoom,
  createSystemRoomWithAvailableName,
  createSyntheticBot,
  deleteRoom,
  deleteSyntheticBot,
  ensureUser,
  ensureSyntheticBotBalance,
  finalizeRoomLedger,
  getAffordableJoinableHumanRoom,
  getRoom,
  getUser,
  getUserGameStats,
  latchManagedBonusIntro,
  getUserActiveRoom,
  getWaitingManagedBotRoomForUser,
  recordRoomGameResult,
  transitionManagedBotRoomToWaiting,
  updateRoomStatus,
} = require("../db/store");
const { createInitialGameState } = require("../services/gameService");
const { markTurnActivity } = require("../services/turnInactivity");
const {
  getCompletedRounds,
  isManagedFirstRound,
  requiresManagedRoomRotation,
} = require("../services/managedRoomLifecycle");
const { createRematchState } = require("../services/rematch");
const {
  buildBotDifficultyProfile,
} = require("../services/botDifficulty");
const houseBot = require("../services/houseBotController");
const cardFlow = require("../services/cardFlowController");
const { buildSocketByUserId, emitBalanceUpdates } = require("../services/balanceEvents");
const { getRandomExportUsername } = require("../services/exportUsernames");
const { buildRoomUpdatePayload, sanitizeRedisData, sanitizeRoom } = require("../services/playerPayload");
const { SYSTEM_ROOM_NAMES } = require("../config/systemRoomNames");

const BOT_PREFIX = "botgamer:";
const MANAGED_ROOM_TTL_SECONDS = 10 * 60;
const MANAGED_BOT_CALL_DELAY_MS = 11 * 1000;
const BOT_ENTRY_FEES = [10, 15, 20, 25, 50, 100].filter((fee) => fee >= MIN_ROOM_ENTRY_BIRR);
const isBotId = (playerId) => String(playerId || "").startsWith(BOT_PREFIX);
const getBotId = (userId) => `${BOT_PREFIX}${userId}`;
const isJoker = (card) => String(card?.rank || "").toUpperCase() === "JOKER";
const isPracticeState = (redisData) => Boolean(redisData?.practice);
const isBotGameState = (redisData) => Boolean(redisData?.botGame || redisData?.practice);

const shuffleCards = (cards = []) => {
  const deck = [...cards];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
};

const refillDeckFromLaidCards = (redisData) => {
  if ((redisData.deck || []).length > 0) return true;
  const laidCards = (redisData.laidCards || []).filter(Boolean);
  if (!laidCards.length) return false;

  redisData.deck = shuffleCards(laidCards);
  redisData.laidCards = [];
  redisData.deckReshuffledAt = new Date().toISOString();
  return true;
};

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

const randomInteger = (minimum, maximum) => (
  Math.floor(Math.random() * (maximum - minimum + 1)) + minimum
);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const getNextAffordableBotEntryFee = (currentFee, balance) => (
  BOT_ENTRY_FEES.find((fee) => fee > Number(currentFee || 0) && fee <= Number(balance || 0)) || null
);

const getManagedBalanceBandFee = (balance) => {
  const amount = Number(balance || 0);
  if (amount >= 1000) return 100;
  if (amount >= 500) return 50;
  if (amount >= 200) return 25;
  if (amount > 100) return 20;
  return null;
};

const selectManagedRoomEntryFee = (
  balance,
  { minimumFee = 0, random = Math.random } = {}
) => {
  const affordableFees = BOT_ENTRY_FEES.filter((fee) => fee <= Number(balance || 0));
  if (!affordableFees.length) return null;
  const requiredFee = Math.max(
    Number(minimumFee || 0),
    Number(getManagedBalanceBandFee(balance) || 0)
  );
  if (requiredFee > 0) {
    const atOrAbove = affordableFees.find((fee) => fee >= requiredFee);
    return atOrAbove || affordableFees[affordableFees.length - 1];
  }
  return affordableFees[Math.floor(random() * affordableFees.length)];
};

const buildManagedBotIdentity = () => {
  const suffix = randomInteger(10, 99);
  const displayName = getRandomExportUsername() || `user_${suffix}_${randomUUID().slice(0, 6)}`;
  return {
    id: `${BOT_PREFIX}managed:${randomUUID()}`,
    displayName,
    balance: MANAGED_BOT_STARTING_BALANCE_BIRR,
  };
};

/**
 * Bias bot opening hand. `difficultyOrOptions` may be:
 * - a number (legacy fixed swap count)
 * - a botDifficulty / house profile with optional `pressure`
 * - optional 4th arg humanId for perfect-info open dumps
 */
const biasBotInitialHand = (gameState, botId, difficultyOrOptions = {}, humanId = null) => {
  const resolvedHumanId = humanId
    || difficultyOrOptions?.humanId
    || null;

  if (typeof difficultyOrOptions === "number") {
    const hand = gameState.playerCards?.[botId];
    const deck = gameState.deck;
    if (!Array.isArray(hand) || !Array.isArray(deck)) return gameState;
    const maximumSwaps = difficultyOrOptions;
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
  }

  let pressure = difficultyOrOptions?.pressure || "fair";
  if (!difficultyOrOptions?.pressure && difficultyOrOptions?.strength != null) {
    const strength = Number(difficultyOrOptions.strength || 0);
    pressure = strength >= 0.75 ? "take" : strength <= 0.15 ? "give" : "fair";
  }

  return houseBot.biasBotOpeningHand(gameState, botId, {
    pressure,
    humanId: resolvedHumanId,
  });
};

const buildWinnerResult = (redisData, winnerId, analysis = analyzeWinningHand(redisData.playerCards?.[winnerId] || [])) => {
  const playerCardCounts = {};
  const revealedHands = {};
  Object.entries(redisData.playerCards || {}).forEach(([playerId, cards]) => {
    playerCardCounts[playerId] = cards.length;
    revealedHands[playerId] = cards.map((card) => ({ ...card }));
  });

  return {
    winnerId,
    winners: [winnerId],
    winnerPattern: "4-3-3-1",
    playerCardCounts,
    revealedHands,
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

  const payload = buildRoomUpdatePayload(room, redisData);

  (redisData.players || []).forEach((player) => {
    if (player.socketId) {
      io.to(player.socketId).emit("room_update", payload);
    }
  });
};

const chooseDiscardIndex = (cards = [], humanHand = [], pressure = "fair", options = {}) => (
  houseBot.chooseDiscardIndex(cards, humanHand, pressure, options)
);

const shouldPickLaidCard = (hand = [], card, difficultyOrPressure = {}, random = Math.random, humanHand = []) => {
  if (typeof difficultyOrPressure === "boolean") {
    if (!card || isJoker(card)) return false;
    // Natural: never pick a rank we don't already hold (avoids pick→re-lay)
    const rankCount = hand.filter((item) => item.rank === card.rank && !isJoker(item)).length;
    if (rankCount < 1) return false;
    if (rankCount >= 2) return difficultyOrPressure;
    return difficultyOrPressure ? random() < 0.7 : false;
  }

  const pressure = typeof difficultyOrPressure === "string"
    ? difficultyOrPressure
    : (difficultyOrPressure.pressure || "fair");

  return houseBot.shouldBotTakeLaid(hand, humanHand, card, pressure, random);
};

/**
 * STEP 1 — Decide who wins this round BEFORE any cards are dealt.
 * Uses games played, wins, balance, and room fee. Hidden from clients.
 */
const selectScriptedWinnerBeforeDeal = async (redisData, botId, humanId, context = {}) => {
  // Clear previous round script so rematch never reuses it
  redisData.scriptedBotWins = null;
  redisData.scriptedWinner = null;
  redisData.scriptedWinnerId = null;
  redisData.scriptedBotWinProbability = null;
  redisData.scriptedFactors = null;
  redisData.roundPressure = null;

  let gamesPlayed = Number(redisData.botDifficulty?.gamesPlayed || 0);
  let wins = Number(redisData.botDifficulty?.wins || 0);
  let balance = 0;
  let totalWithdrawn = 0;
  const entryFee = Number(
    redisData.roomStats?.entryFee
    ?? redisData.entryFee
    ?? 0
  );

  if (humanId) {
    try {
      const [stats, user] = await Promise.all([
        getUserGameStats(humanId),
        getUser(humanId),
      ]);
      gamesPlayed = Number(stats.gamesPlayed || 0);
      wins = Number(stats.wins || 0);
      balance = Number(user?.balance || 0);
      totalWithdrawn = Number(user?.totalWithdrawn || 0);
    } catch (error) {
      console.error("[botgamer] scripted outcome context load failed:", error.message);
    }
  }

  const baseTargetWinRate = Number(
    redisData.targetBotWinRate
    || redisData.houseControl?.targetWinRate
    || redisData.botDifficulty?.targetBotWinRate
    || houseBot.HOUSE_BOT_TARGET_WIN_RATE
  );

  // Per-user 12-game cycle: shuffled 2/3, 3/4, and 4/5 bot-win sub-blocks.
  let ledger = houseBot.emptyLedger();
  const usesManagedSchedule = !isPracticeState(redisData);
  if (humanId && usesManagedSchedule) {
    try {
      ledger = await houseBot.loadHouseBotLedger(redis, humanId);
    } catch (error) {
      console.error("[botgamer] ledger load failed:", error.message);
    }
  }

  // A durable revision: duplicate initialization of the same lifetime round gets
  // the same value, while replacement rooms continue instead of resetting it.
  const roundContextRevision = Math.max(1, Math.floor(Number(gamesPlayed || 0)) + 1);
  redisData.managedRoundContextRevision = roundContextRevision;
  redisData.managedRoundContext = usesManagedSchedule ? {
    revision: roundContextRevision,
    gamesPlayed,
    wins,
    balance,
    totalWithdrawn,
    ledgerTotalGames: Number(ledger.totalGames || 0),
    blockNumber: ledger.blockNumber,
    blockPosition: ledger.blockPosition,
    refreshedAt: new Date().toISOString(),
  } : null;

  let outcome = houseBot.decideScriptedOutcome({
    gamesPlayed,
    wins,
    balance,
    entryFee,
    totalWithdrawn,
    baseTargetWinRate,
    ledger,
    totalGames: usesManagedSchedule ? ledger.totalGames : 0,
    blockNumber: usesManagedSchedule ? ledger.blockNumber : null,
    blockPosition: usesManagedSchedule ? ledger.blockPosition : null,
    scheduleVersion: usesManagedSchedule ? ledger.scheduleVersion : null,
    scheduleBlockSizes: usesManagedSchedule ? ledger.scheduleBlockSizes : [],
    guaranteedBotWinSlots: usesManagedSchedule ? ledger.guaranteedBotWinSlots : [],
    guaranteedHumanWinSlots: usesManagedSchedule ? ledger.guaranteedHumanWinSlots : [],
    jokerHumanWinSlot: usesManagedSchedule ? ledger.jokerHumanWinSlot : null,
    jokerAssistCount: usesManagedSchedule ? ledger.jokerAssistCount : null,
  });

  let managedBonusIntro = { started: false, games: 0, active: false };
  if (humanId && usesManagedSchedule) {
    const bonusUsed = Number(redisData.roomStats?.currentRoundBonusEscrow?.[String(humanId)] || 0);
    try {
      managedBonusIntro = await latchManagedBonusIntro(humanId, bonusUsed);
    } catch (error) {
      console.error("[botgamer] bonus intro latch failed:", error.message);
    }
  }
  const introOutcome = houseBot.getManagedBonusIntroOutcome(
    managedBonusIntro.active,
    managedBonusIntro.games
  );
  const introStage = introOutcome?.stage || null;
  if (introOutcome) {
    const botWins = introOutcome.botWins;
    outcome = {
      ...outcome,
      botWins,
      scriptedWinner: introOutcome.scriptedWinner,
      forced: true,
      forceReason: `managed-bonus-intro-${introStage}`,
    };
    redisData.managedBonusIntroStage = introStage;
  } else {
    redisData.managedBonusIntroStage = null;
  }

  const availableBalance = balance + entryFee;
  const nextEntryFee = getNextAffordableBotEntryFee(entryFee, availableBalance);
  const replacementEntryFee = nextEntryFee
    ? selectManagedRoomEntryFee(availableBalance, { minimumFee: nextEntryFee })
    : null;
  const roomGamesPlayed = getCompletedRounds(redisData);
  const leaveEligible = Boolean(
    usesManagedSchedule
    && !introStage
    && roomGamesPlayed >= 1
    && !requiresManagedRoomRotation(redisData)
    && nextEntryFee
    && availableBalance >= entryFee * 15
  );
  try {
    const leavePlan = await houseBot.planManagedBotLeave(
      redis,
      humanId,
      ledger,
      leaveEligible
    );
    redisData.managedLeaveThisRound = leavePlan.shouldLeaveThisRound;
    redisData.managedLeaveAfterBotTurns = leavePlan.shouldLeaveThisRound
      ? randomInteger(1, 3)
      : null;
    redisData.managedLeaveReplacementFee = leavePlan.shouldLeaveThisRound
      ? replacementEntryFee
      : null;
  } catch (error) {
    redisData.managedLeaveThisRound = false;
    redisData.managedLeaveAfterBotTurns = null;
    redisData.managedLeaveReplacementFee = null;
    console.error("[botgamer] leave-cycle planning failed:", error.message);
  }

  // Play type: take (bot) / give (human) — never fair after 6 room games
  let roundPressure = houseBot.pressureForScriptedOutcome(
    outcome.botWins,
    redisData.houseControl?.pressure || "fair",
    roomGamesPlayed
  );

  redisData.scriptedBotWins = outcome.botWins;
  redisData.scriptedWinner = outcome.scriptedWinner; // "bot" | "human"
  redisData.scriptedWinnerId = outcome.botWins ? String(botId) : String(humanId || "");
  redisData.scriptedBotWinProbability = outcome.botWinProbability;
  // Bot-specific guarantee applies only to the scheduled bot slot.
  redisData.scriptedForced = Boolean(outcome.forced);
  redisData.scriptedGuaranteed = Boolean(outcome.forced && outcome.botWins);
  redisData.scriptedForceReason = outcome.forceReason || null;
  redisData.scriptedFactors = outcome.factors;
  redisData.jokerAssistedRound = Boolean(
    usesManagedSchedule
    && !introStage
    && outcome.scriptedWinner === "human"
    && outcome.jokerAssisted
  );
  redisData.jokerAssistCount = redisData.jokerAssistedRound
    ? Math.max(1, Math.min(2, Number(outcome.jokerAssistCount) || 1))
    : 0;
  // Scheduled guaranteed rounds always use maximum bot pressure.
  let playPressure = redisData.scriptedGuaranteed ? "take" : roundPressure;
  playPressure = houseBot.clampPressureAfterSixGames(
    playPressure,
    roomGamesPlayed,
    outcome.botWins
  );
  redisData.roundPressure = playPressure;
  redisData.housePressure = playPressure;
  redisData.roomStats = {
    ...(redisData.roomStats || {}),
    housePressure: playPressure,
  };

  const roundNumber = Math.max(
    1,
    Math.floor(Number(redisData.roomStats?.gamesPlayed || 0)) + 1
  );
  const probabilityPercent = Number((outcome.botWinProbability * 100).toFixed(2));
  console.info("[botgamer] scripted winner selected BEFORE deal", {
    event: "bot_round_scripted_before_deal",
    roomId: context.roomId ? String(context.roomId) : null,
    trigger: context.trigger || "round-start",
    gameType: isPracticeState(redisData) ? "practice" : "managed",
    roundNumber,
    botId: String(botId || ""),
    humanId: String(humanId || ""),
    botWinProbability: outcome.botWinProbability,
    botWinProbabilityPercent: `${probabilityPercent}%`,
    scriptedWinner: outcome.scriptedWinner,
    scriptedWinnerId: redisData.scriptedWinnerId,
    forced: Boolean(outcome.forced),
    guaranteed: Boolean(redisData.scriptedGuaranteed),
    forceReason: outcome.forceReason || null,
    blockNumber: usesManagedSchedule ? ledger.blockNumber : null,
    blockPosition: usesManagedSchedule ? ledger.blockPosition : null,
    scheduleCycleNumber: usesManagedSchedule ? ledger.blockNumber : null,
    scheduleCyclePosition: usesManagedSchedule ? ledger.blockPosition : null,
    scheduleVersion: usesManagedSchedule ? ledger.scheduleVersion : null,
    scheduleBlockSizes: usesManagedSchedule ? ledger.scheduleBlockSizes : [],
    scheduleSegmentIndex: usesManagedSchedule ? outcome.scheduleSegmentIndex : null,
    scheduleSegmentSize: usesManagedSchedule ? outcome.scheduleSegmentSize : null,
    scheduleSegmentPosition: usesManagedSchedule ? outcome.scheduleSegmentPosition : null,
    guaranteedBotWinSlots: usesManagedSchedule ? ledger.guaranteedBotWinSlots : [],
    guaranteedHumanWinSlots: usesManagedSchedule ? ledger.guaranteedHumanWinSlots : [],
    jokerHumanWinSlot: usesManagedSchedule ? ledger.jokerHumanWinSlot : null,
    jokerAssistCount: redisData.jokerAssistCount,
    jokerAssisted: redisData.jokerAssistedRound,
    roundPressure: playPressure,
    gamesPlayed,
    wins,
    humanWinRate: outcome.factors?.humanWinRate ?? 0,
    balance,
    entryFee,
    totalWithdrawn,
    baseTargetWinRate,
    cardsDealt: false,
    startedAt: new Date().toISOString(),
  });

  return outcome;
};

/** True when the per-user variable 3/4/5 schedule forces one of its bot rounds. */
const isGuaranteedBotWinRound = (redisData) => Boolean(
  redisData
  && redisData.scriptedGuaranteed
  && (redisData.scriptedWinner === "bot" || redisData.scriptedBotWins === true)
);

/**
 * STEP 3 — After deal: bias opening hands toward the script.
 * Guaranteed scheduled rounds: weaken human open + strengthen bot open
 * so the human does not start close to a legal hand (no fake "invalid" on declare).
 */
const applyNaturalBiasAfterDeal = (gameState, redisData, botId, humanId) => {
  if (isGuaranteedBotWinRound(redisData) && humanId) {
    houseBot.strengthenBotOpeningHandGuaranteed(gameState, botId, humanId);
  } else {
    const pressure = redisData.roundPressure || "fair";
    biasBotInitialHand(gameState, botId, {
      ...(redisData.botDifficulty || {}),
      pressure,
    }, humanId);
  }
  if (humanId && !isPracticeState(redisData)) {
    redisData.openingPairTarget = randomInteger(1, 2);
    redisData.openingPairCalibration = cardFlow.calibrateOpeningHand(gameState, humanId, {
      pairTarget: redisData.openingPairTarget,
    });
    if (redisData.jokerAssistedRound) {
      cardFlow.reserveJokersInDeck(gameState, humanId, redisData.jokerAssistCount);
    }
  }
  return gameState;
};

/**
 * Full pipeline used by every bot round:
 * 1) select scripted winner (no cards)
 * 2) deal cards
 * 3) natural opening bias toward script
 *
 * Kept for callers that already have a dealt gameState (legacy); prefers before-deal flow via startBotRoundNow.
 */
const applyScriptedRoundToGameState = async (
  gameState,
  redisData,
  botId,
  humanId,
  context = {}
) => {
  // If winner not chosen yet, choose now (should already be chosen before deal)
  if (redisData.scriptedWinner !== "bot" && redisData.scriptedWinner !== "human") {
    await selectScriptedWinnerBeforeDeal(redisData, botId, humanId, context);
  }
  applyNaturalBiasAfterDeal(gameState, redisData, botId, humanId);
  return {
    outcome: {
      botWins: redisData.scriptedBotWins,
      scriptedWinner: redisData.scriptedWinner,
      botWinProbability: redisData.scriptedBotWinProbability,
      factors: redisData.scriptedFactors,
    },
    roundPressure: redisData.roundPressure,
    gameState,
  };
};

const getHumanPlayerId = (redisData) => {
  const fromGenerated = redisData?.generatedFor || redisData?.roomStats?.generatedFor;
  if (fromGenerated && !isBotId(fromGenerated)) return String(fromGenerated);
  const players = (redisData?.players || []).map((player) => (
    typeof player === "string" ? player : player?.telegramId
  ));
  return players.map(String).find((id) => id && !isBotId(id)) || null;
};

const refreshBotDifficulty = async (redisData, userId) => {
  const stats = await getUserGameStats(userId);
  const botDifficulty = buildBotDifficultyProfile(stats);
  const ledger = await houseBot.loadHouseBotLedger(redis, userId);
  const roomGamesPlayed = Math.max(
    0,
    Math.floor(Number(redisData.roomStats?.gamesPlayed || 0))
  );
  const houseControl = houseBot.buildHouseControlProfile({
    difficulty: botDifficulty,
    ledger,
    gamesPlayed: stats.gamesPlayed,
    roomGamesPlayed,
  });

  redisData.botDifficulty = botDifficulty;
  redisData.targetBotWinRate = houseControl.targetWinRate;
  // Never leave fair on rooms that already played 6+ rounds
  const pressure = houseBot.clampPressureAfterSixGames(
    houseControl.pressure,
    roomGamesPlayed,
    true
  );
  redisData.housePressure = pressure;
  redisData.houseControl = { ...houseControl, pressure };
  redisData.roomStats = {
    ...(redisData.roomStats || {}),
    botDifficulty,
    targetBotWinRate: houseControl.targetWinRate,
    housePressure: pressure,
    houseControl: redisData.houseControl,
  };
  return { ...botDifficulty, pressure, houseControl: redisData.houseControl };
};

const recordManagedBotRoundOutcome = async (redisData, botWon) => {
  const humanId = getHumanPlayerId(redisData);
  if (!humanId || isPracticeState(redisData)) return null;
  if (Number(redisData.managedBonusIntroStage) >= 1 && Number(redisData.managedBonusIntroStage) <= 3) {
    return null;
  }
  try {
    return await houseBot.recordHouseBotOutcome(redis, humanId, Boolean(botWon));
  } catch (error) {
    console.error("[botgamer] house ledger update failed:", error.message);
    return null;
  }
};

const scheduleManagedBotCall = (req, roomId, targetUserId, turnToken, botId) => {
  if (!targetUserId || !turnToken || isBotId(targetUserId)) return;
  setTimeout(async () => {
    try {
      const roomStateText = await redis.get(`room:${roomId}`);
      const state = roomStateText ? JSON.parse(roomStateText) : null;
      if (
        !state?.managedBotRoom
        || state.status !== "playing"
        || state.gameEnded
        || String(state.turn || "") !== String(targetUserId)
        || String(state.turnToken || "") !== String(turnToken)
        || String(state.automatedCallTurnToken || "") === String(turnToken)
      ) return;

      const callLock = await redis.set(
        `room:${roomId}:auto-call:${Number(state.turnGeneration || 0)}`,
        "1",
        { NX: true, EX: 30 }
      );
      if (!callLock) return;

      const actionLockKey = `room:${roomId}:turn-action-lock`;
      const actionLockToken = `${Date.now()}-${Math.random()}`;
      const actionLock = await redis.set(actionLockKey, actionLockToken, { NX: true, EX: 8 });
      if (!actionLock) return;

      try {
        const latestRoomStateText = await redis.get(`room:${roomId}`);
        const latestState = latestRoomStateText ? JSON.parse(latestRoomStateText) : null;
        if (
          !latestState?.managedBotRoom
          || latestState.status !== "playing"
          || latestState.gameEnded
          || String(latestState.turn || "") !== String(targetUserId)
          || String(latestState.turnToken || "") !== String(turnToken)
          || String(latestState.automatedCallTurnToken || "") === String(turnToken)
        ) return;

        const target = (latestState.players || []).find((player) => (
          String(player.telegramId) === String(targetUserId)
        ));
        const callPayload = {
          roomId: String(roomId),
          fromUserId: String(botId),
          targetUserId: String(targetUserId),
          at: new Date().toISOString(),
          nonce: `${Date.now()}-${Math.random()}`,
          automated: true,
          turnToken: String(turnToken),
        };
        latestState.lastCall = callPayload;
        latestState.automatedCallTurnToken = String(turnToken);
        await redis.set(`room:${roomId}`, JSON.stringify(latestState));
        const io = getIo(req);
        if (target?.socketId && io) {
          io.to(target.socketId).emit("player_call", callPayload);
        }
      } finally {
        await redis.eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            end
            return 0`,
          { keys: [actionLockKey], arguments: [actionLockToken] }
        );
      }
    } catch (error) {
      console.error(`[botgamer] managed call failed for room ${roomId}:`, error);
    }
  }, MANAGED_BOT_CALL_DELAY_MS);
};

const scheduleManagedBotCallForCurrentTurn = async (req, roomId) => {
  try {
    const roomStateText = await redis.get(`room:${roomId}`);
    const state = roomStateText ? JSON.parse(roomStateText) : null;
    if (!state?.managedBotRoom || state.status !== "playing" || state.gameEnded) return;
    const targetUserId = String(state.turn || "");
    if (!targetUserId || isBotId(targetUserId)) return;
    const botId = String(
      state.botProfile?.id
      || (state.players || []).find((player) => isBotId(player.telegramId))?.telegramId
      || ""
    );
    scheduleManagedBotCall(req, roomId, targetUserId, state.turnToken, botId);
  } catch (error) {
    console.error(`[botgamer] could not schedule managed call for ${roomId}:`, error);
  }
};

const performManagedBotLeave = async (req, roomId, redisData, botId, humanId) => {
  if (!redisData?.managedBotRoom || !humanId || !botId) return false;
  const replacementFee = Number(redisData.managedLeaveReplacementFee || 0);
  if (!replacementFee) return false;

  const io = getIo(req);
  const humanPlayer = (redisData.players || []).find((player) => (
    String(player.telegramId) === String(humanId)
  ));
  const settlement = await finalizeRoomLedger(roomId, "managed-bot-left", {
    leavePenaltyPlayerId: String(botId),
    leavePenaltyRate: 0.5,
    leavePenaltyReason: "managed-bot-left",
  });

  await houseBot.recordManagedBotLeave(redis, humanId);
  const transitionedRoom = await transitionManagedBotRoomToWaiting({
    roomId,
    humanId,
    botId,
    roomStats: settlement,
    replacementFee,
  });
  await redis.del("rooms:list");

  await emitBalanceUpdates(io, [humanId], {
    socketByUserId: humanPlayer?.socketId ? { [String(humanId)]: humanPlayer.socketId } : {},
  });

  Object.assign(redisData, {
    status: "waiting",
    players: humanPlayer ? [{ ...humanPlayer, bot: false }] : [{ telegramId: String(humanId), socketId: null }],
    roomStats: transitionedRoom.roomStats,
    managedBotDeparted: true,
    managedReplacementFee: replacementFee,
    turn: null,
    playerCards: null,
    deck: null,
    laidCards: [],
    lastPick: null,
    lastLay: null,
    lastCall: null,
    automatedCallTurnToken: null,
    gameEnded: false,
    gameResult: null,
    paused: false,
    inactiveReason: null,
    inactiveMessage: null,
    leaveVote: null,
    rematch: null,
    botReadyPending: false,
    botReadyAt: null,
  });
  await emitBotState(req, roomId, redisData);
  if (io) {
    io.emit("room_unavailable", { roomId: String(roomId) });
  }
  return true;
};

const runBotTurn = async (req, roomId, expectedRoundGeneration = null) => {
  // Longer lock: human-like think times can exceed 5s
  const lockKey = `room:${roomId}:bot-lock`;
  const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 20 });
  if (!lockAcquired) return;

  try {
    const roomStateText = await redis.get(`room:${roomId}`);
    const redisData = roomStateText ? JSON.parse(roomStateText) : null;
    if (!isBotGameState(redisData) || redisData.gameEnded || redisData.status !== "playing") return;
    if (
      expectedRoundGeneration
      && String(redisData.turnToken || "") !== String(expectedRoundGeneration)
    ) return;
    if (redisData.botReadyPending) return;

    const botId = String(redisData.turn || "");
    if (!isBotId(botId)) return;

    redisData.botActionCounts = redisData.botActionCounts || { picks: 0, lays: 0 };

    const humanId = getHumanPlayerId(redisData);
    const humanHand = humanId ? (redisData.playerCards?.[humanId] || []) : [];
    const roomGamesPlayed = Math.max(
      0,
      Math.floor(Number(redisData.roomStats?.gamesPlayed || 0))
    );
    let pressure = redisData.roundPressure
      || redisData.housePressure
      || redisData.houseControl?.pressure
      || redisData.roomStats?.housePressure
      || "fair";
    pressure = houseBot.clampPressureAfterSixGames(
      pressure,
      roomGamesPlayed,
      redisData.scriptedWinner !== "human"
    );
    const botHand = redisData.playerCards?.[botId] || [];
    let pickedCard = false;
    let pickedCardKey = null;
    if (botHand.length === 10) {
      const topLaid = redisData.laidCards?.[redisData.laidCards.length - 1];
      if (shouldPickLaidCard(
        botHand,
        topLaid,
        pressure,
        Math.random,
        humanHand
      )) {
        const taken = redisData.laidCards.pop();
        pickedCardKey = houseBot.cardKey(taken);
        redisData.playerCards[botId].push(taken);
        redisData.botActionCounts.picks += 1;
        redisData.lastPick = {
          playerId: botId,
          source: "laid",
          cardKey: pickedCardKey,
          at: new Date().toISOString(),
          nonce: `${Date.now()}-${Math.random()}`,
        };
        markTurnActivity(redisData);
        pickedCard = true;
      } else if (refillDeckFromLaidCards(redisData)) {
        maybeBiasBotDeckDraw(redisData, botId, humanHand);
        const drawn = redisData.deck.pop();
        pickedCardKey = houseBot.cardKey(drawn);
        redisData.playerCards[botId].push(drawn);
        redisData.botActionCounts.picks += 1;
        redisData.lastPick = {
          playerId: botId,
          source: "deck",
          cardKey: pickedCardKey,
          at: new Date().toISOString(),
          nonce: `${Date.now()}-${Math.random()}`,
        };
        markTurnActivity(redisData);
        pickedCard = true;
      }
    }

    if (pickedCard) {
      await emitBotState(req, roomId, redisData);
      await wait(houseBot.getHumanLikePickToLayDelayMs());
    }

    const winAnalysis = analyzeWinningHand(redisData.playerCards?.[botId] || []);
    const botHandLength = (redisData.playerCards?.[botId] || []).length;
    if (redisData.minPicksBeforeWin == null) {
      redisData.minPicksBeforeWin = houseBot.getMinPicksBeforeWin();
    }
    const minPlayMet = houseBot.hasMetMinPlayBeforeWin(
      redisData.botActionCounts,
      redisData.minPicksBeforeWin
    );
    // Scripted human win: bot holds a legal hand and dumps instead of declaring.
    const mustHoldForHumanScript = redisData.scriptedWinner === "human";
    // Bot finishes only after 5–8 picks so guaranteed / take wins feel natural.
    const mustHoldForMinPlay = !minPlayMet;
    const canDeclareBotWin = (
      winAnalysis.isWinning
      && botHandLength === 11
      && !mustHoldForHumanScript
      && !mustHoldForMinPlay
    );

    if (canDeclareBotWin) {
      await wait(randomInteger(400, 1400));
      if (redisData.cardFlowPlan) {
        console.info("[card-flow] managed round completed", {
          event: "managed_card_flow_round_completed",
          roomId: String(roomId),
          scheduledWinner: redisData.cardFlowPlan.scheduledWinner,
          actualWinner: "bot",
          initialPredictedPicks: redisData.cardFlowPlan.initialPredictedPicks,
          finalPredictedPicks: redisData.cardFlowPlan.currentPredictedPicks,
          actualHumanPicks: Number(redisData.humanActionCounts?.picks || 0),
          finalHumanDistance: redisData.cardFlowPlan.structuralDistance,
          nearMissTarget: redisData.cardFlowPlan.nearMissTarget,
          jokerAssisted: redisData.cardFlowPlan.jokerAssisted,
          jokersDelivered: redisData.cardFlowPlan.jokersDelivered,
        });
      }
      redisData.status = "ended";
      redisData.gameEnded = true;
      redisData.turn = null;
      redisData.gameResult = buildWinnerResult(redisData, botId, winAnalysis);
      const roundPlayers = (redisData.players || []).map((player) => player.telegramId);
      redisData.rematch = createRematchState(
        roundPlayers,
        Date.now(),
        {
          entryFee: redisData.roomStats?.entryFee,
          // Bot "thinks" 1–4s before showing Ready
          autoReadyBots: false,
        }
      );
      await updateRoomStatus(roomId, "ended");
      if (isPracticeState(redisData)) {
        redisData.roomStats = {
          ...(redisData.roomStats || {}),
          practice: true,
          botGame: true,
        };
      } else {
        redisData.roomStats = await recordRoomGameResult(roomId, botId, roundPlayers, {
          jokerBonus: false,
          managedBonusIntroPlayerId: redisData.managedBonusIntroStage ? humanId : null,
        });
        await recordManagedBotRoundOutcome(redisData, true);
        if (requiresManagedRoomRotation(redisData)) {
          redisData.managedRotationRequired = true;
          redisData.rematch.readyPlayerIds = [];
        }
        const settlement = redisData.roomStats?.lastSettlement || null;
        if (settlement) {
          redisData.gameResult = {
            ...redisData.gameResult,
            roundPot: settlement.roundPot,
            roundPayout: settlement.winnerPayout,
            winnerId: settlement.winnerId || botId,
          };
        }
        await emitBalanceUpdates(getIo(req), roundPlayers, {
          socketByUserId: buildSocketByUserId(redisData.players),
          settlement,
        });
      }
      await emitBotState(req, roomId, redisData);
      if (!redisData.managedRotationRequired) {
        scheduleBotRematchReady(req, roomId);
      }
      await reconcileConnectedUsers(getIo(req));
      return;
    }

    // Hold-back: dump a card and keep playing (min-play gate or scripted human win).
    const updatedHand = redisData.playerCards?.[botId] || [];
    let botLaidCard = null;
    if (updatedHand.length === 11) {
      const excludeKeys = [];
      if (pickedCardKey) excludeKeys.push(pickedCardKey);
      if (redisData.lastPick?.cardKey) excludeKeys.push(redisData.lastPick.cardKey);
      const excludeRanks = [];
      excludeRanks.push(...(redisData.cardFlowPlan?.helpfulRanks || []));
      const neverRepeatRank = redisData.cardFlowPlan?.lastBotLaidRank || null;
      const discardIndex = chooseDiscardIndex(updatedHand, humanHand, pressure, {
        excludeCardKeys: excludeKeys,
        excludeRanks,
        neverRepeatRank,
      });
      const [discardedCard] = updatedHand.splice(discardIndex, 1);
      // Safety: if we somehow still held the just-picked card as only option, don't re-lay it
      if (pickedCardKey && houseBot.cardKey(discardedCard) === pickedCardKey && updatedHand.length > 0) {
        updatedHand.push(discardedCard);
        const altIndex = chooseDiscardIndex(updatedHand, humanHand, pressure, {
          excludeCardKeys: [pickedCardKey],
          excludeRanks,
          neverRepeatRank,
        });
        const [altCard] = updatedHand.splice(altIndex, 1);
        botLaidCard = altCard;
      } else {
        botLaidCard = discardedCard;
      }
      redisData.laidCards = redisData.laidCards || [];
      redisData.laidCards.push(botLaidCard);
      redisData.botActionCounts.lays += 1;
      if (redisData.cardFlowPlan) {
        redisData.cardFlowPlan.lastBotLaidRank = String(botLaidCard?.rank || "");
        cardFlow.refreshCardFlowPlan(redisData, humanId);
      }
    }

    const playerIds = (redisData.players || []).map((player) => player.telegramId);
    const botIndex = playerIds.findIndex((playerId) => String(playerId) === botId);
    redisData.turn = playerIds[(botIndex + 1) % playerIds.length];
    markTurnActivity(redisData);
    if (botLaidCard) {
      redisData.lastLay = {
        playerId: botId,
        targetPlayerId: String(redisData.turn),
        card: botLaidCard,
        at: new Date().toISOString(),
        nonce: `${Date.now()}-${Math.random()}`,
      };
      redisData.lastCall = null;
    }

    await emitBotState(req, roomId, redisData);
    const completedBotTurns = Math.min(
      Number(redisData.botActionCounts?.picks || 0),
      Number(redisData.botActionCounts?.lays || 0)
    );
    if (
      redisData.managedLeaveThisRound
      && !isManagedFirstRound(redisData)
      && !requiresManagedRoomRotation(redisData)
      && completedBotTurns >= Number(redisData.managedLeaveAfterBotTurns || 0)
    ) {
      await performManagedBotLeave(req, roomId, redisData, botId, humanId);
      return;
    }
    scheduleManagedBotCall(
      req,
      roomId,
      redisData.turn,
      redisData.turnToken,
      botId
    );
  } finally {
    await redis.del(lockKey);
  }
};

const scheduleBotTurn = (req, roomId) => {
  const delay = houseBot.getHumanLikeTurnDelayMs();
  scheduleManagedBotCallForCurrentTurn(req, roomId);
  redis.get(`room:${roomId}`).then((roomStateText) => {
    const scheduledState = roomStateText ? JSON.parse(roomStateText) : null;
    const roundGeneration = scheduledState?.turnToken || null;
    setTimeout(() => {
      runBotTurn(req, roomId, roundGeneration).catch((error) => {
        console.error(`[botgamer] Bot turn failed for room ${roomId}:`, error);
      });
    }, delay);
  }).catch((error) => {
    console.error(`[botgamer] Could not schedule bot turn for room ${roomId}:`, error);
  });
};

/**
 * After a bot game ends, wait 1–4s then mark bot(s) ready for rematch.
 * Looks like a human deciding to play again.
 */
const scheduleBotRematchReady = (req, roomId, delayMs = null) => {
  const delay = delayMs == null ? randomInteger(1000, 4000) : delayMs;
  setTimeout(() => {
    finalizeBotRematchReady(req, roomId).catch((error) => {
      console.error(`[botgamer] bot rematch ready failed for ${roomId}:`, error);
    });
  }, delay);
};

const finalizeBotRematchReady = async (req, roomId) => {
  const roomStateText = await redis.get(`room:${roomId}`);
  const redisData = roomStateText ? JSON.parse(roomStateText) : null;
  if (!redisData?.rematch?.active || redisData.status !== "ended") return;

  const botIds = (redisData.players || [])
    .map((player) => String(player.telegramId || player))
    .filter((id) => isBotId(id));
  if (!botIds.length) return;

  const ready = new Set((redisData.rematch.readyPlayerIds || []).map(String));
  botIds.forEach((id) => ready.add(id));
  redisData.rematch.readyPlayerIds = [...ready];
  await emitBotState(req, roomId, redisData);

  // Lazy require avoids circular load (gameplay requires botgamer at top)
  try {
    const gameplay = require("./gameplay");
    if (typeof gameplay.resolveRematch === "function") {
      await gameplay.resolveRematch(req, roomId, redisData);
    }
  } catch (error) {
    console.error("[botgamer] resolveRematch after bot ready:", error.message);
  }
};

/**
 * After managed room is full + escrowed: wait as if bot is "ready", then deal.
 * Caller must leave status waiting with botReadyPending=true and fees escrowed.
 */
const finalizeManagedBotGameStart = async (req, roomId) => {
  const lockKey = `room:${roomId}:bot-start-lock`;
  const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 15 });
  if (!lockAcquired) return;

  try {
    const roomStateText = await redis.get(`room:${roomId}`);
    const redisData = roomStateText ? JSON.parse(roomStateText) : null;
    if (!redisData || !isBotGameState(redisData)) return;
    if (!redisData.botReadyPending) return;
    if (redisData.status === "playing" && redisData.playerCards) return;

    const room = await getRoom(roomId);
    if (!room || room.playerCount < room.maxPlayers) return;

    const playerIds = (room.players || []).map(String);
    const botId = String(
      redisData.botProfile?.id
      || playerIds.find((id) => isBotId(id))
      || room.creatorId
    );
    const humanId = getHumanPlayerId(redisData)
      || playerIds.find((id) => !isBotId(id));

    if (humanId) {
      await refreshBotDifficulty(redisData, humanId);
    }

    // Bot is always creator — startBotRoundNow: script winner → deal → natural bias
    const starterId = String(room.creatorId || botId);
    await startBotRoundNow(redisData, playerIds, starterId, humanId, {
      roomId,
      trigger: "managed-ready-start",
    });
    redisData.status = "playing";

    await updateRoomStatus(roomId, "playing");
    await redis.set(`room:${roomId}`, JSON.stringify(redisData));
    await redis.del("rooms:list");

    const io = getIo(req);
    if (io) {
      const payloadRoom = await getRoom(roomId);
      (redisData.players || []).forEach((player) => {
        if (player.socketId) {
          io.to(player.socketId).emit(
            "room_update",
            buildRoomUpdatePayload(payloadRoom || room, redisData, player.telegramId)
          );
        }
      });
      io.emit("room_unavailable", { roomId });
    }

    scheduleBotTurn(req, roomId);
  } catch (error) {
    console.error(`[botgamer] finalizeManagedBotGameStart failed for ${roomId}:`, error);
  } finally {
    await redis.del(lockKey);
  }
};

/**
 * Schedule natural "bot getting ready" delay then deal cards.
 * Used only for managed bot rooms (not practice).
 */
const scheduleManagedBotGameStart = (req, roomId, delayMs = null) => {
  const delay = delayMs == null ? houseBot.getManagedBotReadyDelayMs() : delayMs;
  setTimeout(() => {
    finalizeManagedBotGameStart(req, roomId).catch((error) => {
      console.error(`[botgamer] managed start failed for room ${roomId}:`, error);
    });
  }, delay);
};

/**
 * Initialize a managed/practice bot round.
 *
 * Order (required for natural house control):
 *  1. Select scripted winner (bot | human) — NO cards yet
 *  2. Deal cards
 *  3. Bias opening hands toward that outcome (looks like luck, not a flip)
 */
const startBotRoundNow = async (redisData, playerIds, starterId, humanId, context = {}) => {
  const botId = String(
    redisData.botProfile?.id
    || playerIds.find((id) => isBotId(id))
  );

  // 1) Winner known before deal
  await selectScriptedWinnerBeforeDeal(redisData, botId, humanId, context);
  if (redisData.scriptedWinner !== "bot" && redisData.scriptedWinner !== "human") {
    // Hard fallback — should never happen
    redisData.scriptedWinner = "bot";
    redisData.scriptedBotWins = true;
    redisData.scriptedWinnerId = String(botId);
    redisData.roundPressure = "take";
    redisData.scriptedGuaranteed = false;
  }

  // Guaranteed schedule slot: max opening hand construction for the bot.
  if (isGuaranteedBotWinRound(redisData)) {
    redisData.roundPressure = "take";
    redisData.housePressure = "take";
  }

  // 2) Deal only after winner is fixed
  const initialGameState = createInitialGameState(playerIds, starterId);

  // 3) Natural-looking open bias toward the script
  applyNaturalBiasAfterDeal(initialGameState, redisData, botId, humanId);

  redisData.turn = initialGameState.turn;
  redisData.playerCards = initialGameState.playerCards;
  redisData.deck = initialGameState.deck;
  redisData.laidCards = initialGameState.laidCards || [];
  redisData.botActionCounts = { picks: 0, lays: 0 };
  redisData.humanActionCounts = { picks: 0, lays: 0 };
  // Roll once per round so neither side can finish in the first few turns.
  redisData.minPicksBeforeWin = houseBot.getMinPicksBeforeWin();
  redisData.lastPick = null;
  redisData.lastLay = null;
  redisData.lastCall = null;
  redisData.botReadyPending = false;
  redisData.gameEnded = false;
  redisData.gameResult = null;
  if (!isPracticeState(redisData) && humanId) {
    cardFlow.createCardFlowPlan(redisData, humanId, {
      pairTarget: redisData.openingPairTarget,
      pairRanks: redisData.openingPairCalibration?.pairRanks || [],
      nearMissTarget: randomInteger(1, 3),
      jokerAssisted: redisData.jokerAssistedRound,
      jokerAssistCount: redisData.jokerAssistCount,
    });
  } else {
    redisData.cardFlowPlan = null;
  }
  markTurnActivity(redisData);

  console.info("[botgamer] cards dealt after scripted winner", {
    event: "bot_round_dealt_after_script",
    roomId: context.roomId ? String(context.roomId) : null,
    trigger: context.trigger || "round-start",
    scriptedWinner: redisData.scriptedWinner,
    scriptedWinnerId: redisData.scriptedWinnerId,
    roundPressure: redisData.roundPressure,
    initialPredictedPicks: redisData.cardFlowPlan?.initialPredictedPicks ?? null,
    nearMissTarget: redisData.cardFlowPlan?.nearMissTarget ?? null,
    openingPairTarget: redisData.cardFlowPlan?.openingPairTarget ?? null,
    jokerAssisted: redisData.cardFlowPlan?.jokerAssisted ?? false,
    jokerAssistCount: redisData.cardFlowPlan?.jokerAssistCount ?? 0,
    cardsDealt: true,
  });

  return redisData;
};

/**
 * Soft deck help for the human when they are scripted to win (managed rooms).
 * Chance-only: never blocks declare; only reorders top of deck occasionally.
 * Guaranteed bot rounds bias *against* the human so bot wins stay likely but
 * a real legal hand is still always cashable.
 */
const maybeBiasHumanDeckDraw = (redisData, humanId) => {
  if (!redisData || !Array.isArray(redisData.deck) || redisData.deck.length === 0) {
    return false;
  }
  if (!isPracticeState(redisData) && redisData.cardFlowPlan) {
    const analysis = cardFlow.refreshCardFlowPlan(redisData, humanId);
    if (!analysis) return false;
    const plan = redisData.cardFlowPlan;
    const humanRound = redisData.scriptedWinner === "human";
    const wantsHelp = humanRound
      || analysis.structuralDistance > Number(plan.nearMissTarget || 1);
    const jokerPending = humanRound
      && plan.jokerAssisted
      && Number(plan.jokersDelivered || 0) < Number(plan.jokerAssistCount || 0);
    const selected = cardFlow.selectHumanDeckCard(redisData.deck, analysis, {
      wantsHelp,
      allowJoker: jokerPending,
      preferJoker: jokerPending,
      lastRank: plan.lastHumanAcquiredRank || plan.lastControlledDeckRank,
    });
    if (!selected) return false;
    plan.lastControlledDeckRank = String(selected.rank || "");
    return true;
  }
  // Guaranteed bot-force: prefer dead cards so bot win stays probable (chance).
  if (isGuaranteedBotWinRound(redisData)) {
    const hand = redisData.playerCards?.[humanId] || [];
    return houseBot.biasDeckAgainstPlayer(redisData.deck, hand);
  }
  if (redisData.scriptedWinner !== "human") return false;
  // Soft help when human is scripted — ramps in after a couple of picks so
  // the win still feels earned, without ever denying a legal declare.
  if (redisData.minPicksBeforeWin == null) {
    redisData.minPicksBeforeWin = houseBot.getMinPicksBeforeWin();
  }
  if (!houseBot.hasMetSoftHelpPlayThreshold(
    redisData.humanActionCounts,
    redisData.minPicksBeforeWin
  )) {
    return false;
  }
  if (Math.random() > 0.45) return false;
  const hand = redisData.playerCards?.[humanId] || [];
  return houseBot.biasDeckForBotDraw(redisData.deck, hand, [], "take");
};

/**
 * Soft deck help for the bot when bot is scripted to win.
 * Builds toward a natural finish after ~5–8 picks (min-play hold-back),
 * without instant first-draw knockouts.
 */
const maybeBiasBotDeckDraw = (redisData, botId, humanHand = []) => {
  if (!redisData || redisData.scriptedWinner !== "bot") return false;
  if (redisData.minPicksBeforeWin == null) {
    redisData.minPicksBeforeWin = houseBot.getMinPicksBeforeWin();
  }
  const botCounts = redisData.botActionCounts || { picks: 0, lays: 0 };
  const softReady = houseBot.hasMetSoftHelpPlayThreshold(
    botCounts,
    redisData.minPicksBeforeWin
  );
  // Early picks: light / no finish feed so the round has length.
  // After soft-ready: full pressure toward the scripted bot win.
  if (!softReady && !isGuaranteedBotWinRound(redisData)) {
    return false;
  }
  const pressure = isGuaranteedBotWinRound(redisData)
    ? (softReady ? "take" : "fair")
    : (softReady ? (redisData.roundPressure || "fair") : "fair");
  if (
    (isGuaranteedBotWinRound(redisData) || pressure === "take")
    && Array.isArray(redisData.deck)
    && redisData.deck.length
  ) {
    return houseBot.biasDeckForBotDraw(
      redisData.deck,
      redisData.playerCards?.[botId] || [],
      humanHand,
      pressure
    );
  }
  return houseBot.biasDeckForBotDraw(
    redisData.deck,
    redisData.playerCards?.[botId] || [],
    humanHand,
    pressure
  );
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

const ensureManagedBotRoomForUser = async (io, userId, options = {}) => {
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

    if (!options.forceManaged) {
      const humanRoom = await getAffordableJoinableHumanRoom(user.balance);
      if (humanRoom) return null;
    }

    const existingRoom = await getWaitingManagedBotRoomForUser(cleanUserId);
    if (existingRoom) return existingRoom;

    const requestedFee = Number(options.entryFee || 0);
    const entryFee = selectManagedRoomEntryFee(user.balance, {
      minimumFee: requestedFee,
    });
    if (!entryFee || (requestedFee && entryFee < requestedFee)) return null;
    const identity = buildManagedBotIdentity();
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
    const userStats = await getUserGameStats(cleanUserId);
    const botDifficulty = buildBotDifficultyProfile(userStats);
    const ledger = await houseBot.loadHouseBotLedger(redis, cleanUserId);
    const houseControl = houseBot.buildHouseControlProfile({
      difficulty: botDifficulty,
      ledger,
      gamesPlayed: userStats.gamesPlayed,
    });
    const roomStats = {
      gamesPlayed: 0,
      winnerCounts: {},
      games: [],
      practice: false,
      botGame: true,
      managedBotRoom: true,
      generatedFor: cleanUserId,
      botProfile,
      targetBotWinRate: houseControl.targetWinRate,
      botDifficulty,
      housePressure: houseControl.pressure,
      houseControl,
      botResults: { gamesPlayed: 0, wins: 0, losses: 0 },
      entryFee,
    };

    const room = await createSystemRoomWithAvailableName({
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
    }, SYSTEM_ROOM_NAMES);
    if (!room) {
      await deleteSyntheticBot(botUser.telegramId);
      console.error("[botgamer] System room name pool is exhausted.");
      return null;
    }
    const redisData = {
      status: "waiting",
      players: [{ telegramId: botUser.telegramId, socketId: null, bot: true }],
      practice: false,
      botGame: true,
      managedBotRoom: true,
      generatedFor: cleanUserId,
      botProfile,
      botDifficulty,
      targetBotWinRate: houseControl.targetWinRate,
      housePressure: houseControl.pressure,
      houseControl,
      roomStats,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    await redis.set(`room:${room.id}`, JSON.stringify(redisData));
    await redis.set(`managed-bot-room:${cleanUserId}`, room.id, { EX: MANAGED_ROOM_TTL_SECONDS });
    await redis.del("rooms:list");
    if (io) io.emit("new_room_created", sanitizeRoom(room));
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
  let botUser = await ensureSyntheticBotBalance(
    redisData.botProfile.id,
    Number(entryFee || 0),
    MANAGED_BOT_STARTING_BALANCE_BIRR
  );
  if (!botUser) {
    botUser = await createSyntheticBot({
      telegramId: redisData.botProfile.id,
      displayName: redisData.botProfile.displayName || "Bot Player",
      balance: MANAGED_BOT_STARTING_BALANCE_BIRR,
    });
  }
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
    const userStats = await getUserGameStats(cleanUserId);
    const botDifficulty = buildBotDifficultyProfile(userStats);
    const houseControl = houseBot.buildHouseControlProfile({
      difficulty: botDifficulty,
      ledger: { games: 0, botWins: 0, botLosses: 0, outcomes: [] },
      gamesPlayed: userStats.gamesPlayed,
    });

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
      targetBotWinRate: houseControl.targetWinRate,
      botDifficulty,
      housePressure: houseControl.pressure,
      houseControl,
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

    const redisData = {
      status: "playing",
      players: [
        { telegramId: botId, socketId: null, bot: true },
        { telegramId: cleanUserId, socketId: socketId || null },
      ],
      practice: true,
      botGame: true,
      botDifficulty,
      targetBotWinRate: houseControl.targetWinRate,
      housePressure: houseControl.pressure,
      houseControl,
      roomStats,
      botActionCounts: { picks: 0, lays: 0 },
      lastPick: null,
      lastLay: null,
      lastCall: null,
      lastActivityAt: new Date().toISOString(),
    };
    await startBotRoundNow(
      redisData,
      [botId, cleanUserId],
      cleanUserId,
      cleanUserId,
      { roomId: room.id, trigger: "practice-start" }
    );

    await redis.set(`room:${room.id}`, JSON.stringify(redisData));
    await redis.del("rooms:list");
    scheduleBotTurn(req, room.id);

    return res.status(201).json({
      success: true,
      room: sanitizeRoom(room),
      players: room.players,
      redisData: sanitizeRedisData(redisData),
    });
  } catch (error) {
    console.error("[botgamer] start error:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
module.exports.scheduleBotTurn = scheduleBotTurn;
module.exports.scheduleManagedBotCallForCurrentTurn = scheduleManagedBotCallForCurrentTurn;
module.exports.scheduleBotRematchReady = scheduleBotRematchReady;
module.exports.scheduleManagedBotGameStart = scheduleManagedBotGameStart;
module.exports.finalizeManagedBotGameStart = finalizeManagedBotGameStart;
module.exports.startBotRoundNow = startBotRoundNow;
module.exports.selectScriptedWinnerBeforeDeal = selectScriptedWinnerBeforeDeal;
module.exports.applyNaturalBiasAfterDeal = applyNaturalBiasAfterDeal;
module.exports.applyScriptedRoundToGameState = applyScriptedRoundToGameState;
module.exports.maybeBiasHumanDeckDraw = maybeBiasHumanDeckDraw;
module.exports.maybeBiasBotDeckDraw = maybeBiasBotDeckDraw;
module.exports.isGuaranteedBotWinRound = isGuaranteedBotWinRound;
module.exports.isPracticeState = isPracticeState;
module.exports.isBotGameState = isBotGameState;
module.exports.isBotId = isBotId;
module.exports.biasBotInitialHand = biasBotInitialHand;
module.exports.analyzeWinningHand = analyzeWinningHand;
module.exports.chooseDiscardIndex = chooseDiscardIndex;
module.exports.shouldPickLaidCard = shouldPickLaidCard;
module.exports.refreshBotDifficulty = refreshBotDifficulty;
module.exports.recordManagedBotRoundOutcome = recordManagedBotRoundOutcome;
module.exports.getHumanPlayerId = getHumanPlayerId;
module.exports.ensureManagedBotRoomForUser = ensureManagedBotRoomForUser;
module.exports.reconcileConnectedUsers = reconcileConnectedUsers;
module.exports.cleanupManagedBotRoomForUser = cleanupManagedBotRoomForUser;
module.exports.deleteManagedBotRoom = deleteManagedBotRoom;
module.exports.fundManagedBotForRound = fundManagedBotForRound;
module.exports.BOT_PREFIX = BOT_PREFIX;
module.exports.BOT_ENTRY_FEES = BOT_ENTRY_FEES;
module.exports.getManagedBalanceBandFee = getManagedBalanceBandFee;
module.exports.selectManagedRoomEntryFee = selectManagedRoomEntryFee;
