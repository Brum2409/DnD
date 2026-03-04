/**
 * GET  /api/settings  — return the authenticated user's settings
 * PUT  /api/settings  — update one or more settings fields
 *
 * Allowed fields: gemini_api_key, gemini_model, image_model, hf_api_key
 */

import { verifyAuth, sendError } from './_lib/auth.js';
import { ensureSchema, query } from './_lib/db.js';

const ALLOWED_FIELDS = ['gemini_api_key', 'gemini_model', 'image_model', 'hf_api_key'];

export default async function handler(req, res) {
  let userId;
  try {
    userId = verifyAuth(req);
  } catch {
    return sendError(res, 401, 'Unauthorized');
  }

  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const { rows } = await query(
        'SELECT gemini_api_key, gemini_model, image_model, hf_api_key FROM user_settings WHERE user_id = $1',
        [userId]
      );
      return res.status(200).json(rows[0] || {
        gemini_api_key: '',
        gemini_model: 'gemini-3.1-flash-lite-preview',
        image_model: 'pollinations',
        hf_api_key: '',
      });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const updates = {};
      for (const field of ALLOWED_FIELDS) {
        if (field in body) updates[field] = String(body[field] || '');
      }

      if (Object.keys(updates).length === 0) {
        return sendError(res, 400, 'No valid fields to update');
      }

      // Build dynamic SET clause
      const fields = Object.keys(updates);
      const values = Object.values(updates);
      const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');

      await query(
        `INSERT INTO user_settings (user_id, ${fields.join(', ')}, updated_at)
         VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')}, NOW())
         ON CONFLICT (user_id) DO UPDATE SET ${setClauses}, updated_at = NOW()`,
        [userId, ...values]
      );

      return res.status(200).json({ ok: true });
    }

    return sendError(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[settings]', err);
    return sendError(res, 500, 'Server error');
  }
}
