CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  phone TEXT,
  username TEXT DEFAULT '',
  display_name TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  balance NUMERIC(12, 0) NOT NULL DEFAULT 0,
  room_in TEXT,
  deposit_sum NUMERIC(12, 0) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 0) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_in TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_sum NUMERIC(12, 0) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  entry_fee NUMERIC(12, 0) NOT NULL DEFAULT 0,
  stake NUMERIC(12, 0) NOT NULL DEFAULT 0,
  creator_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  players TEXT[] NOT NULL DEFAULT '{}',
  player_count INTEGER NOT NULL DEFAULT 0,
  max_players INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'waiting',
  room_stats JSONB NOT NULL DEFAULT '{"gamesPlayed":0,"winnerCounts":{}}'::jsonb
);

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS players TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS player_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_players INTEGER NOT NULL DEFAULT 2;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_stats JSONB NOT NULL DEFAULT '{"gamesPlayed":0,"winnerCounts":{}}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_rooms_visibility_created_at
  ON rooms (visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS archived_rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  entry_fee NUMERIC(12, 0) NOT NULL DEFAULT 0,
  stake NUMERIC(12, 0) NOT NULL DEFAULT 0,
  creator_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  players TEXT[] NOT NULL DEFAULT '{}',
  player_count INTEGER NOT NULL DEFAULT 0,
  max_players INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'ended',
  room_stats JSONB NOT NULL DEFAULT '{"gamesPlayed":0,"winnerCounts":{}}'::jsonb,
  archived_reason TEXT NOT NULL DEFAULT 'room-deleted',
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archived_rooms_archived_at
  ON archived_rooms (archived_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name_unique
  ON users (LOWER(display_name))
  WHERE display_name IS NOT NULL AND display_name <> '';

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  amount NUMERIC(12, 0) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_timestamp
  ON transactions (timestamp DESC);

CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  total_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS referral_links (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  link TEXT NOT NULL,
  share_count INTEGER NOT NULL DEFAULT 0,
  reward_count INTEGER NOT NULL DEFAULT 0,
  max_rewards INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_game_stats (
  user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  games_played INTEGER NOT NULL DEFAULT 0,
  amount_played NUMERIC(12, 0) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_links_user_id
  ON referral_links (user_id);

CREATE TABLE IF NOT EXISTS referral_awards (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES referral_links(code) ON DELETE CASCADE,
  referrer_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  referred_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  amount NUMERIC(12, 0) NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (code, referred_user_id)
);

CREATE TABLE IF NOT EXISTS admin_posters (
  id BIGSERIAL PRIMARY KEY,
  image_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_posters_active
  ON admin_posters (is_active, sort_order, created_at DESC);

CREATE TABLE IF NOT EXISTS deposit_numbers (
  id BIGSERIAL PRIMARY KEY,
  phone_number TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_numbers_active
  ON deposit_numbers (is_active, sort_order, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_messages (
  id BIGSERIAL PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  target_mode TEXT NOT NULL DEFAULT 'filtered',
  target_count INTEGER NOT NULL DEFAULT 0,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_message_recipients (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES admin_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_message_recipients_message
  ON admin_message_recipients (message_id);
