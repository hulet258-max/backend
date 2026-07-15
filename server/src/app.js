const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, 'bot', '.env') });

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { testConnection } = require('./config/postgres');
const { redis, connectRedis } = require('./config/redis');
const {
  deleteRoom,
  ensureAppSchema,
  finalizeRoomLedger,
  getRoom,
  listActiveRoomsForCleanup,
} = require('./db/store');

const { createBot, startBot } = require('./bot/bot');
const userRoutes = require('./routes/user/user');
const createRoomRoutes = require('./api/createRoom');
const depositRoutes = require('./api/Deposit');
const withdrawRoutes = require('./api/withdraw');
const referralRoutes = require('./api/referral');
const shareRoutes = require('./api/share');
const screenshotRecRoutes = require('./api/screenshotrec');
const joinRoomRoutes = require('./routes/joinRoom');
const gameplayRoutes = require('./routes/gameplay');
const botGamerRoutes = require('./routes/botgamer');
const {
  cleanupManagedBotRoomForUser,
  deleteManagedBotRoom,
  ensureManagedBotRoomForUser,
  reconcileConnectedUsers,
  scheduleBotTurn,
} = botGamerRoutes;
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const analyticsRoutes = require('./api/analytics');
const { emitBalanceUpdates } = require('./services/balanceEvents');
const {
  startBroadcastWorker,
  stopBroadcastWorker,
} = require('./services/telegramBroadcast');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 8000;
const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;
const MANAGED_BOT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const BOT_ROOM_RECONCILE_INTERVAL_MS = 15 * 1000;
const CLEANABLE_ROOM_STATUSES = new Set(['waiting', 'playing', 'ended']);

let started = false;
let botInstance = null;
let cleanupInterval = null;
let botReconcileInterval = null;
let counterInterval = null;

app.set('io', io);

const getMoneyEventUserIds = (roomStats = {}) => [
  ...Object.keys(roomStats.payouts || {}),
  ...Object.keys(roomStats.refunds || {}),
];

function shouldDeleteIdleRoom(roomState, now = Date.now(), timeoutMs = ROOM_IDLE_TIMEOUT_MS) {
  if (!roomState || !CLEANABLE_ROOM_STATUSES.has(String(roomState.status || ''))) return false;
  const lastActivityAt = roomState.lastActivityAt || roomState.createdAt;
  const lastActivityTime = new Date(lastActivityAt || '').getTime();
  return Number.isFinite(lastActivityTime) && now - lastActivityTime >= timeoutMs;
}

async function deleteRoomEverywhere(ioInstance, roomId, reason, roomState = null, roomData = null) {
  const room = roomData || await getRoom(roomId);
  const isPracticeRoom = Boolean(
    roomState?.practice ||
    roomState?.roomStats?.practice ||
    room?.roomStats?.practice
  );

  let roomStats = null;
  if (room && !isPracticeRoom) {
    roomStats = await finalizeRoomLedger(roomId, reason);
    console.log('[settlement] room finalized', { roomId, reason, roomStats });
    await emitBalanceUpdates(ioInstance, getMoneyEventUserIds(roomStats));
  }

  await deleteRoom(roomId, reason);
  await redis.del(`room:${roomId}`);
  await redis.del(`room:${roomId}:bot-lock`);
  await redis.del('rooms:list');

  if (ioInstance) {
    ioInstance.emit('room_unavailable', { roomId });
    ioInstance.emit('room_deleted', { roomId });
  }

  return roomStats;
}

async function deleteIdleRooms(ioInstance) {
  if (!redis.isOpen) return;

  try {
    const keys = await redis.keys('room:*');
    const now = Date.now();
    const deletedRoomIds = new Set();

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

      const lastActivityTime = new Date(lastActivityAt).getTime();
      if (
        roomState.managedBotRoom &&
        roomState.status === 'waiting' &&
        now - lastActivityTime >= MANAGED_BOT_WAIT_TIMEOUT_MS
      ) {
        await deleteManagedBotRoom(ioInstance, roomId, roomState.generatedFor);
        deletedRoomIds.add(String(roomId));
        continue;
      }

      if (!shouldDeleteIdleRoom(roomState, now)) {
        continue;
      }

      const reason = roomState.practice ? 'practice-idle-cleanup' : 'idle-cleanup';
      await deleteRoomEverywhere(ioInstance, roomId, reason, roomState);
      deletedRoomIds.add(String(roomId));
      console.log(`[cleanup] Deleted idle room ${roomId} after 30 minutes without play.`);
    }

    const staleCutoff = new Date(now - ROOM_IDLE_TIMEOUT_MS);
    const staleActiveRooms = await listActiveRoomsForCleanup(staleCutoff);
    for (const room of staleActiveRooms) {
      const roomId = String(room.id);
      if (deletedRoomIds.has(roomId)) continue;

      const redisState = await redis.get(`room:${roomId}`);
      if (redisState) continue;

      const reason = room.roomStats?.practice ? 'practice-orphan-cleanup' : 'orphan-idle-cleanup';
      await deleteRoomEverywhere(ioInstance, roomId, reason, null, room);
      deletedRoomIds.add(roomId);
      console.log(`[cleanup] Deleted orphan active room ${roomId} with no Redis game state.`);
    }
  } catch (error) {
    console.error('[cleanup] Idle room cleanup error:', error);
  }
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api', userRoutes);
app.use('/api', createRoomRoutes);
app.use('/api', depositRoutes);
app.use('/api', withdrawRoutes);
app.use('/api', referralRoutes);
app.use('/api', shareRoutes);
app.use('/api', screenshotRecRoutes);
app.use('/api', joinRoomRoutes);
app.use('/api', gameplayRoutes);
app.use('/api', botGamerRoutes);
app.use('/api', analyticsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);

