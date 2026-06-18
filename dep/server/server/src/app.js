const path = require('path');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http'); // for Socket.IO
const { Server } = require('socket.io');

const db = require('./config/firebase');
const { redis, connectRedis } = require('./config/redis');

const { createBot, startBot } = require('./bot/bot');
const userRoutes = require('./routes/user/user');
const createRoomRoutes = require('./api/createRoom');
const depositRoutes = require('./api/Deposit');
const withdrawRoutes = require('./api/withdraw');
const screenshotRecRoutes = require('./api/screenshotrec');
const joinRoomRoutes = require('./routes/joinRoom');
const gameplayRoutes = require('./routes/gameplay');

const app = express();
const PORT = process.env.PORT || 80;

// Middlewares
app.use(cors());
app.use(express.json());

// API routes
app.use('/api', userRoutes);
app.use('/api', createRoomRoutes);
app.use('/api', depositRoutes);
app.use('/api', withdrawRoutes);
app.use('/api', screenshotRecRoutes);
app.use('/api', joinRoomRoutes);
app.use('/api', gameplayRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    await db.listCollections();
    const redisStatus = redis.isOpen ? "connected" : "disconnected";

    res.json({
      status: 'ok',
      firebase: 'connected',
      redis: redisStatus,
      time: new Date()
    });
  } catch (err) {
    console.error('Health check DB error:', err);
    res.status(500).json({
      status: 'error',
      firebase: 'disconnected',
      redis: redis.isOpen ? "connected" : "disconnected",
      error: err.message
    });
  }
});

// Start app
async function startApp() {
  try {
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
              await redis.del(key);
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

    // Start server
    server.listen(PORT, () => {
      console.log(`🌐 Backend + Socket.IO listening on port ${PORT}`);
    });

    // Start Telegram bot
    const bot = createBot(db);
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