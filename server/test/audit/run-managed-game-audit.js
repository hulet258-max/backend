const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { Pool } = require("pg");
const { createClient } = require("redis");
const { io } = require("socket.io-client");
const { AuditReport } = require("./report");
const { runStateFuzz } = require("./stateFuzz");

const SERVER_ROOT = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = path.join(__dirname, "docker-compose.audit.yml");
const COMPOSE_PROJECT = "karta-managed-audit";
const DIRECT_DATABASE_URL = "postgresql://karta_test:karta_test@127.0.0.1:55432/karta_test";
const PROXY_DATABASE_URL = "postgresql://karta_test:karta_test@127.0.0.1:55433/karta_test";
const DIRECT_REDIS_URL = "redis://127.0.0.1:56379/15";
const PROXY_REDIS_URL = "redis://127.0.0.1:56380/15";
const TOXIPROXY_URL = "http://127.0.0.1:58474";
const args = new Set(process.argv.slice(2));
const integrationOnly = args.has("--integration-only");
const loadOnly = args.has("--load-only");
const smoke = args.has("--smoke");
const roomCount = Math.max(2, Number(process.env.AUDIT_ROOMS || (smoke ? 4 : loadOnly ? 100 : 100)));
const targetActions = Math.max(1, Number(process.env.AUDIT_ACTIONS_PER_ROOM || (smoke ? 1 : 10)));
const loadTimeoutMs = Math.max(15_000, Number(process.env.AUDIT_LOAD_TIMEOUT_MS || (smoke ? 30_000 : 180_000)));

const report = new AuditReport({ roomCount, targetActions, loadTimeoutMs, integrationOnly, loadOnly, smoke });
let backend = null;
let backendLogs = "";
let pool = null;
let redis = null;
let sockets = [];
const roomEvents = [];
let baseUrl = null;
let dockerStarted = false;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runCommand(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: SERVER_ROOT,
    encoding: "utf8",
    timeout: options.timeout || 120_000,
    env: { ...process.env, ...(options.env || {}) },
    shell: false,
  });
}

