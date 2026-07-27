const express = require('express');
const router = express.Router();
const { redis } = require('../config/redis');
const {
    MIN_ROOM_ENTRY_BIRR,
    ROOM_ENTRY_STEP_BIRR,
    isValidRoomEntryBirr,
} = require("../config/economy");
const {
    escrowRoomEntryFees,
    deleteRoom,
    getRoom,
    getUser,
    finalizeRoomLedger,
    recordRoomGameResult,
    removePlayerFromRoom,
    updateRoomStatus,
    updateRoomRematchConfig,
} = require("../db/store");
const { createInitialGameState } = require("../services/gameService");
const { getTimedOutOpponentTurn, markTurnActivity } = require("../services/turnInactivity");
const { getGameActionStateError } = require("../services/gameActionState");
const { requiresManagedRoomRotation } = require("../services/managedRoomLifecycle");
const {
    createRematchState,
    getRematchOutcome,
    getRematchStatus,
    isBotPlayerId,
    restartRematchCountdown,
} = require("../services/rematch");
const { buildSocketByUserId, emitBalanceUpdates } = require("../services/balanceEvents");
const {
    rotateManagedRoom,
    shouldWarnForMissingSocket,
} = require("../services/managedRoomRotation");
const {
    buildRoomUpdatePayload,
    sanitizeGameResult,
    sanitizeRedisData,
    sanitizeRoom,
} = require("../services/playerPayload");
const {
    fundManagedBotForRound,
    ensureManagedBotRoomForUser,
    getHumanPlayerId,
    isBotGameState,
    reconcileConnectedUsers,
    refreshBotDifficulty,
    recordManagedBotRoundOutcome,
    scheduleManagedBotCallForCurrentTurn,
    scheduleBotTurn,
    scheduleBotRematchReady,
    startBotRoundNow,
    maybeBiasHumanDeckDraw,
    isPracticeState,
} = require("./botgamer");
const houseBot = require("../services/houseBotController");
const cardFlow = require("../services/cardFlowController");

const getMoneyEventUserIds = (roomStats = {}) => [
    ...Object.keys(roomStats.payouts || {}),
    ...Object.keys(roomStats.refunds || {}),
];

const acquireRoomActionLock = async (roomId, action, ttlSeconds = 8) => {
    const key = `room:${roomId}:${action}-lock`;
    const token = `${Date.now()}-${Math.random()}`;
    const result = await redis.set(key, token, { NX: true, EX: ttlSeconds });
    return result === "OK" ? { key, token } : null;
};

