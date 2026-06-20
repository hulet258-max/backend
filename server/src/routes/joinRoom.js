const express = require("express");
const router = express.Router();
const { redis } = require("../config/redis");
const {
  addPlayerToRoom,
  escrowRoomEntryFees,
  getRoom,
  getUserActiveRoom,
  removePlayerFromRoom,
  updateRoomStatus,
} = require("../db/store");
const { emitBalanceUpdates } = require("../services/balanceEvents");
const {
  biasBotInitialHand,
  isBotGameState,
  reconcileConnectedUsers,
  scheduleBotTurn,
} = require("./botgamer");

// ✨ Import the game logic service
const { createInitialGameState } = require("../services/gameService"); 

router.post("/join-room", async (req, res) => {
  try {
    // 1️⃣ Extract socketId from req.body (Don't forget to update frontend!)
    const { roomId, userId, socketId } = req.body;

    if (!roomId || !userId) {
      return res.status(400).json({ success: false, error: "Missing roomId or userId" });
    }

    let roomData = await getRoom(roomId);

    if (!roomData) {
      return res.status(404).json({ success: false, error: "Room not found" });
    }

    const activeRoom = await getUserActiveRoom(userId, roomId);
    if (activeRoom) {
      const ownsActiveRoom = String(activeRoom.creatorId) === String(userId);
      return res.status(409).json({
        success: false,
        error: ownsActiveRoom
          ? "Delete your room before joining a new room."
          : "Leave your current room before joining a new room.",
        alreadyInRoom: true,
        mustDeleteOwnRoom: ownsActiveRoom,
        room: activeRoom,
      });
    }

    // 🔍 2. The socketId from the request is the most current one.
    //    Always use it and update Redis to ensure it's in sync.
    let userSocketId = socketId; // Prioritize request body
    if (socketId) {
      await redis.set(`user:${userId}:socket`, socketId);
      console.log(`✅ Ensured socket ID for User ${userId} is set to ${socketId}`);
    } else {
      // Fallback to Redis if frontend fails to send it (should not happen with current client)
      userSocketId = await redis.get(`user:${userId}:socket`);
      console.warn(`⚠️ Frontend did not send socketId for user ${userId}. Using Redis fallback: ${userSocketId}`);
    }

    // --- RE-JOINING LOGIC ---
    if (roomData.players && roomData.players.includes(userId)) {
      console.log(`🔄 Player ${userId} is re-joining room ${roomId}`);
      let redisData = null;
      if (redis.isOpen) {
        const data = await redis.get(`room:${roomId}`);
        if (data) {
          redisData = JSON.parse(data);
          
          // ✨ Update their socket ID in Redis in case they refreshed the page!
          if (redisData.players) {
            const playerIndex = redisData.players.findIndex(p => String(p.telegramId) === String(userId));
            if (playerIndex !== -1) {
              redisData.players[playerIndex].socketId = userSocketId;
              if (String(roomData.creatorId) === String(userId) && redisData.status === "waiting") {
                redisData.paused = false;
                redisData.creatorAway = false;
                redisData.inactiveReason = null;
                redisData.inactiveMessage = null;
                if (roomData.players.length === roomData.maxPlayers) {
                  try {
                    redisData.roomStats = await escrowRoomEntryFees(roomId, roomData.players, roomData.entryFee);
                  } catch (error) {
                    const message = String(error.message || "").startsWith("INSUFFICIENT_BALANCE")
                      ? "A player does not have enough balance to start this room."
                      : error.message || "Could not collect room entry fees.";
                    return res.status(400).json({ success: false, error: message });
                  }
                  await emitBalanceUpdates(req.app.get("io"), roomData.players);
                  roomData = await updateRoomStatus(roomId, "playing");
                  const initialGameState = createInitialGameState(roomData.players);
                  if (redisData.managedBotRoom) {
                    biasBotInitialHand(initialGameState, redisData.botProfile?.id || roomData.players[0]);
                  }
                  redisData.turn = initialGameState.turn;
                  redisData.playerCards = initialGameState.playerCards;
                  redisData.deck = initialGameState.deck;
                  redisData.laidCards = initialGameState.laidCards;
                  redisData.status = "playing";
                  redisData.botActionCounts = { picks: 0, lays: 0 };
                  redisData.lastPick = null;
                }
              }
              await redis.set(`room:${roomId}`, JSON.stringify(redisData));
              if (isBotGameState(redisData)) {
                scheduleBotTurn(req, roomId);
              }
              const io = req.app.get("io");
              if (io) {
                const payload = {
                  room: { id: roomId, ...roomData },
                  players: roomData.players,
                  redisData,
                };
                redisData.players.forEach((p) => {
                  if (p.socketId) io.to(p.socketId).emit("room_update", payload);
                });
              }
              console.log(`🔌 Updated socketId for re-joining player ${userId}`);
            }
          }
        }
      }

      return res.json({
        success: true,
        room: { id: roomId, ...roomData },
        players: roomData.players,
        redisData,
      });
    }

    // --- NEW JOIN LOGIC ---
    if (roomData.playerCount >= roomData.maxPlayers) {
      return res.status(400).json({ success: false, error: "Room is full" });
    }

    // Update Postgres (Keep it simple, just Telegram IDs)
    let updatedRoom = await addPlayerToRoom(roomId, userId);
    await redis.del("rooms:list");

    // ✨ Safe Redis fetch and update
    let redisData = null;
    if (redis.isOpen) {
      const key = `room:${roomId}`;
      const redisResult = await redis.get(key);
      redisData = redisResult ? JSON.parse(redisResult) : { status: "waiting", players: [] }; 
      redisData.lastActivityAt = new Date().toISOString();

      // ✨ Safely append the new player WITH their socket ID (Do not overwrite with Postgres array)
      const existingPlayer = redisData.players.find(p => String(p.telegramId) === String(userId));
      if (!existingPlayer) {
        redisData.players.push({
          telegramId: userId,
          socketId: userSocketId
        });
      }

      // ✨ Check if the room is now FULL to start the game
      if (updatedRoom.players.length === updatedRoom.maxPlayers) {
        console.log(`🎲 Room ${roomId} is full! Initializing game...`);
        try {
          redisData.roomStats = await escrowRoomEntryFees(roomId, updatedRoom.players, updatedRoom.entryFee);
        } catch (error) {
          await removePlayerFromRoom(roomId, userId);
          redisData.players = redisData.players.filter((p) => String(p.telegramId) !== String(userId));
          await redis.set(key, JSON.stringify(redisData));
          await redis.del("rooms:list");

          const message = String(error.message || "").startsWith("INSUFFICIENT_BALANCE")
            ? "A player does not have enough balance to start this room."
            : error.message || "Could not collect room entry fees.";
          return res.status(400).json({ success: false, error: message });
        }
        await emitBalanceUpdates(req.app.get("io"), updatedRoom.players);

        updatedRoom = await updateRoomStatus(roomId, "playing");
        
        // Generate the game state (passing the simple array of IDs from Postgres)
        const initialGameState = createInitialGameState(updatedRoom.players);
        if (redisData.managedBotRoom) {
          biasBotInitialHand(initialGameState, redisData.botProfile?.id || updatedRoom.players[0]);
        }
        
        // Merge the new game fields into the existing Redis data object
        redisData.turn = initialGameState.turn;
        redisData.playerCards = initialGameState.playerCards;
        redisData.deck = initialGameState.deck;
        redisData.laidCards = initialGameState.laidCards;
        redisData.status = "playing"; // Update status
        redisData.lastActivityAt = new Date().toISOString();
        redisData.botActionCounts = { picks: 0, lays: 0 };
        redisData.lastPick = null;
      }

      await redis.set(key, JSON.stringify(redisData));

      if (isBotGameState(redisData) && redisData.status === "playing") {
        scheduleBotTurn(req, roomId);
      }

      // ✨ NEW: Emit a 'room_update' event to all players in the room.
      // This notifies existing players of the new joiner, and if the game started,
      // it sends the initial game state to everyone.
      // Note: Assumes `io` is attached to `req` via middleware, e.g., `req.app.get('io')`.
      const io = req.app.get("io");
      if (io && redisData.players) {
        const payload = {
          room: { id: roomId, ...updatedRoom },
          players: updatedRoom.players,
          redisData: redisData,
        };
        if (updatedRoom.playerCount >= updatedRoom.maxPlayers) {
          io.emit("room_unavailable", { roomId });
          reconcileConnectedUsers(io).catch((error) => {
            console.error("Could not reconcile managed bot rooms after join:", error);
          });
        }
        console.log(`📢 Emitting 'room_update' to players in room ${roomId}`);
        redisData.players.forEach((p) => {
          if (p.socketId) {
            // Log the specific socket ID we are emitting to for this user
            console.log(`  -> Emitting to user ${p.telegramId} via socket: ${p.socketId}`);
            io.to(p.socketId).emit("room_update", payload);
          }
        });
      }
      
      // 🗄️ Log the final Redis state to the console
      console.log(`\n--- 🗄️ Redis Data for ${key} (After Join) ---`);
      console.log(JSON.stringify(redisData, null, 2));
      console.log("------------------------------------------------\n");
    }

    res.json({
      success: true,
      room: { id: roomId, ...updatedRoom },
      players: updatedRoom.players || [],
      redisData // Will now contain turn, playerCards, deck, and laidCards if the room filled up
    });

  } catch (err) {
    console.error("❌ join-room error:", err);
    res.status(500).json({ success: false, error: err.message || "Server error" });
  }
});

module.exports = router;
