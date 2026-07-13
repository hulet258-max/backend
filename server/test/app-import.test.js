const test = require("node:test");
const assert = require("node:assert/strict");

test("importing app does not bind the HTTP server or start the bot", async () => {
  const appModule = require("../src/app");

  assert.equal(typeof appModule.app?.use, "function");
  assert.equal(typeof appModule.startApp, "function");
  assert.equal(typeof appModule.stopApp, "function");
  assert.equal(appModule.server.listening, false);

  await appModule.stopApp();
});