const releaseRoomActionLock = async (lock) => {
    if (!lock?.key) return;
    await redis.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        end
        return 0`,
        { keys: [lock.key], arguments: [lock.token] }
    );
};

// Helper to fetch current room state from Redis
const getRoomState = async (roomId) => {
    const data = await redis.get(`room:${roomId}`);
    return data ? JSON.parse(data) : null;
};

const isManagedBotRoomState = (redisData = null, roomData = null) => Boolean(
    redisData?.managedBotRoom
    || redisData?.roomStats?.managedBotRoom
    || roomData?.roomStats?.managedBotRoom
);

const isJoker = (card) => String(card?.rank || "").toUpperCase() === "JOKER";

const updateHumanCardFlow = (redisData, userId, roomId, acquiredCard = null) => {
    const plan = redisData?.cardFlowPlan;
    if (!plan) return null;
    const previousDistance = plan.structuralDistance;
    if (acquiredCard) {
        plan.lastHumanAcquiredRank = String(acquiredCard.rank || "");
        if (isJoker(acquiredCard) && plan.jokerAssisted) {
            plan.jokersDelivered = Math.min(
                Number(plan.jokerAssistCount || 0),
                Number(plan.jokersDelivered || 0) + 1
            );
        }
    }
    const analysis = cardFlow.refreshCardFlowPlan(redisData, userId);
    if (analysis && previousDistance !== analysis.structuralDistance) {
        console.info("[card-flow] prediction revised", {
            event: "managed_card_flow_prediction_revised",
            roomId: String(roomId),
            humanId: String(userId),
            previousDistance,
            structuralDistance: analysis.structuralDistance,
            predictedTotalPicks: analysis.predictedTotalPicks,
            revision: plan.predictionRevision,
        });
    }
    return analysis;
};

const getRankCounts = (cards = [], includeJokers = false) => {
    return cards.reduce((acc, card) => {
        const rank = card?.rank;
        if (!rank) return acc;
        if (!includeJokers && isJoker(card)) return acc;
        acc[rank] = (acc[rank] || 0) + 1;
        return acc;
    }, {});
};

const getRankCountPattern = (cards = [], includeJokers = false) => {
    const rankCounts = getRankCounts(cards, includeJokers);
    return Object.values(rankCounts).sort((a, b) => b - a);
};

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
    const naturalCounts = getRankCountPattern(cards, false);
    const naturalPattern = matchesWinningPattern(naturalCounts);
    const jokerBonus = false;

    return {
        isWinning: naturalPattern || canCompletePatternWithJokers(naturalCounts, jokerCount),
        jokerCount,
        usesJoker: jokerCount > 0 && !naturalPattern,
        jokerBonus,
    };
};

const getWinningReason = (analysis) => {
    if (analysis.jokerBonus) return "natural-4-3-3-with-joker-bonus";
    if (analysis.usesJoker) return "joker-completed-hand";
    return "valid-hand";
};

const buildWinnerResult = (redisData, winnerId, analysis = analyzeWinningHand(redisData.playerCards?.[winnerId] || [])) => {
    const winnerCards = redisData.playerCards?.[winnerId] || [];
    const revealedHands = {};
    const winnerGroups = Object.entries(getRankCounts(winnerCards, true))
        .map(([rank, count]) => ({ rank, count }))
        .sort((a, b) => b.count - a.count);

    const playerCardCounts = {};
    Object.entries(redisData.playerCards || {}).forEach(([playerId, cards]) => {
        playerCardCounts[playerId] = cards.length;
        revealedHands[playerId] = cards.map((card) => ({ ...card }));
    });

    return {
        winnerId,
        winners: [winnerId],
        winnerPattern: "4-3-3-1",
        winnerGroups,
        playerCardCounts,
        revealedHands,
        reason: getWinningReason(analysis),
        jokerCount: analysis.jokerCount,
        jokerBonus: analysis.jokerBonus,
        endedAt: new Date().toISOString(),
    };
};

const ensureGameIsActive = (redisData, userId, res) => {
    const actionError = getGameActionStateError(redisData, userId);
    if (!actionError) return true;

    res.status(actionError.status).json({
        ...actionError.body,
        redisData: sanitizeRedisData(redisData),
    });
    return false;
};

const getPlayerIds = (redisData) => (redisData.players || []).map((p) => p.telegramId);

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

const moveTurnIfNeeded = (redisData, removedUserId, fallbackIds = getPlayerIds(redisData)) => {
    if (!fallbackIds.length) {
        redisData.turn = null;
        return;
    }

    const turnStillExists = fallbackIds.some((id) => String(id) === String(redisData.turn));
    if (!turnStillExists || String(redisData.turn) === String(removedUserId)) {
        redisData.turn = fallbackIds[0];
    }
};

const resetRoomToWaiting = (redisData) => {
    redisData.status = "waiting";
    redisData.turn = null;
    redisData.playerCards = {};
    redisData.deck = [];
    redisData.laidCards = [];
    redisData.gameEnded = false;
    redisData.gameResult = null;
    redisData.paused = false;
    redisData.creatorAway = false;
    redisData.inactiveReason = null;
    redisData.inactiveMessage = null;
    redisData.leaveVote = null;
    redisData.botActionCounts = { picks: 0, lays: 0 };
    redisData.humanActionCounts = { picks: 0, lays: 0 };
    redisData.minPicksBeforeWin = houseBot.getMinPicksBeforeWin();
    redisData.lastPick = null;
    redisData.lastLay = null;
    redisData.lastCall = null;
    redisData.turnActivityAt = null;
    redisData.rematch = null;
};

// Helper to save room state to Redis and emit update to clients
const saveAndEmitState = async (req, roomId, redisData, currentUserId, currentUserSocketId) => {
    redisData.lastActivityAt = new Date().toISOString();

    // Before emitting, ensure the acting player's socket ID is up-to-date in Redis.
    // This is crucial if they reconnected and got a new socket ID.
    if (currentUserId && currentUserSocketId && redisData.players) {
        const playerIndex = redisData.players.findIndex(p => String(p.telegramId) === String(currentUserId));
        if (playerIndex !== -1 && redisData.players[playerIndex].socketId !== currentUserSocketId) {
            if (process.env.DEBUG_GAME_EVENTS === "true") {
                console.log(`Updating socketId for active player ${currentUserId} from ${redisData.players[playerIndex].socketId} to ${currentUserSocketId}`);
            }
            redisData.players[playerIndex].socketId = currentUserSocketId;
        }
    }

    await redis.set(`room:${roomId}`, JSON.stringify(redisData));
    const io = req.app.get('io');

    if (io && redisData.players) {
        // To construct the full payload that the frontend expects,
        // we also need the room's static data from Postgres.
        const roomData = await getRoom(roomId);
        if (!roomData) {
            console.error(`[gameplay] Room ${roomId} not found in Postgres for emitting state.`);
            return;
        }

        if (process.env.DEBUG_GAME_EVENTS === "true") {
            console.log(`Emitting room_update to players in room ${roomId} after gameplay action.`);
        }
        redisData.players.forEach((p) => {
            if (p.socketId) {
                const payload = buildRoomUpdatePayload(roomData, redisData, p.telegramId);
                if (process.env.DEBUG_GAME_EVENTS === "true") {
                    console.log(`Emitting to user ${p.telegramId} via socket: ${p.socketId}`);
                }
                io.to(p.socketId).emit("room_update", payload);
            } else if (shouldWarnForMissingSocket(p.telegramId)) {
                console.warn(`  -> No socketId found for user ${p.telegramId} in room ${roomId}. Cannot emit update.`);
            }
        });
    }
};

const rotateManagedRoomSession = (req, roomId, redisData, options = {}) => (
    rotateManagedRoom({
        io: req.app.get("io"),
        redis,
        roomId,
        roomState: redisData,
        requestedUserId: options.requestedUserId,
        replacementPolicy: options.replacementPolicy,
        finalizeRoomLedger,
        deleteRoom,
        ensureManagedBotRoomForUser,
    })
);

const removeRematchPlayer = async (io, roomId, redisData, playerId, reason) => {
    const cleanPlayerId = String(playerId);
    const player = (redisData.players || []).find(
        (candidate) => String(candidate.telegramId) === cleanPlayerId
    );
    if (reason !== "left" && player?.socketId && io) {
        io.to(player.socketId).emit("rematch_removed", {
            roomId: String(roomId),
            userId: cleanPlayerId,
            reason,
        });
    }
    redisData.players = (redisData.players || []).filter(
        (candidate) => String(candidate.telegramId) !== cleanPlayerId
    );
    if (redisData.playerCards) delete redisData.playerCards[cleanPlayerId];
    redisData.rematch.participantIds = (redisData.rematch.participantIds || [])
        .map(String).filter((id) => id !== cleanPlayerId);
    redisData.rematch.readyPlayerIds = (redisData.rematch.readyPlayerIds || [])
        .map(String).filter((id) => id !== cleanPlayerId);
    redisData.rematch.removedPlayerIds = [
        ...new Set([...(redisData.rematch.removedPlayerIds || []).map(String), cleanPlayerId]),
    ];
    const updatedRoom = await removePlayerFromRoom(roomId, cleanPlayerId);
    const remainingIds = getPlayerIds(redisData).map(String);
    if (
        updatedRoom &&
        String(updatedRoom.creatorId) === cleanPlayerId &&
        remainingIds.length >= 2
    ) {
        await updateRoomRematchConfig(roomId, {
            creatorId: remainingIds[0],
            rematchRecruiting: Boolean(redisData.rematch.recruiting),
        });
    } else if (
        updatedRoom &&
        String(updatedRoom.creatorId) === cleanPlayerId &&
        remainingIds.length < 2
    ) {
        redisData.rematch.creatorAbandoned = true;
        redisData.rematch.recruiting = false;
        redisData.rematch.countdownPaused = false;
        redisData.rematch.deadlineAt = new Date().toISOString();
        await updateRoomRematchConfig(roomId, {
            maxPlayers: Math.max(remainingIds.length, 1),
            rematchRecruiting: false,
        });
    }
    await redis.del("rooms:list");
};

const returnRematchRoomToLobby = async (req, roomId, redisData, reason = "rematch-timeout") => {
    const io = req.app.get("io");
    const roomData = await getRoom(roomId);
    if (!roomData) return { returnedToLobby: true, deleted: true };
    const creatorId = String(roomData.creatorId);
    const currentIds = getPlayerIds(redisData).map(String);
    if (!currentIds.includes(creatorId)) {
        await deleteRoom(roomId, "creator-left-rematch");
        await redis.del(`room:${roomId}`);
        await redis.del("rooms:list");
        io?.emit("room_unavailable", { roomId });
        io?.emit("room_deleted", { roomId });
        return { returnedToLobby: true, deleted: true };
    }

    const sockets = (redisData.players || [])
        .filter((player) => player.socketId)
        .map((player) => ({ playerId: String(player.telegramId), socketId: player.socketId }));
    for (const playerId of currentIds) {
        if (playerId !== creatorId) await removePlayerFromRoom(roomId, playerId);
    }
    redisData.players = (redisData.players || []).filter(
        (player) => String(player.telegramId) === creatorId
    );
    const targetPlayerCount = Math.min(
        4,
        Math.max(2, Number(redisData.rematch?.targetPlayerCount || roomData.maxPlayers || 2))
    );
    const nextFee = Number(redisData.rematch?.proposedEntryFee || roomData.entryFee || 0);
    resetRoomToWaiting(redisData);
    redisData.roomStats = {
        ...(redisData.roomStats || {}),
        rematchRecruiting: false,
    };
    await updateRoomRematchConfig(roomId, {
        maxPlayers: targetPlayerCount,
        entryFee: nextFee,
        rematchRecruiting: false,
    });
    await updateRoomStatus(roomId, "waiting");
    await redis.del("rooms:list");
    await saveAndEmitState(req, roomId, redisData, creatorId);
    sockets.forEach(({ playerId, socketId }) => {
        io?.to(socketId).emit("rematch_returned_to_lobby", {
            roomId: String(roomId),
            userId: playerId,
            reason,
            creatorId,
        });
    });
    const updatedRoom = await getRoom(roomId);
    if (updatedRoom) io?.emit("new_room_created", sanitizeRoom(updatedRoom));
    return { returnedToLobby: true, deleted: false };
};

const startRematchRound = async (req, roomId, redisData, roomData, playerIds) => {
    const cleanPlayerIds = playerIds.map(String);
    const nextEntryFee = Number(redisData.rematch?.proposedEntryFee || roomData.entryFee || 0);
    const managedBotRoom = isManagedBotRoomState(redisData, roomData);
    const managedBotId = managedBotRoom
        ? String(
            redisData.botProfile?.id
            || redisData.roomStats?.botProfile?.id
            || roomData.roomStats?.botProfile?.id
            || cleanPlayerIds.find(isBotPlayerId)
            || ""
        )
        : null;
    if (managedBotRoom) {
        const humanIds = cleanPlayerIds.filter((playerId) => !isBotPlayerId(playerId));
        if (!managedBotId || !cleanPlayerIds.includes(managedBotId) || humanIds.length !== 1 || cleanPlayerIds.length !== 2) {
            throw new Error("Managed bot rematches require exactly one bot creator and one human player.");
        }
    }
    roomData = await updateRoomRematchConfig(roomId, {
        maxPlayers: managedBotRoom ? 2 : cleanPlayerIds.length,
        entryFee: isPracticeState(redisData) ? 0 : nextEntryFee,
        creatorId: managedBotRoom ? managedBotId : null,
        rematchRecruiting: false,
    });
    redisData.players = (redisData.players || []).filter((player) => (
        cleanPlayerIds.includes(String(player.telegramId))
    ));
    if (isPracticeState(redisData)) {
        redisData.roomStats = {
            ...(redisData.roomStats || {}),
            practice: true,
            botGame: true,
            entryFee: 0,
            currentRoundPot: 0,
        };
    } else {
        await fundManagedBotForRound(redisData, nextEntryFee);
        redisData.roomStats = await escrowRoomEntryFees(roomId, cleanPlayerIds, nextEntryFee);
        await emitBalanceUpdates(req.app.get("io"), cleanPlayerIds, {
            socketByUserId: buildSocketByUserId(redisData.players),
        });
    }
    const previousWinnerId = redisData.gameResult?.winnerId;
    const starterId = cleanPlayerIds.includes(String(previousWinnerId))
        ? previousWinnerId
        : (isBotGameState(redisData)
            ? (redisData.botProfile?.id || cleanPlayerIds.find(isBotPlayerId) || cleanPlayerIds[0])
            : cleanPlayerIds[0]);

    Object.assign(redisData, {
        status: "playing",
        gameEnded: false,
        gameResult: null,
        paused: false,
        inactiveReason: null,
        inactiveMessage: null,
        leaveVote: null,
        botActionCounts: { picks: 0, lays: 0 },
        humanActionCounts: { picks: 0, lays: 0 },
        minPicksBeforeWin: houseBot.getMinPicksBeforeWin(),
        lastPick: null,
        lastLay: null,
        lastCall: null,
        rematch: null,
        botReadyPending: false,
        botReadyAt: null,
        playerCards: null,
        deck: null,
        laidCards: [],
        turn: null,
    });

    if (isBotGameState(redisData)) {
        // Bot creator is already in the seat — deal immediately (no ready wait)
        const humanPlayerId = cleanPlayerIds.find((id) => !isBotPlayerId(id));
        await refreshBotDifficulty(redisData, humanPlayerId);
        await startBotRoundNow(
            redisData,
            cleanPlayerIds,
            starterId,
            humanPlayerId,
            { roomId, trigger: "rematch-start" }
        );
        redisData.status = "playing";
        await updateRoomStatus(roomId, "playing");
        await redis.del("rooms:list");
        await saveAndEmitState(req, roomId, redisData);
        scheduleBotTurn(req, roomId);
        return;
    }

    const nextGameState = createInitialGameState(cleanPlayerIds, starterId);
    Object.assign(redisData, {
        turn: nextGameState.turn,
        playerCards: nextGameState.playerCards,
        deck: nextGameState.deck,
        laidCards: nextGameState.laidCards,
        status: "playing",
    });
    markTurnActivity(redisData);
    await updateRoomStatus(roomId, "playing");
    await redis.del("rooms:list");
    await saveAndEmitState(req, roomId, redisData);
};

const resolveRematch = async (req, roomId, redisData, { forceDeadline = false } = {}) => {
    const io = req.app.get("io");
    if (requiresManagedRoomRotation(redisData)) {
        redisData.managedRotationRequired = true;
        if (redisData.rematch) redisData.rematch.readyPlayerIds = [];
        if (forceDeadline) {
            return rotateManagedRoomSession(req, roomId, redisData, {
                replacementPolicy: "if-connected",
            });
        }
        await saveAndEmitState(req, roomId, redisData);
        return { started: false, rotationRequired: true };
    }
    let status = getRematchStatus(redisData.rematch, getPlayerIds(redisData));
    if (!status) return { started: false };
    redisData.rematch = status.rematch;
    const outcome = getRematchOutcome(status, { forceDeadline });
    if (outcome === "paused") {
        await saveAndEmitState(req, roomId, redisData);
        return { started: false, paused: true };
    }
    if (redisData.rematch.creatorAbandoned) {
        await deleteRoom(roomId, "creator-left-rematch");
        await redis.del(`room:${roomId}`);
        await redis.del("rooms:list");
        io?.emit("room_unavailable", { roomId });
        io?.emit("room_deleted", { roomId });
        return { started: false, deleted: true };
    }
    let readyIds = status.readyPlayerIds;
    if (outcome === "waiting") {
        await saveAndEmitState(req, roomId, redisData);
        return { started: false };
    }
    if (outcome === "return-to-lobby") {
        return returnRematchRoomToLobby(req, roomId, redisData, "not-all-players-agreed");
    }
    const roomData = await getRoom(roomId);
    if (!roomData) return { started: false, deleted: true };
    try {
        await startRematchRound(req, roomId, redisData, roomData, readyIds);
    } catch (error) {
        const rawMessage = String(error.message || "");
        const insufficientPlayerId = rawMessage.startsWith("INSUFFICIENT_BALANCE:")
            ? rawMessage.split(":").slice(1).join(":")
            : null;
        if (!insufficientPlayerId) throw error;
        await removeRematchPlayer(
            io, roomId, redisData, insufficientPlayerId, "insufficient-balance"
        );
        await saveAndEmitState(req, roomId, redisData);
        return resolveRematch(req, roomId, redisData);
    }
    return { started: true };
};

// Endpoint to take a card from the deck
router.post('/gameplay/take-card', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId } = req.body;
        lock = await acquireRoomActionLock(roomId, "turn-action", 8);
        if (!lock) return res.status(409).json({ error: "Another turn action is being processed." });
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended. Start a new game." });
        }
        if (!ensureGameIsActive(redisData, userId, res)) return;
        
        const userHand = redisData.playerCards[userId];

        // Rule 1: Must be user's turn
        if (String(redisData.turn) !== String(userId)) {
            return res.status(403).json({ error: 'Not your turn!' });
        }

        // Rule 2: Must have exactly 10 cards to pick
        if (userHand.length !== 10) {
            return res.status(400).json({ error: 'You must have 10 cards to pick a card.' });
        }

        // Action: Pop from deck and push to hand
        if (!refillDeckFromLaidCards(redisData)) {
            return res.status(400).json({ error: 'No cards left to draw.' });
        }

        // Managed script: if human is pre-selected to win, lightly help deck draws (looks natural)
        if (isBotGameState(redisData) && !isBotPlayerId(userId)) {
            maybeBiasHumanDeckDraw(redisData, userId);
        }

        const card = redisData.deck.pop(); // Take top card
        redisData.playerCards[userId].push(card); // Add to player's hand
        if (isBotGameState(redisData) && !isBotPlayerId(userId)) {
            redisData.humanActionCounts = redisData.humanActionCounts || { picks: 0, lays: 0 };
            redisData.humanActionCounts.picks += 1;
            updateHumanCardFlow(redisData, userId, roomId, card);
        }
        redisData.lastPick = {
            playerId: String(userId),
            source: "deck",
            at: new Date().toISOString(),
            nonce: `${Date.now()}-${Math.random()}`,
        };
        markTurnActivity(redisData);

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        if (redisData.managedBotRoom) {
            scheduleManagedBotCallForCurrentTurn(req, roomId);
        }
        res.status(200).json({ success: true, message: 'Card taken from deck', pickedCard: card, source: "deck", redisData: sanitizeRedisData(redisData) });

    } catch (error) {
        console.error('Take card error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

// Endpoint to pick a card from the laid cards
router.post('/gameplay/pick-card', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId } = req.body;
        lock = await acquireRoomActionLock(roomId, "turn-action", 8);
        if (!lock) return res.status(409).json({ error: "Another turn action is being processed." });
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended. Start a new game." });
        }
        if (!ensureGameIsActive(redisData, userId, res)) return;

        const userHand = redisData.playerCards[userId];

        // Rule 1: Must be user's turn
        if (String(redisData.turn) !== String(userId)) {
            return res.status(403).json({ error: 'Not your turn!' });
        }

        // Rule 2: Must have exactly 10 cards to pick
        if (userHand.length !== 10) {
            return res.status(400).json({ error: 'You must have 10 cards to pick a card.' });
        }

        // Action: Pop from laid cards and push to hand
        if (redisData.laidCards.length === 0) {
            return res.status(400).json({ error: 'No laid cards to pick from!' });
        }

        const topLaidCard = redisData.laidCards[redisData.laidCards.length - 1];
        if (isJoker(topLaidCard)) {
            return res.status(400).json({ error: "Joker cards cannot be picked from the laid pile." });
        }

        const card = redisData.laidCards.pop(); // Take top card from laid pile
        redisData.playerCards[userId].push(card);
        if (isBotGameState(redisData) && !isBotPlayerId(userId)) {
            redisData.humanActionCounts = redisData.humanActionCounts || { picks: 0, lays: 0 };
            redisData.humanActionCounts.picks += 1;
            updateHumanCardFlow(redisData, userId, roomId, card);
        }
        redisData.lastPick = {
            playerId: String(userId),
            source: "laid",
            at: new Date().toISOString(),
            nonce: `${Date.now()}-${Math.random()}`,
        };
        markTurnActivity(redisData);

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        if (redisData.managedBotRoom) {
            scheduleManagedBotCallForCurrentTurn(req, roomId);
        }
        res.status(200).json({ success: true, message: 'Picked from laid cards', pickedCard: card, source: "laid", redisData: sanitizeRedisData(redisData) });

    } catch (error) {
        console.error('Pick card error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

// Endpoint to lay a card on the table
router.post('/gameplay/lay-card', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, card, socketId } = req.body;
        lock = await acquireRoomActionLock(roomId, "turn-action", 8);
        if (!lock) return res.status(409).json({ error: "Another turn action is being processed." });
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended. Start a new game." });
        }
        if (!ensureGameIsActive(redisData, userId, res)) return;

        const userHand = redisData.playerCards[userId];

        // Rule 1: Must be user's turn
        if (String(redisData.turn) !== String(userId)) {
            return res.status(403).json({ error: 'Not your turn!' });
        }

        // Rule 3: Must have exactly 11 cards to lay a card
        if (userHand.length !== 11) {
            return res.status(400).json({ error: 'You must have 11 cards to lay one.' });
        }

        // Action: Find and remove the card from player's hand
        const cardIndex = userHand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
        if (cardIndex === -1) {
            return res.status(400).json({ error: 'Card not found in your hand.' });
        }

        const [laidCard] = redisData.playerCards[userId].splice(cardIndex, 1);
        
        // Push to the top of the laid cards pile
        redisData.laidCards.push(laidCard);
        if (isBotGameState(redisData) && !isBotPlayerId(userId)) {
            redisData.humanActionCounts = redisData.humanActionCounts || { picks: 0, lays: 0 };
            redisData.humanActionCounts.lays += 1;
            updateHumanCardFlow(redisData, userId, roomId);
        }

        // Rule 4: Pass turn to the next player
        const playerIds = redisData.players.map(p => p.telegramId);
        const currentPlayerIndex = playerIds.findIndex(id => String(id) === String(userId));

        if (currentPlayerIndex === -1) {
            return res.status(404).json({ error: 'Player not found in this room.' });
        }

        const nextPlayerIndex = (currentPlayerIndex + 1) % playerIds.length;
        redisData.turn = playerIds[nextPlayerIndex];
        markTurnActivity(redisData);
        redisData.lastLay = {
            playerId: String(userId),
            targetPlayerId: String(redisData.turn),
            card: laidCard,
            at: new Date().toISOString(),
            nonce: `${Date.now()}-${Math.random()}`,
        };
        redisData.lastCall = null;

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        if (isBotGameState(redisData)) {
            scheduleBotTurn(req, roomId);
        }
        res.status(200).json({ success: true, message: 'Card laid and turn passed', redisData: sanitizeRedisData(redisData) });

    } catch (error) {
        console.error('Lay card error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

router.post('/gameplay/declare-win', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended." });
        }
        if (!ensureGameIsActive(redisData, userId, res)) return;

        const userHand = redisData.playerCards[userId];
        const winAnalysis = analyzeWinningHand(userHand);
        if (!winAnalysis.isWinning) {
            return res.status(400).json({ error: "Invalid winning hand. Need 4-3-3-1 same ranks. Jokers can complete a missing rank group." });
        }

        // Never block a legal human declare. Managed outcomes are shaped by
        // deal bias + mid-round deck pressure only (not declare gates).

        lock = await acquireRoomActionLock(roomId, "declare-win", 30);
        if (!lock) {
            return res.status(409).json({ error: "Win declaration is already being processed." });
        }

        redisData.status = "ended";
        redisData.gameEnded = true;
        redisData.turn = null;
        redisData.gameResult = buildWinnerResult(redisData, userId, winAnalysis);
        if (redisData.cardFlowPlan) {
            updateHumanCardFlow(redisData, userId, roomId);
            console.info("[card-flow] managed round completed", {
                event: "managed_card_flow_round_completed",
                roomId: String(roomId),
                scheduledWinner: redisData.cardFlowPlan.scheduledWinner,
                actualWinner: "human",
                initialPredictedPicks: redisData.cardFlowPlan.initialPredictedPicks,
                finalPredictedPicks: redisData.cardFlowPlan.currentPredictedPicks,
                actualHumanPicks: Number(redisData.humanActionCounts?.picks || 0),
                finalHumanDistance: redisData.cardFlowPlan.structuralDistance,
                nearMissTarget: redisData.cardFlowPlan.nearMissTarget,
                jokerAssisted: redisData.cardFlowPlan.jokerAssisted,
                jokersDelivered: redisData.cardFlowPlan.jokersDelivered,
            });
        }
        redisData.rematch = createRematchState(getPlayerIds(redisData), Date.now(), {
            entryFee: redisData.roomStats?.entryFee,
            // Bot delays Ready 1–4s on managed/practice bot games
            autoReadyBots: !isBotGameState(redisData),
        });

        await updateRoomStatus(roomId, "ended");
        const roundPlayers = getPlayerIds(redisData);
        if (isPracticeState(redisData)) {
            redisData.roomStats = {
                ...(redisData.roomStats || {}),
                practice: true,
                botGame: true,
            };
        } else {
            redisData.roomStats = await recordRoomGameResult(roomId, userId, roundPlayers, {
                jokerBonus: winAnalysis.jokerBonus,
                managedBonusIntroPlayerId: redisData.managedBonusIntroStage
                    ? getHumanPlayerId(redisData)
                    : null,
            });
            if (isBotGameState(redisData)) {
                // A legal human hand is always accepted, including scheduled bot rounds.
                await recordManagedBotRoundOutcome(redisData, false);
            }
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
                    winnerId: settlement.winnerId || userId,
                };
            }
            console.log("[settlement] round settled", {
                roomId,
                winnerId: userId,
                roundPot: settlement?.roundPot,
                winnerPayout: settlement?.winnerPayout,
                commissionAmount: settlement?.commissionAmount,
            });
            await emitBalanceUpdates(req.app.get('io'), roundPlayers, {
                socketByUserId: buildSocketByUserId(redisData.players),
                settlement,
            });
        }
        await redis.del("rooms:list");
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        if (isBotGameState(redisData) && !redisData.managedRotationRequired) {
            scheduleBotRematchReady(req, roomId);
        }
        await reconcileConnectedUsers(req.app.get('io'));
        return res.status(200).json({
            success: true,
            message: "Winner declared. Game ended.",
            gameResult: sanitizeGameResult(redisData.gameResult),
            redisData: sanitizeRedisData(redisData)
        });
    } catch (error) {
        await releaseRoomActionLock(lock);
        console.error('Declare win error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/gameplay/rematch/hold', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId } = req.body;
        lock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
        if (!lock) return res.status(409).json({ error: "Rematch choices are being processed." });
        const redisData = await getRoomState(roomId);
        const roomData = await getRoom(roomId);
        if (!redisData?.rematch?.active || redisData.status !== "ended" || !roomData) {
            return res.status(400).json({ error: "The rematch lobby is not active." });
        }
        if (isManagedBotRoomState(redisData, roomData)) {
            return res.status(403).json({ error: "Managed bot rooms only allow Play Again between rounds." });
        }
        if (String(roomData.creatorId) !== String(userId)) {
            return res.status(403).json({ error: "Only the room creator can hold the countdown." });
        }
        if (redisData.rematch.recruiting) {
            return res.status(409).json({ error: "Recruitment is already holding the countdown." });
        }
        redisData.rematch.countdownPaused = true;
        redisData.rematch.holdReason = "creator";
        redisData.rematch.deadlineAt = null;
        // If everyone (including creator) is already ready, start even while "paused"
        const resolved = await resolveRematch(req, roomId, redisData);
        if (resolved?.started) {
            return res.json({ success: true, started: true, redisData: sanitizeRedisData(redisData) });
        }
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        return res.json({ success: true, redisData: sanitizeRedisData(redisData) });
    } catch (error) {
        console.error("Hold rematch countdown error:", error);
        return res.status(500).json({ error: "Internal server error" });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

router.post('/gameplay/rematch/resume', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId } = req.body;
        lock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
        if (!lock) return res.status(409).json({ error: "Rematch choices are being processed." });
        const redisData = await getRoomState(roomId);
        const roomData = await getRoom(roomId);
        if (!redisData?.rematch?.active || redisData.status !== "ended" || !roomData) {
            return res.status(400).json({ error: "The rematch lobby is not active." });
        }
        if (isManagedBotRoomState(redisData, roomData)) {
            return res.status(403).json({ error: "Managed bot rooms only allow Play Again between rounds." });
        }
        if (String(roomData.creatorId) !== String(userId)) {
            return res.status(403).json({ error: "Only the room creator can resume the countdown." });
        }
        if (redisData.rematch.recruiting) {
            return res.status(409).json({ error: "Cancel player recruitment before resuming." });
        }
        redisData.rematch = restartRematchCountdown(redisData.rematch);
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        return res.json({ success: true, redisData: sanitizeRedisData(redisData) });
    } catch (error) {
        console.error("Resume rematch countdown error:", error);
        return res.status(500).json({ error: "Internal server error" });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

router.post('/gameplay/rematch/add-player', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId } = req.body;
        lock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
        if (!lock) return res.status(409).json({ error: "Rematch choices are being processed." });
        const redisData = await getRoomState(roomId);
        const roomData = await getRoom(roomId);
        if (!redisData?.rematch?.active || redisData.status !== "ended" || !roomData) {
            return res.status(400).json({ error: "The rematch lobby is not active." });
        }
        if (isManagedBotRoomState(redisData, roomData)) {
            return res.status(403).json({ error: "Managed bot rooms cannot recruit additional players." });
        }
        if (String(roomData.creatorId) !== String(userId)) {
            return res.status(403).json({ error: "Only the room creator can add a player." });
        }
        if (isPracticeState(redisData)) {
            return res.status(400).json({ error: "Practice rooms cannot recruit players." });
        }
        if (redisData.rematch.recruiting) {
            return res.status(409).json({ error: "A recruitment seat is already open." });
        }
        const currentCount = getPlayerIds(redisData).length;
        if (currentCount >= 4) {
            return res.status(400).json({ error: "A room can have at most four players." });
        }
        redisData.rematch.recruiting = true;
        redisData.rematch.countdownPaused = true;
        redisData.rematch.holdReason = "recruitment";
        redisData.rematch.deadlineAt = null;
        redisData.rematch.targetPlayerCount = currentCount + 1;
        await updateRoomRematchConfig(roomId, {
            maxPlayers: currentCount + 1,
            entryFee: redisData.rematch.proposedEntryFee || roomData.entryFee,
            rematchRecruiting: true,
        });
        await redis.del("rooms:list");
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        const updatedRoom = await getRoom(roomId);
        req.app.get("io")?.emit("new_room_created", sanitizeRoom(updatedRoom));
        return res.json({ success: true, redisData: sanitizeRedisData(redisData) });
    } catch (error) {
        console.error("Add rematch player error:", error);
        return res.status(500).json({ error: "Internal server error" });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

router.post('/gameplay/rematch/cancel-add', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId } = req.body;
        lock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
        if (!lock) return res.status(409).json({ error: "Rematch choices are being processed." });
        const redisData = await getRoomState(roomId);
        const roomData = await getRoom(roomId);
        if (!redisData?.rematch?.active || !redisData.rematch.recruiting || !roomData) {
            return res.status(400).json({ error: "Player recruitment is not active." });
        }
        if (isManagedBotRoomState(redisData, roomData)) {
            return res.status(403).json({ error: "Managed bot rooms cannot recruit additional players." });
        }
        if (String(roomData.creatorId) !== String(userId)) {
            return res.status(403).json({ error: "Only the room creator can cancel recruitment." });
        }
        const currentIds = getPlayerIds(redisData).map(String);
        redisData.rematch.recruiting = false;
        redisData.rematch.countdownPaused = false;
        redisData.rematch.targetPlayerCount = currentIds.length;
        await updateRoomRematchConfig(roomId, {
            maxPlayers: Math.max(currentIds.length, 1),
            rematchRecruiting: false,
        });
        await redis.del("rooms:list");
        req.app.get("io")?.emit("room_unavailable", { roomId });
        let status = getRematchStatus(redisData.rematch, currentIds);
        if (status.readyPlayerIds.length >= 2) {
            for (const playerId of status.waitingPlayerIds) {
                await removeRematchPlayer(req.app.get("io"), roomId, redisData, playerId, "recruitment-cancelled");
            }
        } else {
            redisData.rematch = restartRematchCountdown(redisData.rematch);
        }
        const result = await resolveRematch(
            req, roomId, redisData, { forceDeadline: currentIds.length < 2 }
        );
        return res.json({ success: true, roundStarted: result.started, redisData: sanitizeRedisData(redisData) });
    } catch (error) {
        console.error("Cancel rematch recruitment error:", error);
        return res.status(500).json({ error: "Internal server error" });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

router.post('/gameplay/rematch/update-fee', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId, entryFee } = req.body;
        const nextFee = Number(entryFee);
        if (!isValidRoomEntryBirr(nextFee)) {
            return res.status(400).json({
                error: `Entry fee must be at least ${MIN_ROOM_ENTRY_BIRR} Birr and a multiple of ${ROOM_ENTRY_STEP_BIRR} Birr.`,
            });
        }
        lock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
        if (!lock) return res.status(409).json({ error: "Rematch choices are being processed." });
        const redisData = await getRoomState(roomId);
        const roomData = await getRoom(roomId);
        if (!redisData?.rematch?.active || redisData.status !== "ended" || !roomData) {
            return res.status(400).json({ error: "The rematch lobby is not active." });
        }
        if (isManagedBotRoomState(redisData, roomData)) {
            return res.status(403).json({ error: "Managed bot room settings cannot be changed between rounds." });
        }
        if (String(roomData.creatorId) !== String(userId)) {
            return res.status(403).json({ error: "Only the room creator can change the fee." });
        }
        const creator = await getUser(userId);
        if (!creator || Number(creator.balance || 0) < nextFee) {
            return res.status(400).json({
                error: "You do not have enough balance for that entry fee.",
                code: "INSUFFICIENT_BALANCE",
                depositRequired: true,
                entryFee: nextFee,
            });
        }
        redisData.rematch.previousEntryFee = Number(
            redisData.rematch.proposedEntryFee || roomData.entryFee || 0
        );
        redisData.rematch.proposedEntryFee = nextFee;
        redisData.rematch.feeVersion = Number(redisData.rematch.feeVersion || 1) + 1;
        redisData.rematch.feeUpdatedAt = new Date().toISOString();
        redisData.rematch.readyPlayerIds = getPlayerIds(redisData)
            .map(String).filter(isBotPlayerId);
        if (!redisData.rematch.countdownPaused) {
            redisData.rematch = restartRematchCountdown(redisData.rematch);
        }
        await updateRoomRematchConfig(roomId, {
            entryFee: nextFee,
            maxPlayers: redisData.rematch.targetPlayerCount,
            rematchRecruiting: Boolean(redisData.rematch.recruiting),
        });
        await redis.del("rooms:list");
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        req.app.get("io")?.emit("new_room_created", sanitizeRoom(await getRoom(roomId)));
        return res.json({ success: true, redisData: sanitizeRedisData(redisData) });
    } catch (error) {
        console.error("Update rematch fee error:", error);
        return res.status(500).json({ error: "Internal server error" });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

router.post('/gameplay/play-again', async (req, res) => {
    let lock = null;
    try {
        const { userId, roomId, socketId, feeVersion } = req.body;
        let redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.status !== "ended" || !redisData.gameEnded || !redisData.rematch?.active) {
            return res.status(400).json({ error: "The rematch ready-up is not active." });
        }
        const playerIds = getPlayerIds(redisData).map(String);
        if (!playerIds.includes(String(userId))) {
            return res.status(403).json({ error: "You are not in this rematch." });
        }
        const roomData = await getRoom(roomId);
        if (!roomData) return res.status(404).json({ error: 'Room not found' });

        lock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
        if (!lock) {
            return res.status(409).json({ error: "Rematch choices are being processed. Please try again." });
        }
        redisData = await getRoomState(roomId);
        if (
            !redisData || redisData.status !== "ended" ||
            !redisData.rematch?.active ||
            !getPlayerIds(redisData).map(String).includes(String(userId))
        ) {
            return res.status(409).json({ error: "The rematch roster has already changed." });
        }
        if (requiresManagedRoomRotation(redisData) || redisData.managedRotationRequired) {
            redisData.managedRotationRequired = true;
            const rotation = await rotateManagedRoomSession(req, roomId, redisData, {
                requestedUserId: userId,
                replacementPolicy: "always",
            });
            return res.status(200).json({
                success: true,
                roomRotated: true,
                message: "This room completed its six-round session. A new room is ready.",
                replacementRoom: rotation.replacementRoom
                    ? sanitizeRoom(rotation.replacementRoom)
                    : null,
            });
        }
        if (Number(feeVersion) !== Number(redisData.rematch.feeVersion || 1)) {
            return res.status(409).json({
                error: "The next-round fee changed. Review it and agree again.",
                code: "REMATCH_FEE_CHANGED",
                entryFee: redisData.rematch.proposedEntryFee || roomData.entryFee,
                feeVersion: redisData.rematch.feeVersion,
            });
        }
        if (!isPracticeState(redisData)) {
            const user = await getUser(userId);
            const requiredFee = Number(redisData.rematch.proposedEntryFee || roomData.entryFee || 0);
            if (!user || Number(user.balance || 0) < requiredFee) {
                return res.status(400).json({
                    error: "You do not have enough balance to play again.",
                    code: "INSUFFICIENT_BALANCE",
                    insufficientPlayerId: String(userId),
                    depositRequired: true,
                    entryFee: requiredFee,
                });
            }
        }
        const readyIds = new Set((redisData.rematch.readyPlayerIds || []).map(String));
        readyIds.add(String(userId));
        redisData.rematch.readyPlayerIds = [...readyIds];
        const player = redisData.players.find((item) => String(item.telegramId) === String(userId));
        if (player && socketId) player.socketId = socketId;
        const result = await resolveRematch(req, roomId, redisData);
        return res.status(200).json({
            success: true,
            ready: true,
            roundStarted: result.started,
            message: result.started ? "New round started." : "Ready. Waiting for the other players.",
            redisData: sanitizeRedisData(redisData)
        });
    } catch (error) {
        console.error('Play again error:', error);
        const rawMessage = String(error.message || "");
        const insufficientPlayerId = rawMessage.startsWith("INSUFFICIENT_BALANCE:")
            ? rawMessage.split(":").slice(1).join(":")
            : null;
        if (insufficientPlayerId) {
            return res.status(400).json({
                error: "A ready player does not have enough balance for the next round.",
                code: "INSUFFICIENT_BALANCE",
                insufficientPlayerId,
                depositRequired: String(insufficientPlayerId) === String(req.body.userId),
            });
        }
        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        await releaseRoomActionLock(lock);
    }
});

router.post('/gameplay/leave-game', async (req, res) => {
    try {
        const {
            userId,
            roomId,
            socketId,
            forceLeave = false,
            expectPenaltyFree = false,
        } = req.body;
        let redisData = await getRoomState(roomId);
        const roomData = await getRoom(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (!roomData) return res.status(404).json({ error: 'Room not found' });

        if (isPracticeState(redisData)) {
            await deleteRoom(roomId, "practice-left");
            await redis.del(`room:${roomId}`);
            await redis.del("rooms:list");
            const io = req.app.get('io');
            if (io) {
                io.emit("room_unavailable", { roomId });
                io.emit("room_deleted", { roomId });
            }
            return res.status(200).json({ success: true, message: "Practice game ended.", redisData: sanitizeRedisData(redisData) });
        }

        const beforeIds = (redisData.players || []).map((p) => String(p.telegramId));
        const leavingIndex = beforeIds.findIndex((id) => id === String(userId));
        if (leavingIndex === -1) {
            return res.status(404).json({ error: "Player not found in room." });
        }

        if (redisData.status === "ended" && redisData.gameEnded && redisData.rematch?.active) {
            const rematchLock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
            if (!rematchLock) {
                return res.status(409).json({ error: "Rematch choices are being processed. Please try again." });
            }
            try {
                redisData = await getRoomState(roomId);
                if (
                    !redisData?.rematch?.active ||
                    !getPlayerIds(redisData).map(String).includes(String(userId))
                ) {
                    return res.status(409).json({ error: "The rematch roster has already changed." });
                }
                await removeRematchPlayer(
                    req.app.get("io"), roomId, redisData, userId, "left"
                );
                const result = await resolveRematch(req, roomId, redisData);
                return res.status(200).json({
                    success: true,
                    penaltyFreeLeave: true,
                    rematchStarted: result.started,
                    message: "You left the rematch without a deduction.",
                    redisData: sanitizeRedisData(redisData),
                });
            } finally {
                await releaseRoomActionLock(rematchLock);
            }
        }

        if (
            redisData.status === "waiting" &&
            Boolean(redisData.managedBotDeparted || redisData.roomStats?.managedBotDeparted)
        ) {
            const replacementFee = Number(
                redisData.managedReplacementFee
                || redisData.roomStats?.managedReplacementFee
                || 0
            );
            const io = req.app.get("io");
            await deleteRoom(roomId, "managed-bot-departed-human-left");
            await redis.del(`room:${roomId}`);
            await redis.del(`managed-bot-room:${userId}`);
            await redis.del("rooms:list");
            const replacementRoom = await ensureManagedBotRoomForUser(io, userId, {
                entryFee: replacementFee,
                forceManaged: true,
            });
            if (io) {
                io.emit("room_unavailable", { roomId });
                io.emit("room_deleted", { roomId, reason: "managed-bot-departed-human-left" });
            }
            return res.status(200).json({
                success: true,
                penaltyFreeLeave: true,
                managedDepartureCompleted: true,
                message: "Waiting room closed without a deduction.",
                replacementRoom: replacementRoom ? sanitizeRoom(replacementRoom) : null,
                redisData: sanitizeRedisData(redisData),
            });
        }

        const isCreator = String(roomData.creatorId) === String(userId);
        const isPlaying = redisData.status === "playing";
        const activeRoundExit = Boolean(
            forceLeave &&
            isPlaying &&
            !redisData.gameEnded &&
            roomData.roomStats?.feeEscrowed &&
            (roomData.roomStats.currentRoundPlayers || []).some(
                (playerId) => String(playerId) === String(userId)
            )
        );
        const timedOutOpponent = activeRoundExit
            ? getTimedOutOpponentTurn(redisData, userId)
            : null;
        if (expectPenaltyFree === true && !timedOutOpponent) {
            return res.status(409).json({
                error: "The opponent's five-minute timeout has not been reached.",
                code: "TURN_TIMEOUT_NOT_REACHED",
            });
        }
        const leavePenaltyApplies = activeRoundExit;
        const leavePenaltyPlayerId = timedOutOpponent?.inactivePlayerId || String(userId);
        const leavePenaltyOptions = leavePenaltyApplies
            ? {
                leavePenaltyPlayerId,
                leavePenaltyRate: 0.5,
                leavePenaltyReason: timedOutOpponent ? "opponent-turn-timeout" : null,
            }
            : {};

        // Leaving the waiting-room screen must not delete the creator's room.
        // Keep the creator in the room so it remains visible in the lobby and
        // can still accept players. The lobby provides an explicit delete action.
        if (isCreator && redisData.status === "waiting" && !forceLeave) {
            if (socketId && redisData.players?.[leavingIndex]) {
                redisData.players[leavingIndex].socketId = socketId;
            }
            await saveAndEmitState(req, roomId, redisData, userId, socketId);
            return res.status(200).json({
                success: true,
                message: "Returned to lobby. Room was kept open.",
                redisData: sanitizeRedisData(redisData)
            });
        }

        if (isPlaying && !forceLeave) {
            if (socketId && redisData.players?.[leavingIndex]) {
                redisData.players[leavingIndex].socketId = socketId;
            }
            await saveAndEmitState(req, roomId, redisData, userId, socketId);
            return res.status(200).json({
                success: true,
                message: "Returned to lobby. Active game was kept.",
                redisData: sanitizeRedisData(redisData)
            });
        }

        redisData.players = (redisData.players || []).filter(
            (p) => String(p.telegramId) !== String(userId)
        );
        if (redisData.playerCards) {
            delete redisData.playerCards[userId];
        }

        const remainingIds = redisData.players.map((p) => p.telegramId);

        await removePlayerFromRoom(roomId, userId);
        await redis.del("rooms:list");

        if (
            redisData.managedBotRoom &&
            remainingIds.length > 0 &&
            remainingIds.every((id) => String(id).startsWith("botgamer:"))
        ) {
            redisData.roomStats = await finalizeRoomLedger(
                roomId,
                "managed-bot-human-left",
                leavePenaltyOptions
            );
            await deleteRoom(roomId, "managed-bot-human-left");
            await redis.del(`room:${roomId}`);
            const io = req.app.get('io');
            await emitBalanceUpdates(io, getMoneyEventUserIds(redisData.roomStats), {
                socketByUserId: buildSocketByUserId(redisData.players),
            });
            if (io) {
                io.emit("room_unavailable", { roomId });
                io.emit("room_deleted", { roomId });
            }
            return res.status(200).json({
                success: true,
                message: "Player left. Bot room removed.",
                leavePenalty: leavePenaltyApplies
                    ? redisData.roomStats?.lastLeavePenalty || null
                    : null,
                penaltyFreeLeave: Boolean(timedOutOpponent),
                inactivePlayerId: timedOutOpponent?.inactivePlayerId || null,
                redisData: sanitizeRedisData(redisData)
            });
        }

        if (remainingIds.length === 0) {
            redisData.roomStats = await finalizeRoomLedger(
                roomId,
                "all-players-left",
                leavePenaltyOptions
            );
            await deleteRoom(roomId, "all-players-left");
            await redis.del(`room:${roomId}`);
            const io = req.app.get('io');
            await emitBalanceUpdates(io, getMoneyEventUserIds(redisData.roomStats), {
                socketByUserId: buildSocketByUserId(redisData.players),
            });
            if (io) {
                io.emit("room_unavailable", { roomId });
                io.emit("room_deleted", { roomId });
            }
            return res.status(200).json({
                success: true,
                message: "Player left. Room is now empty.",
                leavePenalty: leavePenaltyApplies
                    ? redisData.roomStats?.lastLeavePenalty || null
                    : null,
                penaltyFreeLeave: Boolean(timedOutOpponent),
                inactivePlayerId: timedOutOpponent?.inactivePlayerId || null,
                redisData: sanitizeRedisData(redisData)
            });
        }

        if (redisData.gameEnded || redisData.status === "ended") {
            redisData.roomStats = await finalizeRoomLedger(roomId, "game-ended-player-left");
            await emitBalanceUpdates(req.app.get('io'), getMoneyEventUserIds(redisData.roomStats), {
                socketByUserId: buildSocketByUserId(redisData.players),
            });
            resetRoomToWaiting(redisData);
            await updateRoomStatus(roomId, "waiting");
            await redis.del("rooms:list");
        }

        if (!redisData.gameEnded && redisData.status === "playing") {
            redisData.roomStats = await finalizeRoomLedger(
                roomId,
                "active-round-abandoned",
                leavePenaltyOptions
            );
            await emitBalanceUpdates(req.app.get('io'), getMoneyEventUserIds(redisData.roomStats), {
                socketByUserId: buildSocketByUserId(redisData.players),
            });
            resetRoomToWaiting(redisData);
            await updateRoomStatus(roomId, "waiting");
            await redis.del("rooms:list");
        }

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        const io = req.app.get('io');
        if (io) {
            const roomData = await getRoom(roomId);
            if (roomData) io.emit("new_room_created", sanitizeRoom(roomData));
        }
        return res.status(200).json({
            success: true,
            message: "Player left game.",
            leavePenalty: leavePenaltyApplies
                ? redisData.roomStats?.lastLeavePenalty || null
                : null,
            penaltyFreeLeave: Boolean(timedOutOpponent),
            inactivePlayerId: timedOutOpponent?.inactivePlayerId || null,
            redisData: sanitizeRedisData(redisData)
        });
    } catch (error) {
        console.error('Leave game error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/gameplay/continue-after-leave', async (req, res) => {
    try {
        const { userId, roomId, socketId, continueGame } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (!redisData.leaveVote?.active) {
            return res.status(400).json({ error: "No paused leave vote is active." });
        }

        const requiredIds = (redisData.leaveVote.requiredIds || []).map(String);
        if (!requiredIds.includes(String(userId))) {
            return res.status(403).json({ error: "You are not part of this vote." });
        }

        redisData.leaveVote.votes = redisData.leaveVote.votes || {};
        redisData.leaveVote.votes[String(userId)] = continueGame === false ? "stop" : "continue";

        const votes = redisData.leaveVote.votes;
        const allVoted = requiredIds.every((id) => votes[id]);
        const allContinue = requiredIds.every((id) => votes[id] === "continue");

        if (allVoted && allContinue && requiredIds.length >= 2) {
            redisData.paused = false;
            redisData.inactiveReason = null;
            redisData.inactiveMessage = null;
            redisData.leaveVote = null;
            moveTurnIfNeeded(redisData, null, getPlayerIds(redisData).map(String));
            markTurnActivity(redisData);
        } else if (allVoted && (!allContinue || requiredIds.length < 2)) {
            redisData.roomStats = await finalizeRoomLedger(roomId, "active-round-abandoned");
            await emitBalanceUpdates(req.app.get('io'), getMoneyEventUserIds(redisData.roomStats), {
                socketByUserId: buildSocketByUserId(redisData.players),
            });
            resetRoomToWaiting(redisData);
            await updateRoomStatus(roomId, "waiting");
            await redis.del("rooms:list");
        }

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        return res.status(200).json({ success: true, redisData: sanitizeRedisData(redisData) });
    } catch (error) {
        console.error('Continue after leave error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

const reconcileExpiredRematches = async (io) => {
    if (!redis.isOpen) return;
    const keys = await redis.keys("room:*");
    for (const key of keys) {
        if (key.endsWith("-lock") || key.includes(":bot-lock")) continue;
        const roomId = key.slice("room:".length);
        const redisData = await getRoomState(roomId);
        const status = getRematchStatus(redisData?.rematch, getPlayerIds(redisData || {}));
        if (!redisData || redisData.status !== "ended" || !status?.expired) continue;
        const lock = await acquireRoomActionLock(roomId, "rematch-resolve", 12);
        if (!lock) continue;
        try {
            const latest = await getRoomState(roomId);
            const latestStatus = getRematchStatus(latest?.rematch, getPlayerIds(latest || {}));
            if (!latest || latest.status !== "ended" || !latestStatus?.expired) continue;
            await resolveRematch(
                { app: { get: (name) => name === "io" ? io : null } },
                roomId,
                latest,
                { forceDeadline: true }
            );
        } catch (error) {
            console.error(`[rematch] Could not resolve room ${roomId}:`, error);
        } finally {
            await releaseRoomActionLock(lock);
        }
    }
};

module.exports = router;
module.exports.reconcileExpiredRematches = reconcileExpiredRematches;
module.exports.resolveRematch = resolveRematch;
