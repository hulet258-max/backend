const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { verifyCredentials } = require("../src/services/adminSecurity");

test("admin credentials are verified on the server with a scrypt hash", () => {
  const previous = {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    hash: process.env.ADMIN_PASSWORD_HASH,
  };
  try {
    const salt = crypto.randomBytes(16);
    const digest = crypto.scryptSync("strong-secret", salt, 64);
    process.env.ADMIN_USERNAME = "operator";
    delete process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt.toString("hex")}$${digest.toString("hex")}`;

    assert.equal(verifyCredentials("operator", "strong-secret"), true);
    assert.equal(verifyCredentials("operator", "wrong"), false);
    assert.equal(verifyCredentials("admin", "strong-secret"), false);
  } finally {
    if (previous.username === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previous.username;
    if (previous.password === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.password;
    if (previous.hash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
    else process.env.ADMIN_PASSWORD_HASH = previous.hash;
  }
});
