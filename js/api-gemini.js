/**
 * api-gemini.js — Google Gemini API wrapper.
 *
 * Uses the free Gemini Flash model via the REST API.
 * API key and model preference are stored server-side per user
 * via the settings module (loaded into memory after login).
 *
 * Usage:
 *   import { geminiChat, geminiGenerate, setGeminiKey } from './api-gemini.js';
 *
 *   const text = await geminiGenerate('Write a short DND tavern description.');
 *   const reply = await geminiChat(history, systemPrompt);
 */

import { getSettings, saveSettings } from './settings.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Available models the user can choose from. */
export const GEMINI_MODELS = [
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite Preview (Default)' },
  { id: 'gemini-2.5-flash',              label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite',         label: 'Gemini 2.5 Flash-Lite (Budget)' },
  { id: 'gemini-2.0-flash',              label: 'Gemini 2.0 Flash' },
  { id: 'gemini-1.5-flash',              label: 'Gemini 1.5 Flash (Legacy)' },
];

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

// ── Key management ────────────────────────────────────────────

/**
 * Get the stored Gemini API key from the in-memory settings store.
 * @returns {string}
 */
export function getGeminiKey() {
  return getSettings().gemini_api_key || '';
}

/**
 * Set the Gemini API key in memory and persist to server.
 * @param {string} key
 */
export function setGeminiKey(key) {
  saveSettings({ gemini_api_key: key.trim() });
}

/**
 * Check whether an API key has been set.
 * @returns {boolean}
 */
export function hasGeminiKey() {
  return Boolean(getGeminiKey());
}

// ── Model management ──────────────────────────────────────────

/**
 * Get the currently selected Gemini model ID from in-memory settings.
 * @returns {string}
 */
export function getGeminiModel() {
  return getSettings().gemini_model || DEFAULT_GEMINI_MODEL;
}

/**
 * Persist the selected Gemini model ID to memory and server.
 * @param {string} modelId
 */
export function setGeminiModel(modelId) {
  saveSettings({ gemini_model: modelId });
}

// ── Core API call ─────────────────────────────────────────────

/**
 * Low-level call to the Gemini generateContent endpoint.
 * @param {Object[]} contents  - Gemini-format contents array
 * @param {string}   systemInstruction
 * @param {number}   [temperature]
 * @returns {Promise<string>}
 */
async function callGemini(contents, systemInstruction = '', temperature = 0.85) {
  const key = getGeminiKey();
  if (!key) throw new Error('Gemini API key not set. Click ⚙️ Settings to add your key.');

  const url = `${GEMINI_API_BASE}/${getGeminiModel()}:generateContent?key=${key}`;

  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: 2048,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Multi-turn chat with the Gemini model.
 *
 * @param {Array<{role: 'user'|'model', parts: [{text: string}]}>} messages
 * @param {string} [systemPrompt]   - injected as the system instruction
 * @param {number} [temperature]
 * @returns {Promise<string>}
 */
export async function geminiChat(messages, systemPrompt = '', temperature = 0.85) {
  // Filter to only user/model roles (skip system messages — handled via systemInstruction)
  const contents = messages
    .filter(m => m.role === 'user' || m.role === 'model')
    .map(m => ({
      role: m.role,
      parts: Array.isArray(m.parts) ? m.parts : [{ text: String(m.parts) }],
    }));

  if (contents.length === 0) throw new Error('No messages to send.');
  return callGemini(contents, systemPrompt, temperature);
}

/**
 * Single-turn text generation.
 *
 * @param {string} prompt
 * @param {string} [systemPrompt]
 * @param {number} [temperature]
 * @returns {Promise<string>}
 */
export async function geminiGenerate(prompt, systemPrompt = '', temperature = 0.9) {
  const contents = [{ role: 'user', parts: [{ text: prompt }] }];
  return callGemini(contents, systemPrompt, temperature);
}

/**
 * Test that the API key is valid by sending a minimal request.
 * @returns {Promise<boolean>}
 */
export async function testGeminiKey() {
  try {
    const result = await geminiGenerate('Reply with exactly one word: Ready');
    return typeof result === 'string' && result.length > 0;
  } catch {
    return false;
  }
}

// ── Conversion helpers ────────────────────────────────────────

/**
 * Convert our internal Message[] (from db.js) to Gemini content format.
 * Skips system messages (they go in the systemInstruction field instead).
 *
 * @param {import('./db.js').Message[]} messages
 * @returns {Array<{role: string, parts: [{text: string}]}>}
 */
export function toGeminiHistory(messages) {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}
