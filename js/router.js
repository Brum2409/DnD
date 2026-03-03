/**
 * router.js — Simple hash-based client-side router.
 *
 * Usage:
 *   import { router } from './router.js';
 *   router.on('/', () => renderHome());
 *   router.on('/characters', () => renderCharacters());
 *   router.init();
 *
 * Navigate: router.navigate('/characters')
 * Current:  router.current()
 */

class Router {
  constructor() {
    /** @type {Map<string, Function>} */
    this._routes    = new Map();
    this._notFound  = null;
    this._before    = null;  // optional middleware before each route
  }

  /**
   * Register a route handler.
   * @param {string} path   - hash path, e.g. '/' or '/characters'
   * @param {Function} fn   - called when route matches; receives { params, query }
   */
  on(path, fn) {
    this._routes.set(path, fn);
    return this;
  }

  /**
   * Register a fallback handler for unmatched routes.
   * @param {Function} fn
   */
  notFound(fn) {
    this._notFound = fn;
    return this;
  }

  /**
   * Register middleware called before every route change.
   * @param {Function} fn   - receives { from, to } — return false to cancel
   */
  before(fn) {
    this._before = fn;
    return this;
  }

  /**
   * Start the router (listen to hash changes and fire the current route).
   */
  init() {
    window.addEventListener('hashchange', () => this._dispatch());
    this._dispatch();
  }

  /**
   * Navigate to a path (updates the hash).
   * @param {string} path
   * @param {Object} [query]  - optional query params
   */
  navigate(path, query = {}) {
    const qs = Object.keys(query).length
      ? '?' + new URLSearchParams(query).toString()
      : '';
    window.location.hash = path + qs;
  }

  /**
   * Get the current hash path (without the leading #).
   * @returns {string}
   */
  current() {
    return this._parsePath().path;
  }

  // ── Private ──────────────────────────────────────────────────

  _parsePath() {
    const hash  = window.location.hash.slice(1) || '/';
    const [pathWithSlash, rawQuery = ''] = hash.split('?');
    const path  = pathWithSlash || '/';
    const query = Object.fromEntries(new URLSearchParams(rawQuery));
    return { path, query };
  }

  _dispatch() {
    const { path, query } = this._parsePath();

    const from = this._currentPath;
    this._currentPath = path;

    if (this._before) {
      const result = this._before({ from, to: path });
      if (result === false) return;
    }

    const handler = this._routes.get(path);
    if (handler) {
      handler({ query });
    } else if (this._notFound) {
      this._notFound({ path, query });
    }
  }
}

export const router = new Router();
