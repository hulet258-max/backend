const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldDeleteIdleRoom, stopApp } = require("../src/app");

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();

test.after(async () => {
  await stopApp();
});

test("cleans waiting rooms after 30 minutes without activity", () => {
  assert.equal(shouldDeleteIdleRoom({ status: "waiting", lastActivityAt: minutesAgo(30) }, NOW), true);
  assert.equal(shouldDeleteIdleRoom({ status: "waiting", lastActivityAt: minutesAgo(29) }, NOW), false);
});

test("cleans ended rooms after 30 minutes without activity", () => {
  assert.equal(shouldDeleteIdleRoom({ status: "ended", lastActivityAt: minutesAgo(30) }, NOW), true);
  assert.equal(shouldDeleteIdleRoom({ status: "ended", lastActivityAt: minutesAgo(29) }, NOW), false);
});

test("does not clean unknown room states", () => {
  assert.equal(shouldDeleteIdleRoom({ status: "archived", lastActivityAt: minutesAgo(60) }, NOW), false);
  assert.equal(shouldDeleteIdleRoom({ status: "waiting", lastActivityAt: "invalid" }, NOW), false);
});

test("does not clean an ended room while creator-controlled recruitment is paused", () => {
  const now = Date.parse("2026-07-17T10:30:00.000Z");
  assert.equal(shouldDeleteIdleRoom({
    status: "ended",
    lastActivityAt: "2026-07-17T09:00:00.000Z",
    rematch: { active: true, countdownPaused: true, recruiting: true },
  }, now), false);
});
