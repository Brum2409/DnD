/**
 * utils.js — Shared helper functions
 */

// ── UUID ──────────────────────────────────────────────────────

/**
 * Generate a UUID v4. Uses crypto.randomUUID() with a fallback.
 * @returns {string}
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Dice Roller ───────────────────────────────────────────────

/**
 * Parse and roll a dice notation string like "2d6+3", "1d20", "4d6-1".
 * @param {string} notation  - e.g. "2d6+3"
 * @returns {{ total: number, rolls: number[], modifier: number, breakdown: string }}
 */
export function rollDice(notation) {
  // Normalise
  const cleaned = notation.trim().toLowerCase().replace(/\s/g, '');

  // Match pattern: [count]d[sides][+/-modifier]
  const match = cleaned.match(/^(\d+)?d(\d+)([+-]\d+)?$/);
  if (!match) {
    throw new Error(`Invalid dice notation: "${notation}"`);
  }

  const count    = parseInt(match[1] || '1', 10);
  const sides    = parseInt(match[2], 10);
  const modifier = parseInt(match[3] || '0', 10);

  if (sides < 1) throw new Error('Dice must have at least 1 side');
  if (count < 1) throw new Error('Must roll at least 1 die');

  const rolls = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }

  const sum   = rolls.reduce((a, b) => a + b, 0);
  const total = sum + modifier;

  const breakdown = `[${rolls.join(', ')}]${modifier !== 0 ? ` ${modifier > 0 ? '+' : ''}${modifier}` : ''} = ${total}`;

  return { total, rolls, modifier, breakdown };
}

/**
 * Roll 4d6 and drop the lowest (standard DND ability score method).
 * @returns {{ total: number, rolls: number[], dropped: number }}
 */
export function rollAbilityScore() {
  const rolls = [1, 2, 3, 4].map(() => Math.floor(Math.random() * 6) + 1);
  rolls.sort((a, b) => b - a);
  const dropped = rolls[3];
  const total   = rolls[0] + rolls[1] + rolls[2];
  return { total, rolls, dropped };
}

// ── DND Modifiers ─────────────────────────────────────────────

/**
 * Calculate the DND 5e ability modifier for a given score.
 * Formula: floor((score - 10) / 2)
 * @param {number} score
 * @returns {number}
 */
export function getModifier(score) {
  return Math.floor((score - 10) / 2);
}

/**
 * Format a modifier as a string with sign, e.g. "+2", "-1", "+0".
 * @param {number} score
 * @returns {string}
 */
