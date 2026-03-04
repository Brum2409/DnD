/**
 * api-image.js — Pollinations.ai image generation wrapper.
 *
 * Pollinations.ai is completely free — no API key required.
 * Images are served directly as URLs with the prompt encoded in the path.
 *
 * Usage:
 *   import { generateImage, generateIconBase64, buildIconPrompt } from './api-image.js';
 *
 *   const url  = await generateImage('A dark fantasy forest at night', 1200, 512);
 *   const b64  = await generateIconBase64('Flaming sword, legendary weapon');
 */

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

// ── Core image generation ─────────────────────────────────────

/**
 * Generate an image URL via Pollinations.ai.
 * The image is served directly at the returned URL — no extra fetch needed
 * unless you want to convert it to base64.
 *
 * @param {string} prompt
 * @param {number} [width]
 * @param {number} [height]
 * @param {number} [seed]   - use Date.now() for variety, fixed value for reproducibility
 * @returns {Promise<string>}  the image URL
 */
export async function generateImage(prompt, width = 512, height = 512, seed = null) {
  const encoded = encodeURIComponent(prompt);
  const s       = seed ?? Date.now();
  const url     = `${POLLINATIONS_BASE}/${encoded}?width=${width}&height=${height}&seed=${s}&model=flux`;
  return url;
}

/**
 * Generate a small icon and return it as a base64 data URL.
 * The result is suitable for caching inside an Item's `iconBase64` field.
 *
 * @param {string} prompt
 * @param {number} [size]   - icon dimensions (square), default 128
 * @returns {Promise<string>}  base64 data URL ("data:image/jpeg;base64,...")
 */
export async function generateIconBase64(prompt, size = 128) {
  const fullPrompt = `${prompt}, game item icon, fantasy art, dark background, detailed illustration`;
  const url        = await generateImage(fullPrompt, size, size);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`);

  const blob = await response.blob();
  return blobToBase64(blob);
}

/**
 * Generate a scene image (wide format) for the game screen.
 *
 * @param {string} prompt
 * @returns {Promise<string>}  image URL
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
 * Generate a character portrait URL.
 *
 * @param {{ name: string, race: string, class: string, backstory: string }} character
 * @returns {Promise<string>}  image URL
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
    const img  = new Image();
    img.onload  = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src     = url;
  });
}
