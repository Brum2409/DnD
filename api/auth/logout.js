/**
 * POST /api/auth/logout
 * Clears the auth cookie.
 * Returns: { ok: true }
 */

import { clearAuthCookie } from '../_lib/auth.js';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Set-Cookie', clearAuthCookie());
  return res.status(200).json({ ok: true });
}
