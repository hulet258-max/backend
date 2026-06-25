const express = require('express');
const router = express.Router();
const { redis } = require('../config/redis');
const {
    escrowRoomEntryFees,
    deleteRoom,
    getRoom,
    finalizeRoomLedger,
    recordRoomGameResult,
    removePlayerFromRoom,
    updateRoomStatus,
} = require("../db/store");
const { createInitialGameState } = require("../services/gameService");
const { emitBalanceUpdates } = require("../services/balanceEvents");
const {
    biasBotInitialHand,
    fundManagedBotForRound,
    isBotGameState,
    reconcileConnectedUsers,
    scheduleBotTurn,
    isPracticeState,
} = require("./botgamer");

const getMoneyEventUserIds = (roomStats = {}) => [
    ...Object.keys(roomStats.payouts || {}),
    ...Object.keys(roomStats.refunds || {}),
];

// Helper to fetch current room state from Redis
const getRoomState = async (roomId) => {
    const data = await redis.get(`room:${roomId}`);
    return data ? JSON.parse(data) : null;
};

const isJoker = (card) => String(card?.rank || "").toUpperCase() === "JOKER";

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
    const winnerGroups = Object.entries(getRankCounts(winnerCards, true))
        .map(([rank, count]) => ({ rank, count }))
        .sort((a, b) => b.count - a.count);

    const playerCardCounts = {};
    Object.entries(redisData.playerCards || {}).forEach(([playerId, cards]) => {
        playerCardCounts[playerId] = cards.length;
    });

    return {
        winnerId,
        winners: [winnerId],
        winnerPattern: "4-3-3-1",
        winnerGroups,
        playerCardCounts,
        reason: getWinningReason(analysis),
        jokerCount: analysis.jokerCount,
        jokerBonus: analysis.jokerBonus,
        endedAt: new Date().toISOString(),
    };
};

const ensureGameIsActive = (redisData, res) => {
    if (redisData.paused || redisData.leaveVote?.active) {
        res.status(400).json({ error: "Game is paused. Waiting for players to continue." });
        return false;
    }
    return true;
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
    redisData.lastPick = null;
    redisData.lastLay = null;
    redisData.lastCall = null;
};

