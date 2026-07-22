const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { pool } = require("../src/config/postgres");
const { ensureAppSchema } = require("../src/db/store");
const { ensureAdminReadModel } = require("../src/services/adminReadModel");

async function verifyAdminRoomTrigger() {
  await ensureAppSchema();
  await ensureAdminReadModel();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const roomResult = await client.query("SELECT id FROM rooms ORDER BY created_at LIMIT 1");
    const roomId = roomResult.rows[0]?.id;
    if (!roomId) {
      await client.query("ROLLBACK");
      return { schema: "ready", archiveRegression: "skipped-no-active-room" };
    }

    await client.query(`
      INSERT INTO archived_rooms (
        id, name, type, entry_fee, stake, creator_id, visibility, created_at,
        players, player_count, max_players, status, room_stats, archived_reason, archived_at
      )
      SELECT
        id, name, type, entry_fee, stake, creator_id, visibility, created_at,
        players, player_count, max_players, status, room_stats, $2, NOW()
      FROM rooms
      WHERE id = $1
      ON CONFLICT (id) DO UPDATE SET
        room_stats = EXCLUDED.room_stats,
        archived_reason = EXCLUDED.archived_reason,
        archived_at = NOW()
    `, [roomId, "trigger-regression"]);
    await client.query("DELETE FROM rooms WHERE id = $1", [roomId]);

    const projectionResult = await client.query(`
      SELECT is_archived, row_data->>'id' AS projected_id
      FROM admin_room_projection
      WHERE room_id = $1
    `, [roomId]);
    const projection = projectionResult.rows[0];
    if (!projection || projection.is_archived !== true || projection.projected_id !== roomId) {
      throw new Error("ARCHIVE_PROJECTION_NOT_PRESERVED");
    }

    await client.query("ROLLBACK");
    return { schema: "ready", archiveRegression: "passed" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

verifyAdminRoomTrigger()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
