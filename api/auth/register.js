/**
 * POST /api/auth/register
 * Body: { email, username, password }
 * Returns: { user: { id, email, username } }
 */

import bcrypt from 'bcryptjs';
import { ensureSchema, query } from '../_lib/db.js';
import { setAuthCookie, sendError } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  try {
    await ensureSchema();

    const { email, username, password } = req.body || {};

    if (!email || !username || !password) {
      return sendError(res, 400, 'Email, username, and password are required');
    }

    const emailTrimmed = email.trim().toLowerCase();
    const usernameTrimmed = username.trim();

    if (emailTrimmed.length < 3 || !emailTrimmed.includes('@')) {
      return sendError(res, 400, 'Invalid email address');
    }
    if (usernameTrimmed.length < 2 || usernameTrimmed.length > 30) {
      return sendError(res, 400, 'Username must be 2–30 characters');
    }
    if (password.length < 6) {
      return sendError(res, 400, 'Password must be at least 6 characters');
    }

    // Check for existing email or username
    const { rows: existing } = await query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [emailTrimmed, usernameTrimmed]
    );
    if (existing.length > 0) {
      return sendError(res, 409, 'Email or username already in use');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await query(
      'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, email, username',
      [emailTrimmed, usernameTrimmed, passwordHash]
    );
    const user = rows[0];

    // Create default settings row for this user
    await query(
      'INSERT INTO user_settings (user_id) VALUES ($1)',
      [user.id]
    );

    res.setHeader('Set-Cookie', setAuthCookie(user.id));
    return res.status(201).json({ user: { id: user.id, email: user.email, username: user.username } });
  } catch (err) {
    console.error('[register]', err);
    return sendError(res, 500, 'Registration failed. Please try again.');
  }
}
