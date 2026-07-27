const { pool, query } = require("../config/postgres");

let ensurePromise = null;
let listenerClient = null;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS admin_metrics (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version BIGINT NOT NULL DEFAULT 0,
    total_users BIGINT NOT NULL DEFAULT 0,
    total_balance NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_deposits NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_withdrawals NUMERIC(20,4) NOT NULL DEFAULT 0,
    pending_withdrawal_count BIGINT NOT NULL DEFAULT 0,
    total_referral_rewards NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_rooms BIGINT NOT NULL DEFAULT 0,
    waiting BIGINT NOT NULL DEFAULT 0,
    playing BIGINT NOT NULL DEFAULT 0,
    ended BIGINT NOT NULL DEFAULT 0,
    archived BIGINT NOT NULL DEFAULT 0,
    active_players BIGINT NOT NULL DEFAULT 0,
    current_round_pot NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_games BIGINT NOT NULL DEFAULT 0,
    total_commission NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_payouts NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_refunds NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_leave_penalties NUMERIC(20,4) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO admin_metrics (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

  CREATE TABLE IF NOT EXISTS admin_user_projection (
    user_id TEXT PRIMARY KEY,
    row_data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS admin_user_projection_updated_idx
    ON admin_user_projection (updated_at DESC);

  CREATE TABLE IF NOT EXISTS admin_room_projection (
    room_id TEXT PRIMARY KEY,
    row_data JSONB NOT NULL,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS admin_room_projection_updated_idx
    ON admin_room_projection (updated_at DESC);

  CREATE TABLE IF NOT EXISTS admin_changes (
    sequence BIGSERIAL PRIMARY KEY,
    topic TEXT NOT NULL,
    entity_id TEXT,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'refresh')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS admin_changes_created_idx ON admin_changes (created_at);

  CREATE TABLE IF NOT EXISTS admin_read_model_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE OR REPLACE FUNCTION admin_json_numeric_sum(value JSONB)
  RETURNS NUMERIC LANGUAGE SQL IMMUTABLE AS $$
    SELECT COALESCE(SUM(CASE WHEN v ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN v::numeric ELSE 0 END), 0)
    FROM jsonb_each_text(COALESCE(value, '{}'::jsonb)) AS entry(k, v)
  $$;

  CREATE OR REPLACE FUNCTION admin_emit_change(
    p_topic TEXT, p_entity_id TEXT, p_operation TEXT, p_payload JSONB
  ) RETURNS VOID LANGUAGE plpgsql AS $$
  DECLARE next_sequence BIGINT;
  BEGIN
    INSERT INTO admin_changes(topic, entity_id, operation, payload)
    VALUES (p_topic, p_entity_id, p_operation, COALESCE(p_payload, '{}'::jsonb))
    RETURNING sequence INTO next_sequence;
    UPDATE admin_metrics SET version = next_sequence, updated_at = NOW() WHERE id = 1;
    PERFORM pg_notify('admin_changes', next_sequence::text);
  END $$;

  CREATE OR REPLACE FUNCTION admin_refresh_user(p_user_id TEXT, p_operation TEXT DEFAULT 'upsert')
  RETURNS VOID LANGUAGE plpgsql AS $$
  DECLARE payload JSONB;
  BEGIN
    IF p_user_id LIKE 'botgamer:%' THEN
      DELETE FROM admin_user_projection WHERE user_id = p_user_id;
      RETURN;
    END IF;
    IF p_operation = 'delete' THEN
      DELETE FROM admin_user_projection WHERE user_id = p_user_id;
      PERFORM admin_emit_change('users', p_user_id, 'delete', '{}'::jsonb);
      RETURN;
    END IF;
    SELECT to_jsonb(row_value) INTO payload FROM (
      SELECT u.*,
        COALESCE(ugs.games_played, 0) AS games_played,
        COALESCE(ugs.wins, 0) AS wins,
        COALESCE(ugs.amount_played, 0) AS amount_played,
        COALESCE(ref.share_count, 0) AS share_count,
        COALESCE(ref.reward_count, 0) AS reward_count,
        COALESCE(ref.max_rewards, 0) AS max_rewards
      FROM users u
      LEFT JOIN user_game_stats ugs ON ugs.user_id = u.telegram_id
      LEFT JOIN (
        SELECT user_id, SUM(share_count) share_count, SUM(reward_count) reward_count,
          SUM(max_rewards) max_rewards FROM referral_links GROUP BY user_id
      ) ref ON ref.user_id = u.telegram_id
      WHERE u.telegram_id = p_user_id
    ) row_value;
    IF payload IS NULL THEN RETURN; END IF;
    INSERT INTO admin_user_projection(user_id, row_data, updated_at)
    VALUES (p_user_id, payload, NOW())
    ON CONFLICT (user_id) DO UPDATE SET row_data = EXCLUDED.row_data, updated_at = NOW();
    PERFORM admin_emit_change('users', p_user_id, 'upsert', payload);
  END $$;

  CREATE OR REPLACE FUNCTION admin_users_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'INSERT' AND NEW.telegram_id NOT LIKE 'botgamer:%' THEN
      UPDATE admin_metrics SET total_users = total_users + 1,
        total_balance = total_balance + COALESCE(NEW.balance, 0) WHERE id = 1;
    ELSIF TG_OP = 'UPDATE' AND NEW.telegram_id NOT LIKE 'botgamer:%' THEN
      UPDATE admin_metrics SET total_balance = total_balance + COALESCE(NEW.balance, 0) - COALESCE(OLD.balance, 0) WHERE id = 1;
    ELSIF TG_OP = 'DELETE' AND OLD.telegram_id NOT LIKE 'botgamer:%' THEN
      UPDATE admin_metrics SET total_users = GREATEST(total_users - 1, 0),
        total_balance = total_balance - COALESCE(OLD.balance, 0) WHERE id = 1;
    END IF;
    PERFORM admin_refresh_user(COALESCE(NEW.telegram_id, OLD.telegram_id), CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END);
    RETURN COALESCE(NEW, OLD);
  END $$;

  CREATE OR REPLACE FUNCTION admin_related_user_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM admin_refresh_user(COALESCE(NEW.user_id, OLD.user_id), 'upsert');
    RETURN COALESCE(NEW, OLD);
  END $$;

  CREATE OR REPLACE FUNCTION admin_money_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE topic_name TEXT := TG_ARGV[0]; entity TEXT; old_amount NUMERIC := 0; new_amount NUMERIC := 0;
  BEGIN
    IF TG_OP <> 'INSERT' THEN old_amount := COALESCE(OLD.amount, 0); END IF;
    IF TG_OP <> 'DELETE' THEN new_amount := COALESCE(NEW.amount, 0); END IF;
    IF topic_name = 'deposits' THEN
      UPDATE admin_metrics SET total_deposits = total_deposits + new_amount - old_amount WHERE id = 1;
      entity := COALESCE(NEW.id, OLD.id)::text;
    ELSIF topic_name = 'withdrawals' THEN
      UPDATE admin_metrics SET total_withdrawals = total_withdrawals + new_amount - old_amount,
        pending_withdrawal_count = pending_withdrawal_count
          + CASE WHEN TG_OP <> 'DELETE' AND NEW.status='pending' THEN 1 ELSE 0 END
          - CASE WHEN TG_OP <> 'INSERT' AND OLD.status='pending' THEN 1 ELSE 0 END WHERE id = 1;
      entity := COALESCE(NEW.id, OLD.id)::text;
    ELSE
      UPDATE admin_metrics SET total_referral_rewards = total_referral_rewards + new_amount - old_amount WHERE id = 1;
      entity := COALESCE(NEW.id, OLD.id)::text;
    END IF;
    PERFORM admin_emit_change(topic_name, entity, CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END,
      CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END);
    RETURN COALESCE(NEW, OLD);
  END $$;

  CREATE OR REPLACE FUNCTION admin_apply_room_metric(p_sign INTEGER, p_archived BOOLEAN, p_status TEXT, p_count INTEGER, p_stats JSONB)
  RETURNS VOID LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE admin_metrics SET
      total_rooms = GREATEST(total_rooms + p_sign, 0),
      waiting = GREATEST(waiting + CASE WHEN NOT p_archived AND p_status='waiting' THEN p_sign ELSE 0 END, 0),
      playing = GREATEST(playing + CASE WHEN NOT p_archived AND p_status='playing' THEN p_sign ELSE 0 END, 0),
      ended = GREATEST(ended + CASE WHEN NOT p_archived AND p_status='ended' THEN p_sign ELSE 0 END, 0),
      archived = GREATEST(archived + CASE WHEN p_archived THEN p_sign ELSE 0 END, 0),
      active_players = GREATEST(active_players + CASE WHEN NOT p_archived AND p_status='playing' THEN p_sign * COALESCE(p_count,0) ELSE 0 END, 0),
      current_round_pot = current_round_pot + CASE WHEN NOT p_archived THEN p_sign * COALESCE(NULLIF(p_stats->>'currentRoundPot','')::numeric,0) ELSE 0 END,
      total_games = GREATEST(total_games + p_sign * COALESCE(NULLIF(p_stats->>'gamesPlayed','')::bigint,0), 0),
      total_commission = total_commission + p_sign * COALESCE(NULLIF(p_stats->>'commissionAmount','')::numeric,0),
      total_payouts = total_payouts + p_sign * admin_json_numeric_sum(p_stats->'payouts'),
      total_refunds = total_refunds + p_sign * admin_json_numeric_sum(p_stats->'refunds'),
      total_leave_penalties = total_leave_penalties + p_sign * COALESCE(NULLIF(p_stats->>'leavePenaltyAmount','')::numeric,0)
    WHERE id = 1;
  END $$;

  CREATE OR REPLACE FUNCTION admin_room_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE archived BOOLEAN := TG_ARGV[0]::boolean; v_room_id TEXT; payload JSONB;
  BEGIN
    IF TG_OP <> 'INSERT' THEN PERFORM admin_apply_room_metric(-1, archived, OLD.status, OLD.player_count, OLD.room_stats); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM admin_apply_room_metric(1, archived, NEW.status, NEW.player_count, NEW.room_stats); END IF;
    v_room_id := COALESCE(NEW.id, OLD.id); payload := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) || jsonb_build_object('is_archived', archived) END;
    -- Archiving inserts the durable row before deleting the active row. Keep the
    -- archive projection and its upsert event instead of erasing it here.
    IF TG_OP='DELETE' AND NOT archived AND EXISTS (SELECT 1 FROM archived_rooms WHERE id=v_room_id) THEN
      RETURN OLD;
    END IF;
    IF TG_OP='DELETE' THEN
      DELETE FROM admin_room_projection WHERE admin_room_projection.room_id = v_room_id;
    ELSE
      INSERT INTO admin_room_projection(room_id, row_data, is_archived, updated_at)
      VALUES(v_room_id, payload, archived, NOW())
      ON CONFLICT ON CONSTRAINT admin_room_projection_pkey DO UPDATE
      SET row_data=EXCLUDED.row_data, is_archived=EXCLUDED.is_archived, updated_at=NOW();
    END IF;
    PERFORM admin_emit_change('rooms', v_room_id, CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END, payload);
    RETURN COALESCE(NEW, OLD);
  END $$;

  CREATE OR REPLACE FUNCTION admin_content_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE payload JSONB := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
    entity TEXT := COALESCE(to_jsonb(NEW)->>TG_ARGV[1], to_jsonb(OLD)->>TG_ARGV[1]);
  BEGIN
    PERFORM admin_emit_change(TG_ARGV[0], entity, CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END, payload);
    RETURN COALESCE(NEW, OLD);
  END $$;

  DROP TRIGGER IF EXISTS admin_users_change ON users;
  CREATE TRIGGER admin_users_change AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION admin_users_trigger();
  DROP TRIGGER IF EXISTS admin_user_stats_change ON user_game_stats;
  CREATE TRIGGER admin_user_stats_change AFTER INSERT OR UPDATE OR DELETE ON user_game_stats FOR EACH ROW EXECUTE FUNCTION admin_related_user_trigger();
  DROP TRIGGER IF EXISTS admin_referral_link_user_change ON referral_links;
  CREATE TRIGGER admin_referral_link_user_change AFTER INSERT OR UPDATE OR DELETE ON referral_links FOR EACH ROW EXECUTE FUNCTION admin_related_user_trigger();
  DROP TRIGGER IF EXISTS admin_deposit_change ON transactions;
  CREATE TRIGGER admin_deposit_change AFTER INSERT OR UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION admin_money_trigger('deposits');
  DROP TRIGGER IF EXISTS admin_withdrawal_change ON withdrawal_requests;
  CREATE TRIGGER admin_withdrawal_change AFTER INSERT OR UPDATE OR DELETE ON withdrawal_requests FOR EACH ROW EXECUTE FUNCTION admin_money_trigger('withdrawals');
  DROP TRIGGER IF EXISTS admin_referral_award_change ON referral_awards;
  CREATE TRIGGER admin_referral_award_change AFTER INSERT OR UPDATE OR DELETE ON referral_awards FOR EACH ROW EXECUTE FUNCTION admin_money_trigger('referrals');
  DROP TRIGGER IF EXISTS admin_room_change ON rooms;
  CREATE TRIGGER admin_room_change AFTER INSERT OR UPDATE OR DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION admin_room_trigger('false');
  DROP TRIGGER IF EXISTS admin_archived_room_change ON archived_rooms;
  CREATE TRIGGER admin_archived_room_change AFTER INSERT OR UPDATE OR DELETE ON archived_rooms FOR EACH ROW EXECUTE FUNCTION admin_room_trigger('true');
  DROP TRIGGER IF EXISTS admin_poster_change ON admin_posters;
  CREATE TRIGGER admin_poster_change AFTER INSERT OR UPDATE OR DELETE ON admin_posters FOR EACH ROW EXECUTE FUNCTION admin_content_trigger('posters','id');
  DROP TRIGGER IF EXISTS admin_deposit_number_change ON deposit_numbers;
  CREATE TRIGGER admin_deposit_number_change AFTER INSERT OR UPDATE OR DELETE ON deposit_numbers FOR EACH ROW EXECUTE FUNCTION admin_content_trigger('deposit-numbers','id');
  DROP TRIGGER IF EXISTS admin_message_change ON admin_messages;
  CREATE TRIGGER admin_message_change AFTER INSERT OR UPDATE OR DELETE ON admin_messages FOR EACH ROW EXECUTE FUNCTION admin_content_trigger('messages','id');
`;

async function backfill(client) {
  const claimed = await client.query(`
    INSERT INTO admin_read_model_state(key, value) VALUES ('schema-v1-backfilled', 'running')
    ON CONFLICT (key) DO UPDATE SET value='running', updated_at=NOW()
      WHERE admin_read_model_state.value <> 'complete'
    RETURNING key
  `);
  if (!claimed.rows.length) return;
  try {
    await client.query("TRUNCATE admin_user_projection, admin_room_projection");
    await client.query(`
      INSERT INTO admin_user_projection(user_id, row_data)
      SELECT u.telegram_id, to_jsonb(row_value) FROM (
        SELECT u.*, COALESCE(ugs.games_played,0) games_played, COALESCE(ugs.wins,0) wins,
          COALESCE(ugs.amount_played,0) amount_played, COALESCE(ref.share_count,0) share_count,
          COALESCE(ref.reward_count,0) reward_count, COALESCE(ref.max_rewards,0) max_rewards
        FROM users u LEFT JOIN user_game_stats ugs ON ugs.user_id=u.telegram_id
        LEFT JOIN (SELECT user_id, SUM(share_count) share_count, SUM(reward_count) reward_count,
          SUM(max_rewards) max_rewards FROM referral_links GROUP BY user_id) ref ON ref.user_id=u.telegram_id
        WHERE u.telegram_id NOT LIKE 'botgamer:%'
      ) row_value JOIN users u ON u.telegram_id=row_value.telegram_id
    `);
    await client.query(`
      INSERT INTO admin_room_projection(room_id,row_data,is_archived)
      SELECT id, to_jsonb(r) || '{"is_archived":false}'::jsonb, false FROM rooms r
      UNION ALL SELECT id, to_jsonb(a) || '{"is_archived":true}'::jsonb, true FROM archived_rooms a
    `);
    await client.query(`
      UPDATE admin_metrics SET
        total_users=(SELECT COUNT(*) FROM users WHERE telegram_id NOT LIKE 'botgamer:%'),
        total_balance=(SELECT COALESCE(SUM(balance),0) FROM users WHERE telegram_id NOT LIKE 'botgamer:%'),
        total_deposits=(SELECT COALESCE(SUM(amount),0) FROM transactions),
        total_withdrawals=(SELECT COALESCE(SUM(amount),0) FROM withdrawal_requests),
        pending_withdrawal_count=(SELECT COUNT(*) FROM withdrawal_requests WHERE status='pending'),
        total_referral_rewards=(SELECT COALESCE(SUM(amount),0) FROM referral_awards),
        total_rooms=(SELECT COUNT(*) FROM rooms)+(SELECT COUNT(*) FROM archived_rooms),
        waiting=(SELECT COUNT(*) FROM rooms WHERE status='waiting'),
        playing=(SELECT COUNT(*) FROM rooms WHERE status='playing'),
        ended=(SELECT COUNT(*) FROM rooms WHERE status='ended'),
        archived=(SELECT COUNT(*) FROM archived_rooms),
        active_players=(SELECT COALESCE(SUM(player_count),0) FROM rooms WHERE status='playing'),
        current_round_pot=(SELECT COALESCE(SUM(COALESCE(NULLIF(room_stats->>'currentRoundPot','')::numeric,0)),0) FROM rooms),
        total_games=(SELECT COALESCE(SUM(COALESCE(NULLIF(room_stats->>'gamesPlayed','')::bigint,0)),0) FROM rooms)+(SELECT COALESCE(SUM(COALESCE(NULLIF(room_stats->>'gamesPlayed','')::bigint,0)),0) FROM archived_rooms),
        total_commission=(SELECT COALESCE(SUM(COALESCE(NULLIF(room_stats->>'commissionAmount','')::numeric,0)),0) FROM rooms)+(SELECT COALESCE(SUM(COALESCE(NULLIF(room_stats->>'commissionAmount','')::numeric,0)),0) FROM archived_rooms),
        total_payouts=(SELECT COALESCE(SUM(admin_json_numeric_sum(room_stats->'payouts')),0) FROM rooms)+(SELECT COALESCE(SUM(admin_json_numeric_sum(room_stats->'payouts')),0) FROM archived_rooms),
        total_refunds=(SELECT COALESCE(SUM(admin_json_numeric_sum(room_stats->'refunds')),0) FROM rooms)+(SELECT COALESCE(SUM(admin_json_numeric_sum(room_stats->'refunds')),0) FROM archived_rooms),
        total_leave_penalties=(SELECT COALESCE(SUM(COALESCE(NULLIF(room_stats->>'leavePenaltyAmount','')::numeric,0)),0) FROM rooms)+(SELECT COALESCE(SUM(COALESCE(NULLIF(room_stats->>'leavePenaltyAmount','')::numeric,0)),0) FROM archived_rooms),
        updated_at=NOW() WHERE id=1
    `);
    await client.query("SELECT admin_emit_change('system', 'bootstrap', 'refresh', '{}'::jsonb)");
    await client.query("UPDATE admin_read_model_state SET value='complete', updated_at=NOW() WHERE key='schema-v1-backfilled'");
  } catch (error) {
    await client.query("DELETE FROM admin_read_model_state WHERE key='schema-v1-backfilled'").catch(() => {});
    throw error;
  }
}

async function ensureAdminReadModel() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(92478123)");
        await client.query(SCHEMA_SQL);
        await backfill(client);
        await client.query("DELETE FROM admin_changes WHERE created_at < NOW() - INTERVAL '30 days'");
      } finally {
        await client.query("SELECT pg_advisory_unlock(92478123)").catch(() => {});
        client.release();
      }
    })().catch((error) => { ensurePromise = null; throw error; });
  }
  return ensurePromise;
}

async function getMetrics() {
  await ensureAdminReadModel();
  const result = await query("SELECT * FROM admin_metrics WHERE id=1");
  return result.rows[0] || {};
}

async function getProjectedUsers() {
  await ensureAdminReadModel();
  const result = await query("SELECT row_data FROM admin_user_projection ORDER BY updated_at DESC");
  return result.rows.map((row) => row.row_data);
}

async function getProjectedRooms() {
  await ensureAdminReadModel();
  const result = await query("SELECT row_data FROM admin_room_projection ORDER BY updated_at DESC");
  return result.rows.map((row) => row.row_data);
}

async function getChanges(after, limit = 500) {
  await ensureAdminReadModel();
  const cursor = Math.max(0, Number(after) || 0);
  const boundedLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const bounds = await query("SELECT COALESCE(MIN(sequence),0) min, COALESCE(MAX(sequence),0) max FROM admin_changes");
  const min = Number(bounds.rows[0]?.min || 0);
  const max = Number(bounds.rows[0]?.max || 0);
  if (cursor && min && cursor < min - 1) return { stale: true, cursor: max, changes: [] };
  const result = await query(`SELECT sequence, topic, entity_id, operation, payload, created_at
    FROM admin_changes WHERE sequence > $1 ORDER BY sequence ASC LIMIT $2`, [cursor, boundedLimit]);
  const changes = result.rows.map((row) => ({
    sequence: Number(row.sequence), topic: row.topic, entityId: row.entity_id,
    operation: row.operation, payload: row.payload, createdAt: row.created_at,
  }));
  return { stale: false, cursor: changes.length ? changes[changes.length - 1].sequence : max, hasMore: changes.length === boundedLimit, changes };
}

async function startAdminChangeListener(io) {
  if (listenerClient || !io) return;
  await ensureAdminReadModel();
  listenerClient = await pool.connect();
  await listenerClient.query("LISTEN admin_changes");
  listenerClient.on("notification", (message) => {
    if (message.channel === "admin_changes") io.of("/admin").emit("admin_change", { cursor: Number(message.payload || 0) });
  });
  listenerClient.on("error", (error) => {
    console.error("Admin change listener error:", error);
    listenerClient?.release(); listenerClient = null;
  });
}

async function stopAdminChangeListener() {
  const client = listenerClient;
  listenerClient = null;
  if (!client) return;
  await client.query("UNLISTEN admin_changes").catch(() => {});
  client.release();
}

module.exports = {
  ensureAdminReadModel,
  getChanges,
  getMetrics,
  getProjectedRooms,
  getProjectedUsers,
  startAdminChangeListener,
  stopAdminChangeListener,
  testUtils: { SCHEMA_SQL },
};
