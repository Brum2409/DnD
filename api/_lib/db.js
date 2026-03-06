/**
 * api/_lib/db.js — Neon/Postgres database client and schema initialization.
 *
 * Uses @neondatabase/serverless which works with Vercel's Neon integration.
 * The DATABASE_URL environment variable is set automatically by Vercel
 * when you add the Neon Postgres integration.
 *
 * Usage:
 *   import { query, ensureSchema } from '../_lib/db.js';
 *   await ensureSchema();
 *   const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
 */

import { neon } from '@neondatabase/serverless';

let _sql = null;

/**
 * Get (or lazily create) the Neon SQL client.
 * @returns {import('@neondatabase/serverless').NeonQueryFunction}
 */
function getSql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set.');
    }
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

/**
 * Execute a parameterized SQL query.
 * @param {string} text  - SQL with $1, $2, ... placeholders
 * @param {any[]}  [params]
 * @returns {Promise<{ rows: any[] }>}
 */
export async function query(text, params = []) {
  const sql = getSql();
  const rows = await sql(text, params);
  return { rows };
}

/**
 * Create all required tables if they don't exist.
 * Call this at the start of each serverless function (idempotent).
 */
export async function ensureSchema() {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      gemini_api_key TEXT DEFAULT '',
      gemini_model TEXT DEFAULT 'gemini-3.1-flash-lite-preview',
      image_model TEXT DEFAULT 'pollinations',
      hf_api_key TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Migrations — add new columns to existing deployments
  await sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dm_response_length TEXT DEFAULT 'balanced'`;
  await sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dm_tone TEXT DEFAULT 'dark_fantasy'`;
  await sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dm_pacing TEXT DEFAULT 'medium'`;
  await sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dm_extra_instructions TEXT DEFAULT ''`;
  await sql`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dm_system_prompt_override TEXT DEFAULT ''`;

  await sql`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS spells (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}
