const express = require("express");
const router = express.Router();
const {
  MIN_ROOM_ENTRY_COINS,
  isWholeCoinAmount,
} = require("../config/economy");
const { redis } = require("../config/redis"); // import redis client
const {
  createRoom,
  deleteRoom,
  finalizeRoomLedger,
  getCreatorActiveRoom,
  getRoom,
  getUser,
  getUserActiveRoom,
  listLobbyRooms,
  listPublicRooms,
} = require("../db/store");
const { emitBalanceUpdates } = require("../services/balanceEvents");

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

    const entryFeeCoins = Number(entryFee);
    if (!isWholeCoinAmount(entryFeeCoins) || entryFeeCoins < MIN_ROOM_ENTRY_COINS) {
      return res.status(400).json({
        success: false,
        error: `Entry fee must be at least ${MIN_ROOM_ENTRY_COINS} coins.`,
      });
    }

    const creator = await getUser(creatorId);

    if (!creator) {
      return res.status(404).json({ success: false, error: "Creator not found" });
    }

    if (Number(creator.balance || 0) < entryFeeCoins) {
      return res.status(400).json({
        success: false,
        error: "Insufficient coin balance to create this room.",
      });
    }

    const creatorActiveRoom = await getCreatorActiveRoom(creatorId);
    if (creatorActiveRoom) {
      return res.status(409).json({
        success: false,
        error: "Delete your room before creating a new room.",
        alreadyInRoom: true,
        mustDeleteOwnRoom: true,
        room: creatorActiveRoom,
      });
    }

    const activeRoom = await getUserActiveRoom(creatorId);
    if (activeRoom) {
      return res.status(409).json({
        success: false,
        error: "Leave your current room before creating a new room.",
        alreadyInRoom: true,
        room: activeRoom,
      });
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
      entryFee: entryFeeCoins,
      stake: entryFeeCoins,
      creatorId: creatorId,
      visibility: normalizedVisibility,
      players: [creatorId], // Keep Postgres room state simple (just Telegram IDs)
      playerCount: 1,
      maxPlayers: getMaxPlayers(gameType),
      status: "waiting",
      roomStats: {
        gamesPlayed: 0,
        winnerCounts: {},
      },
    };

    const roomData = await createRoom(newRoom);

    // Update Redis cache
    await redis.del("rooms:list");

    const io = req.app.get("io");
    if (io) {
      io.emit("new_room_created", roomData);
    }

    // 3. Create Redis entry with Telegram ID & Socket ID side-by-side
    if (redis.isOpen) {
      const initialGameState = {
        status: "waiting",
        lastActivityAt: new Date().toISOString(),
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
    const { userId } = req.query;

    if (userId) {
      const rooms = await listLobbyRooms(userId);
      return res.json({ success: true, rooms });
    }

    // 1. Check Redis cache first
    const cachedRooms = await redis.get("rooms:list");

    if (cachedRooms) {
      console.log(" Rooms loaded from Redis");
      return res.json({ success: true, rooms: JSON.parse(cachedRooms) });
    }

    // 2. If not in cache, fetch from Postgres.
    const rooms = await listPublicRooms();

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
    const room = await getRoom(roomId);

    if (!room) {
      return res.status(404).json({ success: false, error: "Room not found" });
    }

    return res.json({ success: true, room });
  } catch (err) {
    console.error(" /api/room/:roomId error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.delete("/room/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    const room = await getRoom(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: "Room not found" });
    }

    if (String(room.creatorId) !== String(userId)) {
      return res.status(403).json({ success: false, error: "Only the room creator can delete this room." });
    }

    const roomStats = await finalizeRoomLedger(roomId, "room-deleted");
    await emitBalanceUpdates(req.app.get("io"), [
      ...Object.keys(roomStats?.payouts || {}),
      ...Object.keys(roomStats?.refunds || {}),
    ]);
    await deleteRoom(roomId, "room-deleted");
    await redis.del(`room:${roomId}`);
    await redis.del("rooms:list");

    const io = req.app.get("io");
    if (io) {
      io.emit("room_unavailable", { roomId });
      io.emit("room_deleted", { roomId });
    }

    return res.json({ success: true, message: "Room deleted." });
  } catch (err) {
    console.error(" /api/room/:roomId delete error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
