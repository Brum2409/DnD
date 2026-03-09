/**
 * settings.js — In-memory settings store for the authenticated user.
 *
 * Replaces localStorage for API keys and model preferences.
 * Settings are loaded from the server after login (via auth.js → /api/auth/me)
 * and saved back to the server when changed.
 *
 * Usage:
 *   import { getSettings, loadSettings, saveSettings } from './settings.js';
 */

let _settings = {
  gemini_api_key: '',
  gemini_model: 'gemini-3.1-flash-lite-preview',
  image_model: 'pollinations',
  hf_api_key: '',
  // DM style
  dm_response_length: 'balanced',
  dm_tone: 'dark_fantasy',
  dm_pacing: 'medium',
  // Expert
  dm_extra_instructions: '',
  dm_system_prompt_override: '',
};

/**
 * Get the current in-memory settings object.
 * @returns {{ gemini_api_key: string, gemini_model: string, image_model: string, hf_api_key: string }}
 */
export function getSettings() {
  return _settings;
}

/**
 * Merge server-returned settings into the in-memory store.
 * Called by auth.js after a successful /api/auth/me response.
 * @param {Object} serverSettings
 */
export function loadSettings(serverSettings) {
  _settings = { ..._settings, ...serverSettings };
}

/**
 * Update one or more settings fields in memory and persist to the server.
 * @param {Partial<typeof _settings>} patch
 * @returns {Promise<void>}
 */
export async function saveSettings(patch) {
  Object.assign(_settings, patch);
  try {
    const resp = await fetch('/api/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) {
      console.error(`[settings] Server rejected settings update: HTTP ${resp.status}`);
    }
  } catch (err) {
    console.error('[settings] Failed to persist settings:', err);
  }
}
