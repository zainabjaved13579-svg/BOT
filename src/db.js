const { Pool } = require('pg');

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
  });
} else {
  const { newDb } = require('pg-mem');
  const localDatabase = newDb();
  const { Pool: MemoryPool } = localDatabase.adapters.createPg();
  pool = new MemoryPool();
  console.warn('DATABASE_URL is unset; using temporary in-memory storage for local testing. Data will not persist.');
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      welcome_channel_id TEXT,
      welcome_message TEXT,
      welcome_banner TEXT,
      leave_channel_id TEXT,
      leave_message TEXT,
      leave_banner TEXT,
      ticket_category_id TEXT,
      ticket_staff_role_id TEXT,
      application_channel_id TEXT,
      application_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      application_review_channel_id TEXT,
      application_staff_role_id TEXT,
      transcript_channel_id TEXT,
      moderation_log_channel_id TEXT,
      auto_role_id TEXT,
      links_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      scamguard_channel_id TEXT,
      scamguard_terms JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS application_review_channel_id TEXT;
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS application_staff_role_id TEXT;
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS transcript_channel_id TEXT;
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS moderation_log_channel_id TEXT;
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS auto_role_id TEXT;
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS links_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS scamguard_channel_id TEXT;
    ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS scamguard_terms JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE TABLE IF NOT EXISTS command_roles (
      guild_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, command_name, role_id)
    );
    CREATE TABLE IF NOT EXISTS command_users (
      guild_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, command_name, user_id)
    );
    CREATE TABLE IF NOT EXISTS automod_terms (
      guild_id TEXT NOT NULL,
      term TEXT NOT NULL,
      PRIMARY KEY (guild_id, term)
    );
    CREATE TABLE IF NOT EXISTS moderation_strikes (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      strikes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS auto_replies (
      guild_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      response TEXT NOT NULL,
      PRIMARY KEY (guild_id, keyword)
    );
    CREATE TABLE IF NOT EXISTS triggers (
      guild_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      response TEXT NOT NULL,
      PRIMARY KEY (guild_id, keyword)
    );
    CREATE TABLE IF NOT EXISTS member_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      messages INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS tickets (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      opener_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      application_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      question_index INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS application_questions JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS question_index INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS ticket_themes (
      guild_id TEXT NOT NULL,
      theme_key TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (guild_id, theme_key)
    );
    CREATE TABLE IF NOT EXISTS ticket_blocked_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS giveaways (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      prize TEXT NOT NULL,
      winner_count INTEGER NOT NULL DEFAULT 1,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS giveaway_entries (
      giveaway_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (giveaway_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS member_stats_leaderboard_idx
      ON member_stats (guild_id, xp DESC);
  `);
}

async function getGuildSettings(guildId) {
  const { rows } = await pool.query(
    'SELECT * FROM guild_settings WHERE guild_id = $1',
    [guildId]
  );
  return rows[0] ?? {};
}

async function updateGuildSettings(guildId, updates) {
  const columns = Object.keys(updates);
  if (columns.length === 0) return;

  const values = [guildId];
  const assignments = columns.map((column, index) => {
    values.push(updates[column]);
    return `${column} = $${index + 2}`;
  });

  await pool.query(
    `INSERT INTO guild_settings (guild_id, ${columns.join(', ')})
     VALUES ($1, ${columns.map((_, index) => `$${index + 2}`).join(', ')})
     ON CONFLICT (guild_id) DO UPDATE SET ${assignments.join(', ')}`,
    values
  );
}

module.exports = { pool, initializeDatabase, getGuildSettings, updateGuildSettings };
