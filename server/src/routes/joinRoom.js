const express = require("express");
const router = express.Router();
const { redis } = require("../config/redis");
const {
  addPlayerToRoom,
  escrowRoomEntryFees,
  getRoom,
  getUser,
  getUserActiveRoom,
  removePlayerFromRoom,
  updateRoomStatus,
  updateRoomRematchConfig,
} = require("../db/store");
const { buildSocketByUserId, emitBalanceUpdates } = require("../services/balanceEvents");
const {
  buildRoomUpdatePayload,
  sanitizeRedisData,
  sanitizeRedisDataForPlayer,
  sanitizeRoom,
} = require("../services/playerPayload");
const {
  isBotGameState,
  refreshBotDifficulty,
  reconcileConnectedUsers,
  scheduleBotTurn,
  startBotRoundNow,
} = require("./botgamer");

// ✨ Import the game logic service
const { createInitialGameState } = require("../services/gameService"); 
const { markTurnActivity } = require("../services/turnInactivity");
const { restartRematchCountdown } = require("../services/rematch");

router.post("/join-room", async (req, res) => {
  let rematchLock = null;
  try {
    // 1️⃣ Extract socketId from req.body (Don't forget to update frontend!)
    const { roomId, userId, socketId, resume = false } = req.body;

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
        room: sanitizeRoom(activeRoom),
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
                  await emitBalanceUpdates(req.app.get("io"), roomData.players, {
                    socketByUserId: buildSocketByUserId(redisData.players),
                  });
                  // Bot creator is already in the room — start immediately (no ready wait)
                  roomData = await updateRoomStatus(roomId, "playing");
                  if (isBotGameState(redisData)) {
                    await refreshBotDifficulty(redisData, userId);
                    await startBotRoundNow(
                      redisData,
                      roomData.players.map(String),
                      roomData.creatorId,
                      userId,
                      { roomId, trigger: "managed-join-start" }
                    );
                    redisData.status = "playing";
                    redisData.botReadyPending = false;
                    redisData.botReadyAt = null;
                  } else {
                    const initialGameState = createInitialGameState(roomData.players, roomData.creatorId);
                    redisData.turn = initialGameState.turn;
                    markTurnActivity(redisData);
                    redisData.playerCards = initialGameState.playerCards;
                    redisData.deck = initialGameState.deck;
                    redisData.laidCards = initialGameState.laidCards;
                    redisData.status = "playing";
                    redisData.botActionCounts = { picks: 0, lays: 0 };
                    redisData.lastPick = null;
                    redisData.lastLay = null;
                    redisData.lastCall = null;
                  }
                }
              }
              await redis.set(`room:${roomId}`, JSON.stringify(redisData));
              if (isBotGameState(redisData) && redisData.status === "playing") {
                scheduleBotTurn(req, roomId);
              }
              const io = req.app.get("io");
              if (io) {
                redisData.players.forEach((p) => {
                  if (p.socketId) {
                    io.to(p.socketId).emit(
                      "room_update",
                      buildRoomUpdatePayload({ id: roomId, ...roomData }, redisData, p.telegramId)
                    );
                  }
                });
              }
              console.log(`🔌 Updated socketId for re-joining player ${userId}`);
            }
          }
        }
      }

      return res.json({
        success: true,
        room: sanitizeRoom({ id: roomId, ...roomData }),
        players: roomData.players,
        redisData: sanitizeRedisDataForPlayer(redisData, userId),
      });
    }
    if (
      resume === true &&
      !(roomData.players || []).map(String).includes(String(userId))
    ) {
      return res.status(409).json({
        success: false,
        error: "Your previous room session has ended. Join again from the lobby.",
        code: "ROOM_MEMBERSHIP_ENDED",
      });
    }

    // --- NEW JOIN LOGIC ---
    const roomStateText = redis.isOpen ? await redis.get(`room:${roomId}`) : null;
    let joiningRedisData = roomStateText ? JSON.parse(roomStateText) : null;
    const isRematchJoin = Boolean(
      roomData.status === "ended" &&
      !joiningRedisData?.managedBotRoom &&
      !joiningRedisData?.roomStats?.managedBotRoom &&
      !roomData.roomStats?.managedBotRoom &&
      joiningRedisData?.rematch?.active &&
      joiningRedisData.rematch.recruiting &&
      joiningRedisData.rematch.countdownPaused
    );
    if (roomData.status !== "waiting" && !isRematchJoin) {
      return res.status(409).json({
        success: false,
        error: "This room is not accepting new players right now.",
        code: "ROOM_NOT_JOINABLE",
      });
    }
    if (roomData.playerCount >= roomData.maxPlayers) {
      return res.status(400).json({ success: false, error: "Room is full" });
    }
    if (isRematchJoin) {
      rematchLock = await redis.set(
        `room:${roomId}:rematch-resolve-lock`,
        `${Date.now()}-${Math.random()}`,
        { NX: true, EX: 12 }
      );
      if (rematchLock !== "OK") {
        rematchLock = null;
        return res.status(409).json({ success: false, error: "The rematch lobby is being updated." });
      }
      roomData = await getRoom(roomId);
      const latestText = await redis.get(`room:${roomId}`);
      joiningRedisData = latestText ? JSON.parse(latestText) : null;
      if (
        !roomData || roomData.playerCount >= roomData.maxPlayers ||
        !joiningRedisData?.rematch?.recruiting
      ) {
        return res.status(409).json({ success: false, error: "The recruitment seat is no longer available." });
      }
      const joiningUser = await getUser(userId);
      const proposedFee = Number(joiningRedisData.rematch.proposedEntryFee || roomData.entryFee || 0);
      if (!joiningUser || Number(joiningUser.balance || 0) < proposedFee) {
        return res.status(400).json({
          success: false,
          error: "You do not have enough balance for this room.",
          code: "INSUFFICIENT_BALANCE",
          entryFee: proposedFee,
        });
      }
    }

    // Update Postgres (Keep it simple, just Telegram IDs)
    let updatedRoom = await addPlayerToRoom(roomId, userId);
    await redis.del("rooms:list");

    // ✨ Safe Redis fetch and update
    let redisData = null;
    if (redis.isOpen) {
      const key = `room:${roomId}`;
      const redisResult = await redis.get(key);
      redisData = isRematchJoin
        ? joiningRedisData
        : (redisResult ? JSON.parse(redisResult) : { status: "waiting", players: [] });
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
      if (isRematchJoin) {
        const cleanUserId = String(userId);
        redisData.rematch.participantIds = [
          ...new Set([...(redisData.rematch.participantIds || []).map(String), cleanUserId]),
        ];
        redisData.rematch.targetPlayerCount = updatedRoom.players.length;
        redisData.rematch = restartRematchCountdown(redisData.rematch);
        updatedRoom = await updateRoomRematchConfig(roomId, {
          maxPlayers: updatedRoom.players.length,
          entryFee: redisData.rematch.proposedEntryFee || updatedRoom.entryFee,
          rematchRecruiting: false,
        });
      } else if (updatedRoom.players.length === updatedRoom.maxPlayers) {
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
        await emitBalanceUpdates(req.app.get("io"), updatedRoom.players, {
          socketByUserId: buildSocketByUserId(redisData.players),
        });

        // Bot is already seated as creator — deal and play immediately
        updatedRoom = await updateRoomStatus(roomId, "playing");
        if (isBotGameState(redisData)) {
          await refreshBotDifficulty(redisData, userId);
          await startBotRoundNow(
            redisData,
            updatedRoom.players.map(String),
            updatedRoom.creatorId,
            userId,
            { roomId, trigger: "managed-join-start" }
          );
          redisData.status = "playing";
          redisData.botReadyPending = false;
          redisData.botReadyAt = null;
          redisData.lastActivityAt = new Date().toISOString();
        } else {
          const initialGameState = createInitialGameState(updatedRoom.players, updatedRoom.creatorId);
          redisData.turn = initialGameState.turn;
          markTurnActivity(redisData);
          redisData.playerCards = initialGameState.playerCards;
          redisData.deck = initialGameState.deck;
          redisData.laidCards = initialGameState.laidCards;
          redisData.status = "playing";
          redisData.lastActivityAt = new Date().toISOString();
          redisData.botActionCounts = { picks: 0, lays: 0 };
          redisData.lastPick = null;
          redisData.lastLay = null;
          redisData.lastCall = null;
        }
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
            io.to(p.socketId).emit(
              "room_update",
              buildRoomUpdatePayload({ id: roomId, ...updatedRoom }, redisData, p.telegramId)
            );
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
      room: sanitizeRoom({ id: roomId, ...updatedRoom }),
      players: updatedRoom.players || [],
      redisData: isRematchJoin
        ? sanitizeRedisDataForPlayer(redisData, userId)
        : sanitizeRedisData(redisData)
    });

  } catch (err) {
    console.error("❌ join-room error:", err);
    res.status(500).json({ success: false, error: err.message || "Server error" });
  } finally {
    if (rematchLock) await redis.del(`room:${req.body.roomId}:rematch-resolve-lock`);
  }
});

module.exports = router;
