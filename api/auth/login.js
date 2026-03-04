/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns: { user: { id, email, username } }
 */

import bcrypt from 'bcryptjs';
import { ensureSchema, query } from '../_lib/db.js';
import { setAuthCookie, sendError } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  if (!process.env.DATABASE_URL) {
    console.error('[login] DATABASE_URL environment variable is not set.');
    return sendError(res, 503, 'Service not configured. Please contact the administrator.');
  }
  if (!process.env.JWT_SECRET) {
    console.error('[login] JWT_SECRET environment variable is not set.');
    return sendError(res, 503, 'Service not configured. Please contact the administrator.');
  }

  try {
    await ensureSchema();

    const { email, password } = req.body || {};

    if (!email || !password) {
      return sendError(res, 400, 'Email and password are required');
    }

    const { rows } = await query(
      'SELECT id, email, username, password_hash FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'Invalid email or password');
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return sendError(res, 401, 'Invalid email or password');
    }

    res.setHeader('Set-Cookie', setAuthCookie(user.id));
    return res.status(200).json({
      user: { id: user.id, email: user.email, username: user.username },
    });
  } catch (err) {
    console.error('[login]', err);
    return sendError(res, 500, 'Login failed. Please try again.');
  }
}
