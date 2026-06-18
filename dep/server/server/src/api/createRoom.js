const express = require("express");
const router = express.Router();
const { firestore } = require("firebase-admin");
const db = require("../config/firebase");
const { redis } = require("../config/redis"); // import redis client

// Helper to determine max players from game type
const getMaxPlayers = (gameType) => {
  switch (gameType) {
    case "2-players":
      return 2;
    case "3-players":
      return 3;
    case "4-players":
      return 4;
    default:
      return 2;
  }
};

router.post("/create-room", async (req, res) => {
  try {
    // 1. Extract socketId from req.body that we sent from the frontend
    const { roomName, gameType, entryFee, creatorId, socketId, visibility } = req.body;
    const normalizedVisibility = visibility === "private" ? "private" : "public";
    const allowedGameTypes = ["2-players", "3-players", "4-players"];

    if (!roomName || !gameType || !entryFee || !creatorId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    if (!allowedGameTypes.includes(gameType)) {
      return res.status(400).json({ success: false, error: "Game type must be 2, 3, or 4 players." });
    }

    const creatorRef = db.collection("users").doc(String(creatorId));

    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: "Creator not found" });
    }

    // 2. The socketId from the request is the most current one.
    //    Always use it and update Redis to ensure it's in sync.
    let creatorSocketId = socketId; // Prioritize request body
    if (socketId) {
      await redis.set(`user:${creatorId}:socket`, socketId);
      console.log(` Ensured socket ID for User ${creatorId} is set to ${socketId}`);
    } else {
      // Fallback to Redis if frontend fails to send it (should not happen with current client)
      creatorSocketId = await redis.get(`user:${creatorId}:socket`);
      console.warn(` Frontend did not send socketId for creator ${creatorId}. Using Redis fallback: ${creatorSocketId}`);
    }

    const newRoom = {
      name: roomName,
      type: gameType,
      entryFee: Number(entryFee),
      stake: Number(entryFee),
      creatorId: creatorId,
      visibility: normalizedVisibility,
      createdAt: firestore.FieldValue.serverTimestamp(),
      players: [creatorId], // Keep Firestore simple (just Telegram IDs)
      playerCount: 1,
      maxPlayers: getMaxPlayers(gameType),
      status: "waiting",
      roomStats: {
        gamesPlayed: 0,
        winnerCounts: {},
      },
    };

    const roomRef = await db.collection("rooms").add(newRoom);
    const roomDoc = await roomRef.get();

    const roomData = { id: roomDoc.id, ...roomDoc.data() };

    // Update Redis cache
    await redis.del("rooms:list");

    const io = req.app.get("io");
    if (io && roomData.visibility === "public") {
      io.emit("new_room_created", roomData);
    }

    // 3. Create Redis entry with Telegram ID & Socket ID side-by-side
    if (redis.isOpen) {
      const initialGameState = {
        status: "waiting",
        players: [
          {
            telegramId: creatorId,
            socketId: creatorSocketId // This will no longer be null!
          }
        ],
      };

      const redisKey = `room:${roomData.id}`;
      await redis.set(redisKey, JSON.stringify(initialGameState));

      console.log(` Room ${roomData.id} state saved to Redis.`);

      // 4. Fetch and log the exact data stored in Redis for this room
      const savedDataString = await redis.get(redisKey);
      if (savedDataString) {
        console.log(`\n---  Redis Data for ${redisKey} ---`);
        console.log(JSON.stringify(JSON.parse(savedDataString), null, 2));
        console.log("------------------------------------------------\n");
      }
    }

    res.status(201).json({ success: true, room: roomData });

  } catch (err) {
    console.error(" /api/create-room error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.get("/rooms", async (req, res) => {
  try {

    // 1. Check Redis cache first
    const cachedRooms = await redis.get("rooms:list");

    if (cachedRooms) {
      console.log(" Rooms loaded from Redis");
      return res.json({ success: true, rooms: JSON.parse(cachedRooms) });
    }

    // 2. If not in cache, fetch from Firestore
    // Keep this query single-field to avoid requiring a composite index.
    const snapshot = await db.collection("rooms")
      .where("visibility", "==", "public")
      .get();

    const rooms = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }))
      .sort((a, b) => {
        const aMs = a.createdAt?.toMillis?.() ?? 0;
        const bMs = b.createdAt?.toMillis?.() ?? 0;
        return bMs - aMs;
      });

    // 3. Save to Redis cache (60 seconds)
    await redis.set("rooms:list", JSON.stringify(rooms), {
      EX: 60
    });

    console.log(" Rooms cached in Redis");

    res.json({ success: true, rooms });

  } catch (err) {
    console.error(" /api/rooms error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.get("/room/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const roomRef = db.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) {
      return res.status(404).json({ success: false, error: "Room not found" });
    }

    return res.json({ success: true, room: { id: roomDoc.id, ...roomDoc.data() } });
  } catch (err) {
    console.error(" /api/room/:roomId error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;