// Helper to save room state to Redis and emit update to clients
const saveAndEmitState = async (req, roomId, redisData, currentUserId, currentUserSocketId) => {
    redisData.lastActivityAt = new Date().toISOString();

    // Before emitting, ensure the acting player's socket ID is up-to-date in Redis.
    // This is crucial if they reconnected and got a new socket ID.
    if (currentUserId && currentUserSocketId && redisData.players) {
        const playerIndex = redisData.players.findIndex(p => String(p.telegramId) === String(currentUserId));
        if (playerIndex !== -1 && redisData.players[playerIndex].socketId !== currentUserSocketId) {
            console.log(`🔌 Updating socketId for active player ${currentUserId} from ${redisData.players[playerIndex].socketId} to ${currentUserSocketId}`);
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

        const payload = {
            room: roomData,
            players: roomData.players, // The simple array of IDs from Postgres
            redisData: redisData,
        };

        console.log(`📢 Emitting 'room_update' to players in room ${roomId} after gameplay action.`);
        redisData.players.forEach((p) => {
            if (p.socketId) {
                console.log(`  -> Emitting to user ${p.telegramId} via socket: ${p.socketId}`);
                io.to(p.socketId).emit("room_update", payload);
            } else {
                console.warn(`  -> No socketId found for user ${p.telegramId} in room ${roomId}. Cannot emit update.`);
            }
        });
    }
};

// Endpoint to take a card from the deck
router.post('/gameplay/take-card', async (req, res) => {
    try {
        const { userId, roomId, socketId } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended. Start a new game." });
        }
        if (!ensureGameIsActive(redisData, res)) return;
        
        const userHand = redisData.playerCards[userId] || [];

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

        const card = redisData.deck.pop(); // Take top card
        redisData.playerCards[userId].push(card); // Add to player's hand
        redisData.lastPick = {
            playerId: String(userId),
            source: "deck",
            at: new Date().toISOString(),
            nonce: `${Date.now()}-${Math.random()}`,
        };

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        res.status(200).json({ success: true, message: 'Card taken from deck', pickedCard: card, source: "deck", redisData });

    } catch (error) {
        console.error('Take card error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to pick a card from the laid cards
router.post('/gameplay/pick-card', async (req, res) => {
    try {
        const { userId, roomId, socketId } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended. Start a new game." });
        }
        if (!ensureGameIsActive(redisData, res)) return;

        const userHand = redisData.playerCards[userId] || [];

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
        redisData.lastPick = {
            playerId: String(userId),
            source: "laid",
            at: new Date().toISOString(),
            nonce: `${Date.now()}-${Math.random()}`,
        };

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        res.status(200).json({ success: true, message: 'Picked from laid cards', pickedCard: card, source: "laid", redisData });

    } catch (error) {
        console.error('Pick card error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to lay a card on the table
router.post('/gameplay/lay-card', async (req, res) => {
    try {
        const { userId, roomId, card, socketId } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended. Start a new game." });
        }
        if (!ensureGameIsActive(redisData, res)) return;

        const userHand = redisData.playerCards[userId] || [];

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

        // Rule 4: Pass turn to the next player
        const playerIds = redisData.players.map(p => p.telegramId);
        const currentPlayerIndex = playerIds.findIndex(id => String(id) === String(userId));

        if (currentPlayerIndex === -1) {
            return res.status(404).json({ error: 'Player not found in this room.' });
        }

        const nextPlayerIndex = (currentPlayerIndex + 1) % playerIds.length;
        redisData.turn = playerIds[nextPlayerIndex];
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
        res.status(200).json({ success: true, message: 'Card laid and turn passed', redisData });

    } catch (error) {
        console.error('Lay card error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/gameplay/declare-win', async (req, res) => {
    try {
        const { userId, roomId, socketId } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });
        if (redisData.gameEnded || redisData.status === "ended") {
            return res.status(400).json({ error: "Game already ended." });
        }
        if (!ensureGameIsActive(redisData, res)) return;

        const userHand = redisData.playerCards?.[userId] || [];
        const winAnalysis = analyzeWinningHand(userHand);
        if (!winAnalysis.isWinning) {
            return res.status(400).json({ error: "Invalid winning hand. Need 4-3-3-1 same ranks. Jokers can complete a missing rank group." });
        }

        redisData.status = "ended";
        redisData.gameEnded = true;
        redisData.turn = null;
        redisData.gameResult = buildWinnerResult(redisData, userId, winAnalysis);

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
            });
            await emitBalanceUpdates(req.app.get('io'), roundPlayers);
        }
        await redis.del("rooms:list");
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        await reconcileConnectedUsers(req.app.get('io'));
        return res.status(200).json({
            success: true,
            message: "Winner declared. Game ended.",
            gameResult: redisData.gameResult,
            redisData
        });
    } catch (error) {
        console.error('Declare win error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/gameplay/play-again', async (req, res) => {
    try {
        const { userId, roomId, socketId } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });

        const playerIds = (redisData.players || []).map(p => p.telegramId);
        if (playerIds.length < 2) {
            return res.status(400).json({ error: "At least 2 players are required for a game." });
        }
        const roomData = await getRoom(roomId);
        if (!roomData) return res.status(404).json({ error: 'Room not found' });

        if (isPracticeState(redisData)) {
            redisData.roomStats = {
                ...(redisData.roomStats || {}),
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
        } else {
            await fundManagedBotForRound(redisData, roomData.entryFee);
            try {
                redisData.roomStats = await escrowRoomEntryFees(roomId, playerIds, roomData.entryFee);
            } catch (error) {
                const rawMessage = String(error.message || "");
                const insufficientPlayerId = rawMessage.startsWith("INSUFFICIENT_BALANCE:")
                    ? rawMessage.split(":").slice(1).join(":")
                    : null;
                const message = insufficientPlayerId
                    ? "A player does not have enough balance to continue this room."
                    : error.message || "Could not collect entry fees for the next game.";
                return res.status(400).json({
                    error: message,
                    code: insufficientPlayerId ? "INSUFFICIENT_BALANCE" : "ROOM_ESCROW_FAILED",
                    insufficientPlayerId,
                    depositRequired: Boolean(insufficientPlayerId && String(insufficientPlayerId) === String(userId)),
                    entryFee: roomData.entryFee,
                });
            }
            await emitBalanceUpdates(req.app.get('io'), playerIds);
        }

        const nextGameState = createInitialGameState(playerIds);
        if (redisData.managedBotRoom) {
            biasBotInitialHand(nextGameState, redisData.botProfile?.id || playerIds.find((id) => String(id).startsWith("botgamer:")));
        }
        redisData.turn = nextGameState.turn;
        redisData.playerCards = nextGameState.playerCards;
        redisData.deck = nextGameState.deck;
        redisData.laidCards = nextGameState.laidCards;
        redisData.status = "playing";
        redisData.gameEnded = false;
        redisData.gameResult = null;
        redisData.paused = false;
        redisData.inactiveReason = null;
        redisData.leaveVote = null;
        redisData.botActionCounts = { picks: 0, lays: 0 };
        redisData.lastPick = null;
        redisData.lastLay = null;
        redisData.lastCall = null;

        await updateRoomStatus(roomId, "playing");
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        if (isBotGameState(redisData)) {
            scheduleBotTurn(req, roomId);
        }
        return res.status(200).json({
            success: true,
            message: "New round started.",
            redisData
        });
    } catch (error) {
        console.error('Play again error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/gameplay/leave-game', async (req, res) => {
    try {
        const { userId, roomId, socketId, forceLeave = false } = req.body;
        const redisData = await getRoomState(roomId);
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
            return res.status(200).json({ success: true, message: "Practice game ended.", redisData });
        }

        const beforeIds = (redisData.players || []).map((p) => String(p.telegramId));
        const leavingIndex = beforeIds.findIndex((id) => id === String(userId));
        if (leavingIndex === -1) {
            return res.status(404).json({ error: "Player not found in room." });
        }

        const isCreator = String(roomData.creatorId) === String(userId);
        const isPlaying = redisData.status === "playing";

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
                redisData
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
                redisData
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

        if (remainingIds.length === 0) {
            redisData.roomStats = await finalizeRoomLedger(roomId, "all-players-left");
            await deleteRoom(roomId, "all-players-left");
            await redis.del(`room:${roomId}`);
            const io = req.app.get('io');
            await emitBalanceUpdates(io, getMoneyEventUserIds(redisData.roomStats));
            if (io) {
                io.emit("room_unavailable", { roomId });
                io.emit("room_deleted", { roomId });
            }
            return res.status(200).json({ success: true, message: "Player left. Room is now empty.", redisData });
        }

        if (redisData.gameEnded || redisData.status === "ended") {
            redisData.roomStats = await finalizeRoomLedger(roomId, "game-ended-player-left");
            await emitBalanceUpdates(req.app.get('io'), getMoneyEventUserIds(redisData.roomStats));
            resetRoomToWaiting(redisData);
            await updateRoomStatus(roomId, "waiting");
            await redis.del("rooms:list");
        }

        if (!redisData.gameEnded && redisData.status === "playing") {
            redisData.roomStats = await finalizeRoomLedger(roomId, "active-round-abandoned");
            await emitBalanceUpdates(req.app.get('io'), getMoneyEventUserIds(redisData.roomStats));
            resetRoomToWaiting(redisData);
            await updateRoomStatus(roomId, "waiting");
            await redis.del("rooms:list");
        }

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        const io = req.app.get('io');
        if (io) {
            const roomData = await getRoom(roomId);
            if (roomData) io.emit("new_room_created", roomData);
        }
        return res.status(200).json({ success: true, message: "Player left game.", redisData });
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
        } else if (allVoted && (!allContinue || requiredIds.length < 2)) {
            redisData.roomStats = await finalizeRoomLedger(roomId, "active-round-abandoned");
            await emitBalanceUpdates(req.app.get('io'), getMoneyEventUserIds(redisData.roomStats));
            resetRoomToWaiting(redisData);
            await updateRoomStatus(roomId, "waiting");
            await redis.del("rooms:list");
        }

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        return res.status(200).json({ success: true, redisData });
    } catch (error) {
        console.error('Continue after leave error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