function dockerCompose(commandArgs, options = {}) {
  return runCommand("docker", ["compose", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE, ...commandArgs], options);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(name, predicate, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${name} did not become ready${lastError ? `: ${lastError.message}` : ""}`);
}

async function jsonRequest(url, options = {}, timeoutMs = 5_000) {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, durationMs: Number((performance.now() - started).toFixed(2)) };
  } catch (error) {
    return { status: 0, error: error.message, durationMs: Number((performance.now() - started).toFixed(2)) };
  }
}

async function configureToxiproxy() {
  await waitFor("Toxiproxy", async () => (await jsonRequest(`${TOXIPROXY_URL}/version`)).status === 200);
  for (const name of ["redis_proxy", "postgres_proxy"]) {
    await fetch(`${TOXIPROXY_URL}/proxies/${name}`, { method: "DELETE" }).catch(() => {});
  }
  const definitions = [
    { name: "redis_proxy", listen: "0.0.0.0:6380", upstream: "redis:6379" },
    { name: "postgres_proxy", listen: "0.0.0.0:5433", upstream: "postgres:5432" },
  ];
  for (const body of definitions) {
    const response = await jsonRequest(`${TOXIPROXY_URL}/proxies`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`Could not configure ${body.name}: ${JSON.stringify(response)}`);
    }
  }
}

async function setProxyEnabled(name, enabled) {
  return jsonRequest(`${TOXIPROXY_URL}/proxies/${name}`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

async function addLatency(name, latencyMs) {
  return jsonRequest(`${TOXIPROXY_URL}/proxies/${name}/toxics`, {
    method: "POST",
    body: JSON.stringify({
      name: "audit_latency",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: latencyMs, jitter: 0 },
    }),
  });
}

async function removeLatency(name) {
  return jsonRequest(`${TOXIPROXY_URL}/proxies/${name}/toxics/audit_latency`, { method: "DELETE" });
}

async function startBackend(options = {}) {
  const healthTimeoutMs = Number(options.healthTimeoutMs || 90_000);
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/app.js"], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: PROXY_DATABASE_URL,
      REDIS_URL: PROXY_REDIS_URL,
      START_TELEGRAM_BOT: "false",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    backendLogs = `${backendLogs}${chunk}`.slice(-200_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  backend = child;
  await waitFor("backend health", async () => {
    if (child.exitCode != null) throw new Error(`backend exited ${child.exitCode}`);
    const result = await jsonRequest(`${baseUrl}/health`, {}, 2_000);
    return result.status === 200 && result.body?.redis === "connected";
  }, healthTimeoutMs, 500);
}

async function stopBackend() {
  if (!backend || backend.exitCode != null) return;
  backend.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => backend.once("exit", resolve)),
    sleep(5_000).then(() => backend?.kill("SIGKILL")),
  ]);
  backend = null;
}

function runBaseline() {
  const testFiles = fs.readdirSync(path.join(SERVER_ROOT, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => path.join("test", name));
  const result = runCommand(process.execPath, ["--test", ...testFiles], { timeout: 90_000 });
  report.check("Existing backend regression suite", result.status === 0, {
    exitCode: result.status,
    outputTail: `${result.stdout || ""}\n${result.stderr || ""}`.slice(-8_000),
  }, "medium");
}

function runStaticConcurrencyAudit() {
  const gameplaySource = fs.readFileSync(path.join(SERVER_ROOT, "src", "routes", "gameplay.js"), "utf8");
  const botSource = fs.readFileSync(path.join(SERVER_ROOT, "src", "routes", "botgamer.js"), "utf8");
  const takeSection = gameplaySource.split("router.post('/gameplay/take-card'")[1]?.split("router.post('/gameplay/pick-card'")[0] || "";
  const laySection = gameplaySource.split("router.post('/gameplay/lay-card'")[1]?.split("router.post('/gameplay/declare-win'")[0] || "";
  const releaseSection = gameplaySource.split("const releaseRoomActionLock")[1]?.split("const getRoomState")[0] || "";
  const scheduleSection = botSource.split("const scheduleBotTurn")[1]?.split("const scheduleBotRematchReady")[0] || "";

  report.check("Room mutations use one serialization boundary", /acquireRoomActionLock/.test(takeSection)
    && /acquireRoomActionLock/.test(laySection), {
    takeCardSerialized: /acquireRoomActionLock/.test(takeSection),
    layCardSerialized: /acquireRoomActionLock/.test(laySection),
    risk: "independent read-modify-write requests can overwrite the same Redis room JSON",
  }, "high");
  report.check("Redis lock release verifies token ownership", /eval|watch|compare/i.test(releaseSection)
    && !/redis\.del\(lock\.key\)/.test(releaseSection), {
    releaseImplementation: releaseSection.trim().slice(0, 500),
    risk: "an expired owner can delete a newer owner's lock",
  }, "high");
  report.check("Scheduled bot turns carry a round-generation token", /roundNonce|roundToken|roundGeneration/.test(scheduleSection), {
    risk: "a timer created for an older round can run during a newer round",
  }, "high");
}

async function connectTestClients(userIds) {
  const connections = userIds.map((userId) => new Promise((resolve, reject) => {
    const socket = io(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`socket timeout for ${userId}`));
    }, 10_000);
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.emit("auth_user", userId);
      // Duplicate authentication events probe per-user generation locking.
      socket.emit("auth_user", userId);
      setTimeout(() => socket.emit("auth_user", userId), 25);
      socket.on("room_update", (payload) => {
        roomEvents.push({ userId, roomId: String(payload?.room?.id || ""), at: Date.now() });
      });
      sockets.push(socket);
      resolve({ userId, socket });
    });
  }));
  return Promise.all(connections);
}

async function createManagedFixtures(count) {
  const userIds = Array.from({ length: count }, (_, index) => `audit-human-${String(index + 1).padStart(4, "0")}`);
  const createResults = await Promise.all(userIds.map((telegramId) => jsonRequest(`${baseUrl}/api/telegram-user`, {
    method: "POST",
    body: JSON.stringify({ telegramId, username: telegramId }),
  })));
  report.check("All load users were created", createResults.every((item) => item.status === 200), {
    failures: createResults.filter((item) => item.status !== 200).slice(0, 10),
  }, "high");
  await pool.query("UPDATE users SET balance = 1000, non_withdrawable_balance = 0 WHERE telegram_id = ANY($1::text[])", [userIds]);
  const clients = await connectTestClients(userIds);
  const roomRows = await waitFor("managed rooms", async () => {
    const result = await pool.query(`
      SELECT id, players, status, room_stats
      FROM rooms
      WHERE COALESCE(room_stats->>'managedBotRoom', 'false') = 'true'
        AND room_stats->>'generatedFor' = ANY($1::text[])
    `, [userIds]);
    return result.rows.length === count ? result.rows : null;
  }, 90_000, 500);
  const roomByHuman = new Map(roomRows.map((row) => [String(row.room_stats.generatedFor), row]));
  return { userIds, clients, roomByHuman };
}

async function joinManagedRooms(fixtures) {
  const results = await Promise.all(fixtures.clients.map(({ userId, socket }) => {
    const room = fixtures.roomByHuman.get(userId);
    return jsonRequest(`${baseUrl}/api/join-room`, {
      method: "POST",
      body: JSON.stringify({ roomId: room.id, userId, socketId: socket.id }),
    }, 20_000);
  }));
  report.check("Every managed room accepted exactly one intended human", results.every((item) => item.status === 200), {
    statusCounts: results.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {}),
    failures: results.filter((item) => item.status !== 200).slice(0, 10),
  }, "high");
  await waitFor("managed games playing", async () => {
    const rows = await pool.query(`
      SELECT COUNT(*)::int AS count FROM rooms
      WHERE COALESCE(room_stats->>'managedBotRoom', 'false') = 'true' AND status = 'playing'
    `);
    return Number(rows.rows[0].count) === fixtures.userIds.length;
  }, 60_000, 500);
  return results;
}

async function loadSnapshots() {
  const rooms = (await pool.query(`
    SELECT id, players, player_count, max_players, status, room_stats
    FROM rooms WHERE COALESCE(room_stats->>'managedBotRoom', 'false') = 'true'
  `)).rows;
  const keys = rooms.map((room) => `room:${room.id}`);
  const values = keys.length ? await redis.mGet(keys) : [];
  return rooms.map((room, index) => ({
    db: room,
    redis: values[index] ? JSON.parse(values[index]) : null,
  }));
}

function cardCount(state) {
  if (!state) return 0;
  return Object.values(state.playerCards || {}).flat().length
    + (state.deck || []).length
    + (state.laidCards || []).length;
}

async function checkGlobalInvariants(fixtures, phase) {
  const snapshots = await loadSnapshots();
  const generatedFor = snapshots.map((item) => String(item.db.room_stats.generatedFor || ""));
  report.check(`${phase}: one managed room per human`, snapshots.length === fixtures.userIds.length
    && new Set(generatedFor).size === generatedFor.length, {
    expectedRooms: fixtures.userIds.length,
    rooms: snapshots.length,
    uniqueHumans: new Set(generatedFor).size,
  }, "critical");

  const humanMemberships = snapshots.flatMap((item) => (item.db.players || [])
    .map(String)
    .filter((id) => !id.startsWith("botgamer:")));
  report.check(`${phase}: humans never appear in multiple rooms`, humanMemberships.length === fixtures.userIds.length
    && new Set(humanMemberships).size === humanMemberships.length, {
    expectedMemberships: fixtures.userIds.length,
    memberships: humanMemberships.length,
    uniqueHumans: new Set(humanMemberships).size,
  }, "critical");

  const expectedRoomByHuman = new Map(snapshots.map((item) => [
    String(item.db.room_stats.generatedFor || ""),
    String(item.db.id),
  ]));
  const leakedEvents = roomEvents.filter((event) => event.roomId
    && expectedRoomByHuman.has(event.userId)
    && expectedRoomByHuman.get(event.userId) !== event.roomId);
  report.check(`${phase}: socket room updates do not leak across managed rooms`, leakedEvents.length === 0, {
    observedEvents: roomEvents.length,
    leakCount: leakedEvents.length,
    examples: leakedEvents.slice(0, 10),
  }, "critical");

  const failures = [];
  for (const item of snapshots) {
    const dbPlayers = (item.db.players || []).map(String).sort();
    const redisPlayers = (item.redis?.players || []).map((player) => String(player.telegramId)).sort();
    if (!item.redis
      || Number(item.db.player_count) !== dbPlayers.length
      || JSON.stringify(dbPlayers) !== JSON.stringify(redisPlayers)
      || String(item.db.status) !== String(item.redis.status)
      || (item.redis.status === "playing" && !redisPlayers.includes(String(item.redis.turn)))
      || (item.redis.status === "playing" && cardCount(item.redis) !== 54)) {
      failures.push({
        roomId: item.db.id,
        dbStatus: item.db.status,
        redisStatus: item.redis?.status,
        dbPlayers,
        redisPlayers,
        turn: item.redis?.turn,
        cards: cardCount(item.redis),
      });
    }
  }
  report.check(`${phase}: DB/Redis room state and card invariants`, failures.length === 0, {
    failureCount: failures.length,
    examples: failures.slice(0, 10),
  }, "critical");

  const ledgerFailures = snapshots.flatMap((item) => {
    const stats = item.db.room_stats || {};
    const fees = Object.values(stats.playerFeesPaid || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const payouts = Object.values(stats.payouts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const refunds = Object.values(stats.refunds || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const accounted = payouts + refunds + Number(stats.commissionAmount || 0) + Number(stats.currentRoundPot || 0);
    return Math.abs(fees - accounted) < 0.01 ? [] : [{
      roomId: item.db.id,
      playerFeesPaid: fees,
      payouts,
      refunds,
      commission: Number(stats.commissionAmount || 0),
      currentRoundPot: Number(stats.currentRoundPot || 0),
      difference: Number((fees - accounted).toFixed(4)),
    }];
  });
  report.check(`${phase}: escrow ledger conservation`, ledgerFailures.length === 0, {
    failureCount: ledgerFailures.length,
    examples: ledgerFailures.slice(0, 10),
  }, "critical");
  return snapshots;
}

async function runDuplicateTakeRace(snapshot) {
  const state = snapshot.redis;
  const humanId = String(snapshot.db.room_stats.generatedFor);
  if (!state?.playerCards?.[humanId]) {
    report.check("Duplicate take race fixture available", false, { roomId: snapshot.db.id }, "medium");
    return;
  }
  while (state.playerCards[humanId].length > 10) state.deck.push(state.playerCards[humanId].pop());
  while (state.playerCards[humanId].length < 10 && state.deck.length) state.playerCards[humanId].push(state.deck.pop());
  state.status = "playing";
  state.gameEnded = false;
  state.turn = humanId;
  await redis.set(`room:${snapshot.db.id}`, JSON.stringify(state));
  await pool.query("UPDATE rooms SET status = 'playing' WHERE id = $1", [snapshot.db.id]);

  const body = JSON.stringify({ roomId: snapshot.db.id, userId: humanId });
  const results = await Promise.all([
    jsonRequest(`${baseUrl}/api/gameplay/take-card`, { method: "POST", body }),
    jsonRequest(`${baseUrl}/api/gameplay/take-card`, { method: "POST", body }),
  ]);
  const successes = results.filter((item) => item.status === 200).length;
  report.check("Concurrent duplicate take accepts only one mutation", successes === 1, {
    roomId: snapshot.db.id,
    statuses: results.map((item) => item.status),
    durationsMs: results.map((item) => item.durationMs),
  }, "high");
}

function buildWinningFixture(state, humanId, botId) {
  const allCards = Object.values(state.playerCards || {}).flat().concat(state.deck || [], state.laidCards || []);
  const desired = [["A", 4], ["K", 3], ["Q", 3], ["J", 1]];
  const humanHand = [];
  for (const [rank, count] of desired) {
    const matching = allCards.filter((card) => card.rank === rank).slice(0, count);
    if (matching.length !== count) return false;
    for (const card of matching) {
      const index = allCards.indexOf(card);
      humanHand.push(...allCards.splice(index, 1));
    }
  }
  state.playerCards = { [humanId]: humanHand, [botId]: allCards.splice(0, 10) };
  state.deck = allCards;
  state.laidCards = [];
  state.turn = humanId;
  state.status = "playing";
  state.gameEnded = false;
  state.rematch = null;
  return true;
}

async function runDuplicateDeclareRace(snapshot) {
  const state = JSON.parse(await redis.get(`room:${snapshot.db.id}`));
  const humanId = String(snapshot.db.room_stats.generatedFor);
  const botId = (state.players || []).map((item) => String(item.telegramId)).find((id) => id.startsWith("botgamer:"));
  if (!botId || !buildWinningFixture(state, humanId, botId)) {
    report.check("Duplicate declaration fixture available", false, { roomId: snapshot.db.id }, "medium");
    return;
  }
  await redis.set(`room:${snapshot.db.id}`, JSON.stringify(state));
  await pool.query("UPDATE rooms SET status = 'playing' WHERE id = $1", [snapshot.db.id]);
  const beforeRoom = await pool.query("SELECT room_stats FROM rooms WHERE id = $1", [snapshot.db.id]);
  const beforeGames = Number(beforeRoom.rows[0]?.room_stats?.gamesPlayed || 0);
  const before = await pool.query("SELECT balance FROM users WHERE telegram_id = $1", [humanId]);
  const body = JSON.stringify({ roomId: snapshot.db.id, userId: humanId });
  const results = await Promise.all([
    jsonRequest(`${baseUrl}/api/gameplay/declare-win`, { method: "POST", body }, 15_000),
    jsonRequest(`${baseUrl}/api/gameplay/declare-win`, { method: "POST", body }, 15_000),
  ]);
  const afterRoom = (await pool.query("SELECT room_stats FROM rooms WHERE id = $1", [snapshot.db.id])).rows[0];
  const after = await pool.query("SELECT balance FROM users WHERE telegram_id = $1", [humanId]);
  const successes = results.filter((item) => item.status === 200).length;
  report.check("Concurrent win declarations settle once", successes === 1
    && Number(afterRoom?.room_stats?.gamesPlayed || 0) === beforeGames + 1, {
    roomId: snapshot.db.id,
    statuses: results.map((item) => item.status),
    gamesPlayed: afterRoom?.room_stats?.gamesPlayed,
    balanceBefore: before.rows[0]?.balance,
    balanceAfter: after.rows[0]?.balance,
  }, "critical");
}

async function driveLoad(fixtures) {
  const successes = new Map(fixtures.userIds.map((id) => [id, 0]));
  const completed = new Set();
  const latencies = [];
  let unexpected5xx = 0;
  const progress = new Map();
  const stalledRooms = new Set();
  const deadline = Date.now() + loadTimeoutMs;

  while (Date.now() < deadline) {
    const snapshots = await loadSnapshots();
    const pending = [];
    let complete = 0;
    for (const item of snapshots) {
      const humanId = String(item.db.room_stats.generatedFor);
      const progressKey = JSON.stringify([
        item.redis?.status,
        item.redis?.turn,
        item.redis?.lastPick?.nonce,
        item.redis?.lastLay?.nonce,
        item.redis?.gameEnded,
      ]);
      const previous = progress.get(item.db.id);
      if (!previous || previous.key !== progressKey) {
        progress.set(item.db.id, { key: progressKey, changedAt: Date.now() });
      } else if (item.redis?.status === "playing" && Date.now() - previous.changedAt > 15_000) {
        stalledRooms.add(String(item.db.id));
      }
      if (item.redis?.status === "ended" || (successes.get(humanId) || 0) >= targetActions) {
        completed.add(humanId);
        complete += 1;
        continue;
      }
      const hand = item.redis?.playerCards?.[humanId] || [];
      if (String(item.redis?.turn) !== humanId) continue;
      let route;
      let body = { roomId: item.db.id, userId: humanId };
      if (hand.length === 10) route = "take-card";
      else if (hand.length === 11) {
        route = "lay-card";
        body.card = hand[0];
      } else continue;
      pending.push(jsonRequest(`${baseUrl}/api/gameplay/${route}`, {
        method: "POST",
        body: JSON.stringify(body),
      }, 5_000).then((result) => ({ result, humanId })));
    }
    if (complete === snapshots.length) break;
    const results = await Promise.all(pending);
    for (const { result, humanId } of results) {
      latencies.push(result.durationMs);
      if (result.status === 200) successes.set(humanId, (successes.get(humanId) || 0) + 1);
      if (result.status >= 500) unexpected5xx += 1;
    }
    await sleep(pending.length ? 100 : 300);
  }

  latencies.sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
  const incomplete = [...successes].filter(([humanId, count]) => count < targetActions && !completed.has(humanId));
  report.metric("load", {
    rooms: fixtures.userIds.length,
    targetActions,
    successfulActions: [...successes.values()].reduce((sum, value) => sum + value, 0),
    p95Ms: p95,
    unexpected5xx,
    incompleteRooms: incomplete.length,
  });
  report.check("Healthy load has no unexpected 5xx responses", unexpected5xx === 0, { unexpected5xx }, "high");
  report.check("Healthy game-action p95 stays below 500 ms", p95 < 500, { p95Ms: p95 }, "medium");
  report.check("Every load room progresses or completes", incomplete.length === 0, {
    incompleteCount: incomplete.length,
    examples: incomplete.slice(0, 10),
  }, "high");
  report.check("No active managed room stalls for more than 15 seconds", stalledRooms.size === 0, {
    stalledCount: stalledRooms.size,
    roomIds: [...stalledRooms].slice(0, 20),
  }, "high");
}

async function runFaultInjection() {
  const latencyAdded = await addLatency("redis_proxy", 500);
  const latencyProbe = await jsonRequest(`${baseUrl}/api/gameplay/take-card`, {
    method: "POST",
    body: JSON.stringify({ roomId: "audit-missing-room", userId: "audit-human" }),
  }, 5_000);
  await removeLatency("redis_proxy");
  report.check("Backend remains responsive with 500 ms Redis latency", latencyAdded.status < 300
    && latencyProbe.status > 0 && latencyProbe.durationMs < 3_000, { latencyAdded, latencyProbe }, "high");

  await setProxyEnabled("redis_proxy", false);
  await sleep(1_000);
  const redisOutage = await jsonRequest(`${baseUrl}/api/gameplay/take-card`, {
    method: "POST",
    body: JSON.stringify({ roomId: "audit-missing-room", userId: "audit-human" }),
  }, 3_000);
  await setProxyEnabled("redis_proxy", true);
  let redisRecovered = false;
  try {
    await waitFor("Redis recovery", async () => (
      (await jsonRequest(`${baseUrl}/api/gameplay/take-card`, {
        method: "POST",
        body: JSON.stringify({ roomId: "audit-missing-room", userId: "audit-human" }),
      }, 2_000)).status === 404
    ), 15_000, 500);
    redisRecovered = true;
  } catch {}
  report.check("Redis outage is bounded and backend reconnects", redisOutage.durationMs <= 3_500 && redisRecovered, {
    outageProbe: redisOutage,
    recoveredWithin15Seconds: redisRecovered,
  }, "high");
  if (!redisRecovered) {
    report.note("Restarted backend after failed Redis reconnect so remaining phases could continue");
    await stopBackend();
    await startBackend();
  }

  await setProxyEnabled("postgres_proxy", false);
  await sleep(500);
  const postgresOutage = await jsonRequest(`${baseUrl}/health`, {}, 3_000);
  await setProxyEnabled("postgres_proxy", true);
  let postgresRecovered = false;
  try {
    await waitFor("Postgres recovery", async () => (await jsonRequest(`${baseUrl}/health`, {}, 2_000)).status === 200, 15_000);
    postgresRecovered = true;
  } catch {}
  report.check("Postgres outage is reported and backend recovers", (postgresOutage.status === 500 || postgresOutage.status === 0)
    && postgresRecovered, { postgresOutage, recoveredWithin15Seconds: postgresRecovered }, "high");
  if (!postgresRecovered) {
    report.note("Restarted backend after failed Postgres reconnect so remaining phases could continue");
    await stopBackend();
    await startBackend();
  }
}

async function runRestartCheck() {
  const beforeKeys = (await redis.keys("room:*"))
    .filter((key) => !key.endsWith("-lock") && !key.includes(":bot-lock"))
    .sort();
  await stopBackend();
  await startBackend();
  const afterKeys = (await redis.keys("room:*"))
    .filter((key) => !key.endsWith("-lock") && !key.includes(":bot-lock"))
    .sort();
  report.check("Backend restart preserves room ownership and state keys", JSON.stringify(beforeKeys) === JSON.stringify(afterKeys), {
    beforeCount: beforeKeys.length,
    afterCount: afterKeys.length,
    missing: beforeKeys.filter((key) => !afterKeys.includes(key)).slice(0, 20),
    added: afterKeys.filter((key) => !beforeKeys.includes(key)).slice(0, 20),
  }, "critical");
}

async function runDatastoreRestartChecks() {
  await stopBackend();
  const roomKeysBefore = (await redis.keys("room:*"))
    .filter((key) => !key.endsWith("-lock") && !key.includes(":bot-lock"))
    .sort();
  const roomValuesBefore = roomKeysBefore.length ? await redis.mGet(roomKeysBefore) : [];
  const dbRoomCountBefore = Number((await pool.query("SELECT COUNT(*)::int AS count FROM rooms")).rows[0].count);

  const redisRestart = dockerCompose(["restart", "redis"], { timeout: 60_000 });
  let redisRestarted = redisRestart.status === 0;
  try {
    await waitFor("direct Redis after container restart", async () => {
      try { return await redis.ping() === "PONG"; } catch { return false; }
    }, 30_000, 500);
  } catch {
    redisRestarted = false;
  }
  let roomKeysAfter = [];
  let roomValuesAfter = [];
  if (redisRestarted) {
    roomKeysAfter = (await redis.keys("room:*"))
      .filter((key) => !key.endsWith("-lock") && !key.includes(":bot-lock"))
      .sort();
    roomValuesAfter = roomKeysAfter.length ? await redis.mGet(roomKeysAfter) : [];
  }
  report.check("Redis container restart preserves every managed room snapshot", redisRestarted
    && JSON.stringify(roomKeysBefore) === JSON.stringify(roomKeysAfter)
    && JSON.stringify(roomValuesBefore) === JSON.stringify(roomValuesAfter), {
    restartExitCode: redisRestart.status,
    beforeCount: roomKeysBefore.length,
    afterCount: roomKeysAfter.length,
    stderr: redisRestart.stderr,
  }, "critical");

  const postgresRestart = dockerCompose(["restart", "postgres"], { timeout: 60_000 });
  let dbRoomCountAfter = -1;
  let postgresRestarted = postgresRestart.status === 0;
  try {
    await waitFor("Postgres after container restart", async () => {
      try {
        dbRoomCountAfter = Number((await pool.query("SELECT COUNT(*)::int AS count FROM rooms")).rows[0].count);
        return true;
      } catch { return false; }
    }, 30_000, 500);
  } catch {
    postgresRestarted = false;
  }
  report.check("Postgres container restart preserves rooms and ledgers", postgresRestarted
    && dbRoomCountBefore === dbRoomCountAfter, {
    restartExitCode: postgresRestart.status,
    beforeCount: dbRoomCountBefore,
    afterCount: dbRoomCountAfter,
    stderr: postgresRestart.stderr,
  }, "critical");
  try {
    await startBackend({ healthTimeoutMs: 45_000 });
    report.check("Backend becomes ready after datastore container restarts", true, {}, "high");
    return true;
  } catch (error) {
    report.check("Backend becomes ready after datastore container restarts", false, {
      error: error.message,
      backendLogTail: backendLogs.slice(-8_000),
    }, "high");
    await stopBackend().catch(() => {});
    return false;
  }
}

async function main() {
  if (!loadOnly) {
    runBaseline();
    runStaticConcurrencyAudit();
    const fuzz = runStateFuzz({ sequences: smoke ? 500 : 10_000, seed: 1729 });
    report.metric("stateFuzz", fuzz);
    report.check("Seeded state fuzz preserves turns, hand sizes, and every card", fuzz.failureCount === 0, fuzz, "critical");
  }

  const dockerVersion = runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
  if (dockerVersion.status !== 0) {
    throw new Error(`Docker daemon unavailable: ${(dockerVersion.stderr || dockerVersion.stdout || "").trim()}`);
  }
  dockerStarted = true;
  const up = dockerCompose(["up", "-d", "--wait"], { timeout: 180_000 });
  if (up.status !== 0) throw new Error(`Docker audit stack failed: ${up.stderr || up.stdout}`);
  await configureToxiproxy();
  await startBackend();

  pool = new Pool({ connectionString: DIRECT_DATABASE_URL });
  redis = createClient({ url: DIRECT_REDIS_URL });
  pool.on("error", (error) => {
    report.note("Audit Postgres observer connection error", { code: error.code, message: error.message });
  });
  redis.on("error", (error) => {
    report.note("Audit Redis observer connection error", { code: error.code, message: error.message });
  });
  await redis.connect();
  await redis.flushDb();

  const fixtures = await createManagedFixtures(roomCount);
  await joinManagedRooms(fixtures);
  const initialSnapshots = await checkGlobalInvariants(fixtures, "after concurrent join");
  if (!loadOnly) {
    await runDuplicateTakeRace(initialSnapshots[0]);
    await runDuplicateDeclareRace(initialSnapshots[1]);
  }
  if (!integrationOnly) await driveLoad(fixtures);
  await checkGlobalInvariants(fixtures, "after races and load");
  await runFaultInjection();
  const recoveredAfterDatastoreRestart = await runDatastoreRestartChecks();
  if (recoveredAfterDatastoreRestart) {
    await runRestartCheck();
  } else {
    report.note("Skipped the second backend-only restart because startup after datastore restart already failed");
  }
  await checkGlobalInvariants(fixtures, "after service and backend recovery");
}

async function cleanup() {
  for (const socket of sockets) socket.close();
  sockets = [];
  await stopBackend().catch(() => {});
  if (redis) {
    try { redis.destroy(); } catch {}
  }
  if (pool) {
    await Promise.race([pool.end().catch(() => {}), sleep(5_000)]);
  }
  if (dockerStarted) {
    const down = dockerCompose(["down", "-v", "--remove-orphans"], { timeout: 120_000 });
    if (down.status !== 0) report.note("Docker cleanup returned an error", { stderr: down.stderr });
  }
}

(async () => {
  try {
    await main();
  } catch (error) {
    report.check("Audit harness completed all requested phases", false, {
      error: error.stack || error.message,
      backendLogTail: backendLogs.slice(-10_000),
    }, "high");
  } finally {
    // Preserve findings even if a damaged client or Docker teardown stalls.
    report.write(SERVER_ROOT);
    await Promise.race([
      cleanup(),
      sleep(150_000).then(() => report.note("Audit cleanup exceeded 150 seconds")),
    ]);
    report.write(SERVER_ROOT);
    const summary = report.summary();
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.critical > 0 || summary.high > 0 ? 1 : 0);
  }
})();