export function formatModifier(score) {
  const mod = getModifier(score);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

/**
 * Get the proficiency bonus for a given character level (DND 5e).
 * @param {number} level
 * @returns {number}
 */
export function getProficiencyBonus(level) {
  return Math.ceil(level / 4) + 1;
}

/**
 * Calculate XP needed to reach the next level (DND 5e thresholds).
 * @param {number} level  - current level (1–19)
 * @returns {number}
 */
export function xpForLevel(level) {
  const thresholds = [0, 300, 900, 2700, 6500, 14000, 23000, 34000,
                      48000, 64000, 85000, 100000, 120000, 140000,
                      165000, 195000, 225000, 265000, 305000, 355000];
  return thresholds[Math.min(level, 19)] ?? 355000;
}

/**
 * Calculate max HP for a character at level 1 based on class and CON modifier.
 * @param {string} characterClass
 * @param {number} constitutionScore
 * @returns {number}
 */
export function calculateBaseHP(characterClass, constitutionScore) {
  const hitDice = {
    fighter: 10, paladin: 10, ranger: 10, barbarian: 12,
    wizard: 6,  sorcerer: 6,
    rogue: 8, bard: 8, cleric: 8, druid: 8, monk: 8, warlock: 8,
  };
  const cls     = characterClass.toLowerCase();
  const hitDie  = hitDice[cls] ?? 8;
  const conMod  = getModifier(constitutionScore);
  return Math.max(1, hitDie + conMod);
}

// ── Date formatting ───────────────────────────────────────────

/**
 * Format a Unix timestamp (ms) as a human-readable date string.
 * @param {number} ts
 * @returns {string}
 */
export function formatDate(ts) {
  if (!ts) return 'Unknown';
  const date = new Date(ts);
  return date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

/**
 * Format a Unix timestamp as a relative time string (e.g., "2 days ago").
 * @param {number} ts
 * @returns {string}
 */
export function timeAgo(ts) {
  if (!ts) return '';
  const diff   = Date.now() - ts;
  const mins   = Math.floor(diff / 60000);
  const hours  = Math.floor(diff / 3600000);
  const days   = Math.floor(diff / 86400000);

  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days < 7)    return `${days}d ago`;
  return formatDate(ts);
}

// ── String helpers ────────────────────────────────────────────

/**
 * Capitalise the first letter of a string.
 * @param {string} str
 * @returns {string}
 */
export function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Truncate a string to maxLen characters, appending "…" if truncated.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen = 100) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(str).replace(/[&<>"']/g, m => map[m]);
}

// ── UI utilities ──────────────────────────────────────────────

/**
 * Show a loading overlay with a contextual message.
 * @param {string} [message]
 */
export function showLoading(message = 'Loading…') {
  let overlay = document.getElementById('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
      <div class="loading-rune">✦</div>
      <div class="loading-message" id="loading-message"></div>
    `;
    document.body.appendChild(overlay);
  }
  overlay.querySelector('#loading-message').textContent = message;
  overlay.classList.remove('hidden');
}

/**
 * Hide the loading overlay.
 */
export function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');
}

/**
 * Display a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'} [type]
 * @param {number} [duration]  ms before auto-dismiss (0 = never)
 */
export function showToast(message, type = 'info', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = { success: '✓', error: '✕', info: '⚡' };
  const toast  = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] ?? '•'}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 350);
    }, duration);
  }

  return toast;
}

// ── Debounce ──────────────────────────────────────────────────

/**
 * Returns a debounced version of fn that fires after `wait` ms of inactivity.
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// ── Standard DND arrays ───────────────────────────────────────

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

export const RACES = [
  { value: 'human',      label: 'Human',      desc: 'Versatile and ambitious, humans excel in any path.' },
  { value: 'elf',        label: 'Elf',        desc: 'Ancient and graceful, with keen senses and long memory.' },
  { value: 'dwarf',      label: 'Dwarf',      desc: 'Stalwart and tough, masters of craft and battle.' },
  { value: 'half-orc',   label: 'Half-Orc',   desc: 'Fierce and tenacious, driven by primal strength.' },
  { value: 'halfling',   label: 'Halfling',   desc: 'Small but lucky, natural wanderers with nimble hands.' },
  { value: 'gnome',      label: 'Gnome',      desc: 'Inventive and curious, brimming with arcane curiosity.' },
  { value: 'tiefling',   label: 'Tiefling',   desc: 'Touched by infernal power, bearing the mark of darkness.' },
  { value: 'dragonborn', label: 'Dragonborn', desc: 'Proud descendants of dragons, breathing elemental fury.' },
];

export const CLASSES = [
  { value: 'fighter', label: 'Fighter', desc: 'Master of weapons and armor, unmatched in direct combat.', hitDie: 10 },
  { value: 'wizard',  label: 'Wizard',  desc: 'Scholar of the arcane arts, wielding devastating spells.', hitDie: 6 },
  { value: 'rogue',   label: 'Rogue',   desc: 'Shadow expert in stealth, traps, and precision strikes.', hitDie: 8 },
  { value: 'cleric',  label: 'Cleric',  desc: 'Divine champion wielding holy power to heal and destroy.', hitDie: 8 },
  { value: 'ranger',  label: 'Ranger',  desc: 'Hunter of the wilds, skilled in tracking and survival.', hitDie: 10 },
  { value: 'paladin', label: 'Paladin', desc: 'Holy warrior bound by a sacred oath, mixing might and magic.', hitDie: 10 },
  { value: 'bard',    label: 'Bard',    desc: 'Charismatic performer weaving magic through music and words.', hitDie: 8 },
  { value: 'druid',   label: 'Druid',   desc: 'Guardian of nature who shapeshifts and commands the elements.', hitDie: 8 },
  { value: 'warlock', label: 'Warlock', desc: 'Seeker of forbidden knowledge, powered by a dark patron.', hitDie: 8 },
];

export const SKILLS = [
  { name: 'Acrobatics',      ability: 'dexterity' },
  { name: 'Animal Handling', ability: 'wisdom' },
  { name: 'Arcana',          ability: 'intelligence' },
  { name: 'Athletics',       ability: 'strength' },
  { name: 'Deception',       ability: 'charisma' },
  { name: 'History',         ability: 'intelligence' },
  { name: 'Insight',         ability: 'wisdom' },
  { name: 'Intimidation',    ability: 'charisma' },
  { name: 'Investigation',   ability: 'intelligence' },
  { name: 'Medicine',        ability: 'wisdom' },
  { name: 'Nature',          ability: 'intelligence' },
  { name: 'Perception',      ability: 'wisdom' },
  { name: 'Performance',     ability: 'charisma' },
  { name: 'Persuasion',      ability: 'charisma' },
  { name: 'Religion',        ability: 'intelligence' },
  { name: 'Sleight of Hand', ability: 'dexterity' },
  { name: 'Stealth',         ability: 'dexterity' },
  { name: 'Survival',        ability: 'wisdom' },
];

export const CONDITIONS = [
  'Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened',
  'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified',
  'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
];
