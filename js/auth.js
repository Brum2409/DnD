/**
 * auth.js — Client-side authentication state management.
 *
 * Every protected page must call initPage() before rendering.
 * initPage() checks the session, loads settings + all user data,
 * then returns the current user object.
 *
 * Usage in every page's <script type="module">:
 *   import { initPage, getCurrentUser, logout } from './js/auth.js';
 *
 *   document.addEventListener('DOMContentLoaded', async () => {
 *     const user = await initPage();
 *     if (!user) return; // initPage redirected to login
 *     // ... rest of page init
 *   });
 */

import { loadSettings } from './settings.js';
import { init as dbInit } from './db.js';

let _user = null;

/**
 * Initialize the page: verify auth, load settings + data, return the user.
 * Redirects to /login.html if not authenticated.
 *
 * @returns {Promise<{id: string, email: string, username: string}|null>}
 */
export async function initPage() {
  try {
    const resp = await fetch('/api/auth/me', { credentials: 'include' });

    if (!resp.ok) {
      // Not authenticated — redirect to login
      window.location.href = '/login.html';
      return null;
    }

    const { user, settings } = await resp.json();
    _user = user;

    // Populate in-memory settings (API keys, model preferences)
    loadSettings(settings);

    // Bulk-load all user data into the in-memory cache
    await dbInit();

    return user;
  } catch (err) {
    console.error('[auth] initPage failed:', err);
    window.location.href = '/login.html';
    return null;
  }
}

/**
 * Get the currently authenticated user object, or null if not loaded yet.
 * @returns {{id: string, email: string, username: string}|null}
 */
export function getCurrentUser() {
  return _user;
}

/**
 * Log out the current user and redirect to login.html.
 * @returns {Promise<void>}
 */
export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Ignore errors — proceed with redirect regardless
  }
  window.location.href = '/login.html';
}
