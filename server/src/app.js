const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, 'bot', '.env') });

const express = require('express');
const cors = require('cors');
const http = require('http'); // for Socket.IO
const { Server } = require('socket.io');

const { testConnection } = require('./config/postgres');
const { redis, connectRedis } = require('./config/redis');
const { deleteRoom, ensureAppSchema, finalizeRoomLedger } = require('./db/store');

const { createBot, startBot } = require('./bot/bot');
const userRoutes = require('./routes/user/user');
const createRoomRoutes = require('./api/createRoom');
const depositRoutes = require('./api/Deposit');
const withdrawRoutes = require('./api/withdraw');
const referralRoutes = require('./api/referral');
const screenshotRecRoutes = require('./api/screenshotrec');
const joinRoomRoutes = require('./routes/joinRoom');
const gameplayRoutes = require('./routes/gameplay');
const botGamerRoutes = require('./routes/botgamer');
const {
  cleanupManagedBotRoomForUser,
  deleteManagedBotRoom,
  ensureManagedBotRoomForUser,
  reconcileConnectedUsers,
} = botGamerRoutes;
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const { emitBalanceUpdates } = require('./services/balanceEvents');

const app = express();
const PORT = process.env.PORT || 8000;
const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;
const MANAGED_BOT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const BOT_ROOM_RECONCILE_INTERVAL_MS = 15 * 1000;

async function deleteIdleRooms(io) {
  if (!redis.isOpen) return;

  try {
    const keys = await redis.keys('room:*');
    const now = Date.now();

    for (const key of keys) {
      if (key.endsWith(':bot-lock')) continue;
      const roomId = key.replace('room:', '');
      const roomStateText = await redis.get(key);
      if (!roomStateText) continue;

      let roomState;
      try {
        roomState = JSON.parse(roomStateText);
      } catch (error) {
        console.error(`[cleanup] Could not parse ${key}:`, error);
        continue;
      }

      const lastActivityAt = roomState.lastActivityAt || roomState.createdAt;
      if (!lastActivityAt) {
        roomState.lastActivityAt = new Date(now).toISOString();
        await redis.set(key, JSON.stringify(roomState));
        continue;
      }

      const lastActivityTime = lastActivityAt ? new Date(lastActivityAt).getTime() : now;
      if (
        roomState.managedBotRoom &&
        roomState.status === 'waiting' &&
        now - lastActivityTime >= MANAGED_BOT_WAIT_TIMEOUT_MS
      ) {
        await deleteManagedBotRoom(io, roomId, roomState.generatedFor);
        continue;
      }
      if (!Number.isFinite(lastActivityTime) || now - lastActivityTime < ROOM_IDLE_TIMEOUT_MS) {
        continue;
      }

      if (roomState.practice) {
        await deleteRoom(roomId, 'practice-idle-cleanup');
        await redis.del(key);
        await redis.del('rooms:list');
        io.emit('room_unavailable', { roomId });
        io.emit('room_deleted', { roomId });
        console.log(`[cleanup] Deleted idle practice room ${roomId}.`);
        continue;
      }

      const roomStats = await finalizeRoomLedger(roomId, 'idle-cleanup');
      await emitBalanceUpdates(io, [
        ...Object.keys(roomStats?.payouts || {}),
        ...Object.keys(roomStats?.refunds || {}),
      ]);
      await deleteRoom(roomId, 'idle-cleanup');
      await redis.del(key);
      await redis.del('rooms:list');
      io.emit('room_unavailable', { roomId });
      io.emit('room_deleted', { roomId });
      console.log(`[cleanup] Deleted idle room ${roomId} after 30 minutes without play.`);
    }
  } catch (error) {
    console.error('[cleanup] Idle room cleanup error:', error);
  }
}

// Middlewares
app.use(cors());
app.use(express.json());

// API routes
app.use('/api', userRoutes);
app.use('/api', createRoomRoutes);
app.use('/api', depositRoutes);
app.use('/api', withdrawRoutes);
app.use('/api', referralRoutes);
app.use('/api', screenshotRecRoutes);
app.use('/api', joinRoomRoutes);
app.use('/api', gameplayRoutes);
app.use('/api', botGamerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    await testConnection();
    await ensureAppSchema();
    const redisStatus = redis.isOpen ? "connected" : "disconnected";

    res.json({
      status: 'ok',
      postgres: 'connected',
      redis: redisStatus,
      time: new Date()
    });
  } catch (err) {
    console.error('Health check DB error:', err);
    res.status(500).json({
      status: 'error',
      postgres: 'disconnected',
      redis: redis.isOpen ? "connected" : "disconnected",
      error: err.message
    });
  }
});

// Start app
async function startApp() {
  try {
    await testConnection();
    await ensureAppSchema();
    console.log('Postgres schema ready');

    // Connect Redis
    await connectRedis();

    // Create HTTP server & Socket.IO
    const server = http.createServer(app);
    const io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
app.set('io', io);
    // Handle Socket.IO connections
    io.on("connection", (socket) => {
      console.log("⚡ New client connected:", socket.id);

      // Listen for user identification from the frontend
      socket.on("auth_user", async (telegramId) => {
        if (!telegramId) return;
        
        try {
          // Store socketId in Redis using telegramId as the key
          await redis.set(`user:${telegramId}:socket`, socket.id);
          await ensureManagedBotRoomForUser(io, telegramId);
          console.log(`✅ Saved to Redis: User ${telegramId} -> Socket ${socket.id}`);

          // Fetch and display current Redis data in the console
          const keys = await redis.keys('user:*:socket');
          console.log("\n--- 📊 Current Redis DB Data ---");
          for (const key of keys) {
            const socketVal = await redis.get(key);
            console.log(`🔑 ${key}  =>  🔌 ${socketVal}`);
          }
          console.log("--------------------------------\n");
        } catch (error) {
          console.error("Redis Error:", error);
        }
      });

      // Handle Disconnect & Cleanup Redis
      socket.on("disconnect", async () => {
        console.log("❌ Client disconnected:", socket.id);
        try {
          // Find and delete the Redis key associated with this socket ID
          const keys = await redis.keys('user:*:socket');
          for (const key of keys) {
            const socketVal = await redis.get(key);
            if (socketVal === socket.id) {
              const disconnectedUserId = key.match(/^user:(.+):socket$/)?.[1];
              await redis.del(key);
              if (disconnectedUserId) {
                await cleanupManagedBotRoomForUser(io, disconnectedUserId);
              }
              console.log(`🗑️ Removed ${key} from Redis on disconnect.`);
            }
          }
        } catch (error) {
          console.error("Redis Cleanup Error:", error);
        }
      });
    });

    // Send incrementing number to all clients every second
    let counter = 0;
    setInterval(() => {
      counter++;
      io.emit("numberUpdate", { number: counter });
    }, 1000);

    deleteIdleRooms(io);
    setInterval(() => deleteIdleRooms(io), ROOM_CLEANUP_INTERVAL_MS);
    setInterval(() => reconcileConnectedUsers(io), BOT_ROOM_RECONCILE_INTERVAL_MS);

    // Start server
    server.listen(PORT, () => {
      console.log(`🌐 Backend + Socket.IO listening on port ${PORT}`);
    });

    // Start Telegram bot
    const bot = createBot();
    await startBot(bot);

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    console.log('🤖 Bot started');

  } catch (err) {
    console.error('❌ Application startup error:', err);
    process.exit(1);
  }
}

startApp();
