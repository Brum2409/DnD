/**
 * api-image.js — Image generation wrapper supporting multiple providers.
 *
 * Providers:
 *   - Pollinations.ai (free, no API key required) — default
 *   - Google Imagen 4 / Imagen 4 Fast / Imagen 4 Ultra (requires Gemini API key)
 *
 * Usage:
 *   import { generateImage, generateIconBase64, buildIconPrompt } from './api-image.js';
 *
 *   const url  = await generateImage('A dark fantasy forest at night', 1200, 512);
 *   const b64  = await generateIconBase64('Flaming sword, legendary weapon');
 */

import { getGeminiKey } from './api-gemini.js';

const POLLINATIONS_BASE    = 'https://image.pollinations.ai/prompt';
const GEMINI_IMAGE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Model registry ─────────────────────────────────────────────

export const IMAGE_MODELS = [
  { id: 'pollinations',                  label: 'Pollinations.ai / Flux (Free — No Key Required)', requiresKey: false },
  { id: 'imagen-4.0-generate-001',       label: 'Google Imagen 4 (Requires API Key)',               requiresKey: true  },
  { id: 'imagen-4.0-fast-generate-001',  label: 'Google Imagen 4 Fast (Requires API Key)',          requiresKey: true  },
  { id: 'imagen-4.0-ultra-generate-001', label: 'Google Imagen 4 Ultra (Requires API Key)',         requiresKey: true  },
];

const DEFAULT_IMAGE_MODEL = 'pollinations';

export function getImageModel() {
  const stored = localStorage.getItem('image_model');
  // Migrate deprecated Imagen 3 model IDs to Imagen 4 equivalents
  if (stored === 'imagen-3.0-generate-002')      return 'imagen-4.0-generate-001';
  if (stored === 'imagen-3.0-fast-generate-001') return 'imagen-4.0-fast-generate-001';
  return stored || DEFAULT_IMAGE_MODEL;
}

export function setImageModel(modelId) {
  localStorage.setItem('image_model', modelId);
}

// ── Core image generation ─────────────────────────────────────

/**
 * Generate an image using the currently selected provider.
 *
 * Returns either:
 *   - A Pollinations URL string (model = 'pollinations')
 *   - A base64 data URL     (model = any Google Imagen model)
 *
 * @param {string} prompt
 * @param {number} [width]
 * @param {number} [height]
 * @param {number} [seed]   - used only by Pollinations; ignored for Imagen
 * @returns {Promise<string>}  image URL or data URL
 */
export async function generateImage(prompt, width = 512, height = 512, seed = null) {
  const model = getImageModel();

  if (model === 'pollinations') {
    const encoded = encodeURIComponent(prompt);
    const s       = seed ?? Date.now();
    return `${POLLINATIONS_BASE}/${encoded}?width=${width}&height=${height}&seed=${s}&model=flux`;
  }

  return _generateImagenImage(prompt, width, height, model);
}

/**
 * Call the Google Imagen API (via Gemini API endpoint).
 *
 * @param {string} prompt
 * @param {number} width
 * @param {number} height
 * @param {string} modelId
 * @returns {Promise<string>}  base64 data URL
 */
async function _generateImagenImage(prompt, width, height, modelId) {
  const key = getGeminiKey();
  if (!key) throw new Error('A Gemini API key is required for Google Imagen models. Set one in Settings.');

  // Map dimensions to the closest supported aspect ratio
  const ratio = width / height;
  let aspectRatio = '1:1';
  if      (ratio >= 1.6)  aspectRatio = '16:9';
  else if (ratio >= 1.2)  aspectRatio = '4:3';
  else if (ratio <= 0.65) aspectRatio = '9:16';
  else if (ratio <= 0.85) aspectRatio = '3:4';

  const url = `${GEMINI_IMAGE_API_BASE}/${modelId}:predict?key=${key}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances:  [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Imagen API error: ${err.error?.message || `HTTP ${response.status}`}`);
  }

  const data = await response.json();
  const prediction = data.predictions?.[0];
  const b64  = prediction?.bytesBase64Encoded;
  const mime = prediction?.mimeType || 'image/png';

  if (!b64) throw new Error('No image data returned from Google Imagen.');

  return `data:${mime};base64,${b64}`;
}

// ── Icon generation ───────────────────────────────────────────

/**
 * Generate a small icon and return it as a base64 data URL.
 * Works with both Pollinations (fetches URL → base64) and Imagen (already base64).
 *
 * @param {string} prompt
 * @param {number} [size]   - icon dimensions (square), default 128
 * @returns {Promise<string>}  base64 data URL ("data:image/jpeg;base64,...")
 */
export async function generateIconBase64(prompt, size = 128) {
  const fullPrompt = `${prompt}, game item icon, fantasy art, dark background, detailed illustration`;
  const result     = await generateImage(fullPrompt, size, size);

  // Imagen returns a data URL directly — no extra fetch needed
  if (result.startsWith('data:')) return result;

  // Pollinations returns a URL — fetch and convert to base64
  const response = await fetch(result);
  if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`);
  const blob = await response.blob();
  return blobToBase64(blob);
}

/**
 * Generate a scene image (wide format) for the game screen.
 *
 * @param {string} prompt
 * @returns {Promise<string>}  image URL or data URL
 */
export async function generateSceneImage(prompt) {
  const enhancedPrompt = `${prompt}, fantasy digital painting, dramatic lighting, cinematic, highly detailed`;
  return generateImage(enhancedPrompt, 1200, 512);
}

// ── Icon prompt builder ───────────────────────────────────────

/**
 * Build an optimised icon generation prompt from an Item object.
 * Different rarities get different visual styles.
 *
 * @param {import('./db.js').Item} item
 * @returns {string}
 */
export function buildIconPrompt(item) {
  const rarityStyle = {
    common:    'simple, worn, muted colors, realistic',
    uncommon:  'well-crafted, green magical tint, glowing slightly',
    rare:      'ornate, blue magical glow, intricate details, enchanted',
    legendary: 'ancient, golden aura, radiating power, mythic, intricate engravings',
  }[item.rarity] || 'detailed, fantasy';

  return `${item.name}, DND fantasy ${item.type}, RPG game icon, isolated on dark background, ${rarityStyle}, pixel-art-inspired detailed illustration`;
}

// ── Portrait generation ───────────────────────────────────────

/**
 * Generate a character portrait URL or data URL.
 *
 * @param {{ name: string, race: string, class: string, backstory: string }} character
 * @returns {Promise<string>}
 */
export async function generatePortrait(character) {
  const prompt = `Portrait of ${character.name}, ${character.race} ${character.class}, DND fantasy character, dramatic lighting, detailed face, oil painting style, dark background`;
  return generateImage(prompt, 512, 512);
}

// ── Utilities ─────────────────────────────────────────────────

/**
 * Convert a Blob to a base64 data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader    = new FileReader();
    reader.onload   = () => resolve(reader.result);
    reader.onerror  = () => reject(new Error('Failed to read image blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Attempt to load an image URL (returns true if it loads, false on error).
 * Useful for checking if a previously generated URL is still valid.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export function checkImageUrl(url) {
  return new Promise(resolve => {
    const img   = new Image();
    img.onload  = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src     = url;
  });
}
