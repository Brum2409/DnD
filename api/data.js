/**
 * GET /api/data
 * Bulk-loads all user data in a single request for the client-side cache.
 * Returns: { characters: [...], items: [...], stories: [...] }
 */

import { verifyAuth, sendError } from './_lib/auth.js';
import { ensureSchema, query } from './_lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  let userId;
  try {
    userId = verifyAuth(req);
  } catch {
    return sendError(res, 401, 'Unauthorized');
  }

  try {
    await ensureSchema();

    const [charResult, itemResult, storyResult, spellResult] = await Promise.all([
      query('SELECT data FROM characters WHERE user_id = $1 ORDER BY updated_at DESC', [userId]),
      query('SELECT data FROM items WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
      query('SELECT data FROM stories WHERE user_id = $1 ORDER BY updated_at DESC', [userId]),
      query('SELECT data FROM spells WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
    ]);

    return res.status(200).json({
      characters: charResult.rows.map(r => r.data),
      items: itemResult.rows.map(r => r.data),
      stories: storyResult.rows.map(r => r.data),
      spells: spellResult.rows.map(r => r.data),
    });
  } catch (err) {
    console.error('[data]', err);
    return sendError(res, 500, 'Failed to load data');
  }
}
