/**
 * GET /api/auth/me
 * Returns the current authenticated user + their settings.
 * Returns 401 if not authenticated.
 * Returns: { user: { id, email, username }, settings: { gemini_api_key, gemini_model, image_model, hf_api_key } }
 */

import { verifyAuth, sendError } from '../_lib/auth.js';
import { ensureSchema, query } from '../_lib/db.js';

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

    const { rows: users } = await query(
      'SELECT id, email, username FROM users WHERE id = $1',
      [userId]
    );
    if (users.length === 0) return sendError(res, 401, 'User not found');

    const { rows: settings } = await query(
      'SELECT gemini_api_key, gemini_model, image_model, hf_api_key FROM user_settings WHERE user_id = $1',
      [userId]
    );

    const userSettings = settings[0] || {
      gemini_api_key: '',
      gemini_model: 'gemini-3.1-flash-lite-preview',
      image_model: 'pollinations',
      hf_api_key: '',
    };

    return res.status(200).json({
      user: users[0],
      settings: userSettings,
    });
  } catch (err) {
    console.error('[me]', err);
    return sendError(res, 500, 'Server error');
  }
}
