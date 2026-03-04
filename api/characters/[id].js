/**
 * PUT    /api/characters/:id  — upsert (create or update) a character
 * DELETE /api/characters/:id  — delete a character
 *
 * Body for PUT: full character JSON object
 */

import { verifyAuth, sendError } from '../_lib/auth.js';
import { ensureSchema, query } from '../_lib/db.js';

export default async function handler(req, res) {
  let userId;
  try {
    userId = verifyAuth(req);
  } catch {
    return sendError(res, 401, 'Unauthorized');
  }

  const { id } = req.query;
  if (!id) return sendError(res, 400, 'Missing character id');

  try {
    await ensureSchema();

    if (req.method === 'PUT') {
      const data = req.body;
      if (!data || typeof data !== 'object') return sendError(res, 400, 'Invalid body');

      await query(
        `INSERT INTO characters (id, user_id, data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE
         SET data = $3, updated_at = NOW()
         WHERE characters.user_id = $2`,
        [id, userId, JSON.stringify(data)]
      );

      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await query(
        'DELETE FROM characters WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      return res.status(200).json({ ok: true });
    }

    return sendError(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[characters/[id]]', err);
    return sendError(res, 500, 'Server error');
  }
}
