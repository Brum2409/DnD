/**
 * api/_lib/auth.js — JWT authentication helper for Vercel serverless functions.
 *
 * Usage in any API route:
 *   import { verifyAuth, setAuthCookie, clearAuthCookie } from '../_lib/auth.js';
 *   const userId = verifyAuth(req); // throws on invalid/missing token
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = 'token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days in seconds

if (!JWT_SECRET) {
  throw new Error('[auth] JWT_SECRET environment variable is not set. Set it in your Vercel project settings.');
}

/**
 * Parse cookies from the Cookie request header.
 * @param {string} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), decodeURIComponent(v.join('='))];
    })
  );
}

/**
 * Verify the JWT token from the request cookie.
 * @param {import('@vercel/node').VercelRequest} req
 * @returns {string} userId
 * @throws {Error} with status 401 if token is missing or invalid
 */
export function verifyAuth(req) {
  const cookies = parseCookies(req.headers['cookie'] || '');
  const token = cookies[COOKIE_NAME];

  if (!token) {
    const err = new Error('Unauthorized: no token');
    err.status = 401;
    throw err;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.userId;
  } catch {
    const err = new Error('Unauthorized: invalid token');
    err.status = 401;
    throw err;
  }
}

/**
 * Sign a new JWT and return it as a Set-Cookie header value.
 * @param {string} userId
 * @returns {string} Set-Cookie header value
 */
export function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Build a Set-Cookie header string that sets the auth token.
 * @param {string} userId
 * @returns {string}
 */
export function setAuthCookie(userId) {
  const token = signToken(userId);
  const flags = [
    `${COOKIE_NAME}=${token}`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    // 'Secure', // uncomment if you want HTTPS-only (Vercel always uses HTTPS)
  ];
  return flags.join('; ');
}

/**
 * Build a Set-Cookie header string that clears the auth token.
 * @returns {string}
 */
export function clearAuthCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * Send a JSON error response with the given status code.
 * @param {import('@vercel/node').VercelResponse} res
 * @param {number} status
 * @param {string} message
 */
export function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}
