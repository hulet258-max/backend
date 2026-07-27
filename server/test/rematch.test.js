const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REMATCH_READY_TIMEOUT_MS,
  createRematchState,
  getRematchStatus,
  getRematchOutcome,
  normalizeRematchState,
  restartRematchCountdown,
} = require("../src/services/rematch");

test("rematch starts a 40-second response window and auto-readies bots", () => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  const rematch = createRematchState(["human-1", "botgamer:managed:1", "human-2"], now);

  assert.equal(
    Date.parse(rematch.deadlineAt) - Date.parse(rematch.startedAt),
    REMATCH_READY_TIMEOUT_MS
  );
  assert.deepEqual(rematch.readyPlayerIds, ["botgamer:managed:1"]);
});

test("bot games can delay auto-ready so rematch ready waits 1–4s", () => {
  const rematch = createRematchState(
    ["human-1", "botgamer:managed:1"],
    Date.now(),
    { autoReadyBots: false }
  );
  assert.deepEqual(rematch.readyPlayerIds, []);
});

test("an incomplete approval window returns the room to the lobby instead of starting a reduced roster", () => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  const rematch = createRematchState(["creator", "two", "three"], now);
  rematch.readyPlayerIds = ["creator", "two"];
  const status = getRematchStatus(rematch, ["creator", "two", "three"], now + 40_000);

  assert.equal(getRematchOutcome(status), "return-to-lobby");
});

test("all players agreeing still starts the next round", () => {
  const rematch = createRematchState(["creator", "two"], 0);
  rematch.readyPlayerIds = ["creator", "two"];
  const status = getRematchStatus(rematch, ["creator", "two"], 1);

  assert.equal(getRematchOutcome(status), "start");
});

test("paused countdown still starts when creator and all others are ready", () => {
  const rematch = createRematchState(["creator", "two", "three"], 0);
  rematch.countdownPaused = true;
  rematch.holdReason = "creator";
  rematch.deadlineAt = null;
  rematch.readyPlayerIds = ["creator", "two", "three"];
  const status = getRematchStatus(rematch, ["creator", "two", "three"], 1);

  assert.equal(getRematchOutcome(status), "start");
});

test("recruitment pause does not start until a new player joins", () => {
  const rematch = createRematchState(["creator", "two"], 0);
  rematch.countdownPaused = true;
  rematch.recruiting = true;
  rematch.holdReason = "recruitment";
  rematch.readyPlayerIds = ["creator", "two"];
  const status = getRematchStatus(rematch, ["creator", "two"], 1);

  assert.equal(getRematchOutcome(status), "paused");
});

test("paused recruitment does not expire and a joined player gets a fresh countdown", () => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  const rematch = createRematchState(["creator", "two"], now, { entryFee: 25 });
  rematch.recruiting = true;
  rematch.countdownPaused = true;
  rematch.deadlineAt = null;

  assert.equal(getRematchStatus(rematch, ["creator", "two"], now + 500_000).expired, false);

  const restarted = restartRematchCountdown(rematch, now + 500_000);
  assert.equal(restarted.recruiting, false);
  assert.equal(restarted.countdownPaused, false);
  assert.equal(Date.parse(restarted.deadlineAt) - (now + 500_000), REMATCH_READY_TIMEOUT_MS);
  assert.equal(restarted.proposedEntryFee, 25);
});

test("previous-round players stay immutable when a recruit joins", () => {
  const rematch = createRematchState(["one", "two"], 0);
  const normalized = normalizeRematchState(rematch, ["one", "two", "new-player"]);

  assert.deepEqual(normalized.participantIds, ["one", "two", "new-player"]);
  assert.deepEqual(normalized.previousRoundPlayerIds, ["one", "two"]);
});

test("a rematch expires at exactly 40 seconds", () => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  const rematch = createRematchState(["one", "two"], now);

  assert.equal(getRematchStatus(rematch, ["one", "two"], now + 39_999).expired, false);
  assert.equal(getRematchStatus(rematch, ["one", "two"], now + 40_000).expired, true);
});

test("removed players cannot remain ready or block the remaining roster", () => {
  const rematch = createRematchState(["one", "two", "three"], 0);
  rematch.readyPlayerIds = ["one", "two", "three"];
  const normalized = normalizeRematchState(rematch, ["one", "three"]);
  const status = getRematchStatus(normalized, ["one", "three"], 1);

  assert.deepEqual(status.readyPlayerIds, ["one", "three"]);
  assert.deepEqual(status.waitingPlayerIds, []);
  assert.equal(status.allReady, true);
});