app.get('/health', async (req, res) => {
  try {
    await testConnection();
    await ensureAppSchema();

    res.json({
      status: 'ok',
      postgres: 'connected',
      redis: redis.isOpen ? 'connected' : 'disconnected',
      time: new Date(),
    });
  } catch (err) {
    console.error('Health check DB error:', err);
    res.status(500).json({
      status: 'error',
      postgres: 'disconnected',
      redis: redis.isOpen ? 'connected' : 'disconnected',
      error: err.message,
    });
  }
});

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('auth_user', async (telegramId) => {
    if (!telegramId) return;

    try {
      await redis.set(`user:${telegramId}:socket`, socket.id);
      await ensureManagedBotRoomForUser(io, telegramId);
      console.log(`[socket] User ${telegramId} connected with socket ${socket.id}`);
    } catch (error) {
      console.error('Redis Error:', error);
    }
  });

  socket.on('call_player', async (payload = {}) => {
    try {
      const roomId = String(payload.roomId || '').trim();
      const fromUserId = String(payload.fromUserId || '').trim();
      const targetUserId = String(payload.targetUserId || '').trim();
      if (!roomId || !fromUserId || !targetUserId) return;

      const rawRoomState = await redis.get(`room:${roomId}`);
      if (!rawRoomState) return;
      const roomState = JSON.parse(rawRoomState);
      const players = roomState.players || [];
      const fromPlayer = players.find((player) => String(player.telegramId) === fromUserId);
      const targetPlayer = players.find((player) => String(player.telegramId) === targetUserId);
      if (!fromPlayer || !targetPlayer) return;

      const callPayload = {
        roomId,
        fromUserId,
        targetUserId,
        at: new Date().toISOString(),
        nonce: `${Date.now()}-${Math.random()}`,
      };
      roomState.lastCall = callPayload;
      await redis.set(`room:${roomId}`, JSON.stringify(roomState));

      if (targetPlayer.socketId) {
        io.to(targetPlayer.socketId).emit('player_call', callPayload);
      } else if (String(targetUserId).startsWith('botgamer:')) {
        scheduleBotTurn({ app }, roomId);
      }
    } catch (error) {
      console.error('Player call relay error:', error);
    }
  });

  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    try {
      const keys = await redis.keys('user:*:socket');
      for (const key of keys) {
        const socketVal = await redis.get(key);
        if (socketVal === socket.id) {
          const disconnectedUserId = key.match(/^user:(.+):socket$/)?.[1];
          await redis.del(key);
          if (disconnectedUserId) {
            await cleanupManagedBotRoomForUser(io, disconnectedUserId);
          }
          console.log(`[socket] Removed stale socket key ${key}`);
        }
      }
    } catch (error) {
      console.error('Redis Cleanup Error:', error);
    }
  });
});

async function listen(serverToStart, port) {
  if (serverToStart.listening) return serverToStart;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      serverToStart.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      serverToStart.off('error', onError);
      resolve();
    };

    serverToStart.once('error', onError);
    serverToStart.once('listening', onListening);
    serverToStart.listen(port);
  });

  return serverToStart;
}

async function startApp(options = {}) {
  if (started) return { app, server, io, bot: botInstance };
  started = true;

  const {
    port = PORT,
    startTelegramBot = process.env.START_TELEGRAM_BOT !== 'false',
  } = options;

  try {
    await testConnection();
    await ensureAppSchema();
    console.log('Postgres schema ready');

    await connectRedis();

    let counter = 0;
    counterInterval = setInterval(() => {
      counter += 1;
      io.emit('numberUpdate', { number: counter });
    }, 1000);

    await deleteIdleRooms(io);
    cleanupInterval = setInterval(() => deleteIdleRooms(io), ROOM_CLEANUP_INTERVAL_MS);
    botReconcileInterval = setInterval(() => reconcileConnectedUsers(io), BOT_ROOM_RECONCILE_INTERVAL_MS);

    await listen(server, port);
    console.log(`Backend + Socket.IO listening on port ${port}`);

    await startBroadcastWorker();

    if (startTelegramBot) {
      botInstance = createBot();
      await startBot(botInstance);
      process.once('SIGINT', () => botInstance?.stop('SIGINT'));
      process.once('SIGTERM', () => botInstance?.stop('SIGTERM'));
    }

    return { app, server, io, bot: botInstance };
  } catch (err) {
    started = false;
    await stopBroadcastWorker().catch(() => {});
    if (counterInterval) clearInterval(counterInterval);
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (botReconcileInterval) clearInterval(botReconcileInterval);
    counterInterval = null;
    cleanupInterval = null;
    botReconcileInterval = null;
    throw err;
  }
}

async function stopApp() {
  await stopBroadcastWorker();
  if (counterInterval) clearInterval(counterInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  if (botReconcileInterval) clearInterval(botReconcileInterval);
  counterInterval = null;
  cleanupInterval = null;
  botReconcileInterval = null;

  if (botInstance) {
    botInstance.stop('shutdown');
    botInstance = null;
  }

  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  started = false;
}

if (require.main === module) {
  startApp().catch((err) => {
    console.error('Application startup error:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  io,
  startApp,
  stopApp,
  deleteIdleRooms,
  deleteRoomEverywhere,
  shouldDeleteIdleRoom,
};
