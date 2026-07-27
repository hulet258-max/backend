const test = require("node:test");
const assert = require("node:assert/strict");
const { testUtils } = require("../src/services/adminReadModel");

test("room projection trigger avoids PL/pgSQL room_id ambiguity", () => {
  const sql = testUtils.SCHEMA_SQL;

  assert.match(sql, /v_room_id TEXT/);
  assert.doesNotMatch(sql, /DECLARE[^;]*\broom_id TEXT/);
  assert.match(sql, /ON CONFLICT ON CONSTRAINT admin_room_projection_pkey DO UPDATE/);
  assert.match(sql, /archived_rooms WHERE id=v_room_id/);
});
