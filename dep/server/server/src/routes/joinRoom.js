const express = require("express");
const router = express.Router();
const { firestore } = require("firebase-admin");
const db = require("../config/firebase");
const { redis } = require("../config/redis");

// ✨ Import the game logic service
const { createInitialGameState } = require("../services/gameService"); 

router.post("/join-room", async (req, res) => {
  try {
    // 1️⃣ Extract socketId from req.body (Don't forget to update frontend!)
    const { roomId, userId, socketId } = req.body;

    if (!roomId || !userId) {
      return res.status(400).json({ success: false, error: "Missing roomId or userId" });
    }

    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) {
      return res.status(404).json({ success: false, error: "Room not found" });
    }

    const roomData = roomDoc.data();

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
              await redis.set(`room:${roomId}`, JSON.stringify(redisData));
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

    // Update Firestore (Keep it simple, just Telegram IDs)
    await roomRef.update({
      players: firestore.FieldValue.arrayUnion(userId),
      playerCount: firestore.FieldValue.increment(1)
    });

    const updatedDoc = await roomRef.get();
    const updatedRoom = updatedDoc.data();

    // ✨ Safe Redis fetch and update
    let redisData = null;
    if (redis.isOpen) {
      const key = `room:${roomId}`;
      const redisResult = await redis.get(key);
      redisData = redisResult ? JSON.parse(redisResult) : { status: "waiting", players: [] }; 

      // ✨ Safely append the new player WITH their socket ID (Do not overwrite with Firestore array)
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
        
        // Generate the game state (Passing the simple array of IDs from Firestore)
        const initialGameState = createInitialGameState(updatedRoom.players);
        
        // Merge the new game fields into the existing Redis data object
        redisData.turn = initialGameState.turn;
        redisData.playerCards = initialGameState.playerCards;
        redisData.deck = initialGameState.deck;
        redisData.laidCards = initialGameState.laidCards;
        redisData.status = "playing"; // Update status
      }

      await redis.set(key, JSON.stringify(redisData));

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