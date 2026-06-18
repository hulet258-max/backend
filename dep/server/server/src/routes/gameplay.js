const express = require('express');
const router = express.Router();
const { redis } = require('../config/redis');
const db = require('../config/firebase');
const { firestore } = require("firebase-admin");
const { createInitialGameState } = require("../services/gameService");

// Helper to fetch current room state from Redis
const getRoomState = async (roomId) => {
    const data = await redis.get(`room:${roomId}`);
    return data ? JSON.parse(data) : null;
};

const getRankCountPattern = (cards = []) => {
    const rankCounts = cards.reduce((acc, card) => {
        const rank = card?.rank;
        if (!rank) return acc;
        acc[rank] = (acc[rank] || 0) + 1;
        return acc;
    }, {});
    return Object.values(rankCounts).sort((a, b) => b - a);
};

const isWinningPattern = (cards = []) => {
    const pattern = getRankCountPattern(cards);
    return pattern.length === 4 &&
        pattern[0] === 4 &&
        pattern[1] === 3 &&
        pattern[2] === 3 &&
        pattern[3] === 1;
};

const buildWinnerResult = (redisData, winnerId, reason = "valid-hand") => {
    const winnerCards = redisData.playerCards?.[winnerId] || [];
    const winnerGroups = Object.entries(
        winnerCards.reduce((acc, card) => {
            acc[card.rank] = (acc[card.rank] || 0) + 1;
            return acc;
        }, {})
    )
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
        reason,
        endedAt: new Date().toISOString(),
    };
};

const persistRoomWinStats = async (roomId, winnerId) => {
    const roomRef = db.collection("rooms").doc(roomId);
    const winnerKey = `roomStats.winnerCounts.${String(winnerId)}`;

    await roomRef.set(
        {
            roomStats: {
                gamesPlayed: 0,
                winnerCounts: {},
            },
        },
        { merge: true }
    );

    await roomRef.update({
        "roomStats.gamesPlayed": firestore.FieldValue.increment(1),
        [winnerKey]: firestore.FieldValue.increment(1),
    });
};

// Helper to save room state to Redis and emit update to clients
const saveAndEmitState = async (req, roomId, redisData, currentUserId, currentUserSocketId) => {
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
        // we also need the room's static data from Firestore.
        const roomRef = db.collection("rooms").doc(roomId);
        const roomDoc = await roomRef.get();
        if (!roomDoc.exists) {
            console.error(`[gameplay] Room ${roomId} not found in Firestore for emitting state.`);
            return;
        }
        const roomData = roomDoc.data();

        const payload = {
            room: { id: roomId, ...roomData },
            players: roomData.players, // The simple array of IDs from Firestore
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
        if (redisData.deck.length === 0) {
            // TODO: Reshuffle laid cards into deck if deck is empty
            return res.status(400).json({ error: 'Deck is empty!' });
        }

        const card = redisData.deck.pop(); // Take top card
        redisData.playerCards[userId].push(card); // Add to player's hand

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        res.status(200).json({ success: true, message: 'Card taken from deck', redisData });

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

        const card = redisData.laidCards.pop(); // Take top card from laid pile
        redisData.playerCards[userId].push(card);

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        res.status(200).json({ success: true, message: 'Picked from laid cards', redisData });

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

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
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

        const userHand = redisData.playerCards?.[userId] || [];
        if (!isWinningPattern(userHand)) {
            return res.status(400).json({ error: "Invalid winning hand. Need 4-3-3-1 same ranks." });
        }

        redisData.status = "ended";
        redisData.gameEnded = true;
        redisData.turn = null;
        redisData.gameResult = buildWinnerResult(redisData, userId, "valid-hand");

        await persistRoomWinStats(roomId, userId);
        await redis.del("rooms:list");
        await saveAndEmitState(req, roomId, redisData, userId, socketId);
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
        if (!playerIds.length) {
            return res.status(400).json({ error: "No players available for a new game." });
        }

        const nextGameState = createInitialGameState(playerIds);
        redisData.turn = nextGameState.turn;
        redisData.playerCards = nextGameState.playerCards;
        redisData.deck = nextGameState.deck;
        redisData.laidCards = nextGameState.laidCards;
        redisData.status = "playing";
        redisData.gameEnded = false;
        redisData.gameResult = null;

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
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
        const { userId, roomId, socketId } = req.body;
        const redisData = await getRoomState(roomId);

        if (!redisData) return res.status(404).json({ error: 'Room not found' });

        const beforeIds = (redisData.players || []).map((p) => String(p.telegramId));
        const leavingIndex = beforeIds.findIndex((id) => id === String(userId));
        if (leavingIndex === -1) {
            return res.status(404).json({ error: "Player not found in room." });
        }

        redisData.players = (redisData.players || []).filter(
            (p) => String(p.telegramId) !== String(userId)
        );
        if (redisData.playerCards) {
            delete redisData.playerCards[userId];
        }

        const remainingIds = redisData.players.map((p) => p.telegramId);

        const roomRef = db.collection("rooms").doc(roomId);
        await roomRef.update({
            players: firestore.FieldValue.arrayRemove(userId),
            playerCount: firestore.FieldValue.increment(-1),
        });

        if (remainingIds.length === 0) {
            await redis.del(`room:${roomId}`);
            return res.status(200).json({ success: true, message: "Player left. Room is now empty." });
        }

        if (!redisData.gameEnded && redisData.status === "playing") {
            if (remainingIds.length === 1) {
                const winnerId = remainingIds[0];
                redisData.status = "ended";
                redisData.gameEnded = true;
                redisData.turn = null;
                redisData.gameResult = buildWinnerResult(redisData, winnerId, "last-player-standing");
                await persistRoomWinStats(roomId, winnerId);
                await redis.del("rooms:list");
            } else if (String(redisData.turn) === String(userId)) {
                const nextIndex = (leavingIndex + 1) % beforeIds.length;
                let nextTurnId = beforeIds[nextIndex];
                if (String(nextTurnId) === String(userId)) {
                    nextTurnId = remainingIds[0];
                }
                redisData.turn = nextTurnId;
            }
        }

        await saveAndEmitState(req, roomId, redisData, userId, socketId);
        return res.status(200).json({ success: true, message: "Player left game.", redisData });
    } catch (error) {
        console.error('Leave game error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;