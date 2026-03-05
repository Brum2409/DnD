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

// ── DnD 5e Spell Slot Tables ──────────────────────────────────

/**
 * Official DnD 5e spell slot tables indexed by [charLevel-1][spellLevel-1].
 * Each inner array has 9 entries representing L1–L9 slot counts.
 * @private
 */
const _FULL_CASTER_SLOTS = [
  [2,0,0,0,0,0,0,0,0], // level 1
  [3,0,0,0,0,0,0,0,0], // level 2
  [4,2,0,0,0,0,0,0,0], // level 3
  [4,3,0,0,0,0,0,0,0], // level 4
  [4,3,2,0,0,0,0,0,0], // level 5
  [4,3,3,0,0,0,0,0,0], // level 6
  [4,3,3,1,0,0,0,0,0], // level 7
  [4,3,3,2,0,0,0,0,0], // level 8
  [4,3,3,3,1,0,0,0,0], // level 9
  [4,3,3,3,2,0,0,0,0], // level 10
  [4,3,3,3,2,1,0,0,0], // level 11
  [4,3,3,3,2,1,0,0,0], // level 12
  [4,3,3,3,2,1,1,0,0], // level 13
  [4,3,3,3,2,1,1,0,0], // level 14
  [4,3,3,3,2,1,1,1,0], // level 15
  [4,3,3,3,2,1,1,1,0], // level 16
  [4,3,3,3,2,1,1,1,1], // level 17
  [4,3,3,3,3,1,1,1,1], // level 18
  [4,3,3,3,3,2,1,1,1], // level 19
  [4,3,3,3,3,2,2,1,1], // level 20
];

const _HALF_CASTER_SLOTS = [
  [0,0,0,0,0], // level 1 — no slots yet
  [2,0,0,0,0], // level 2
  [3,0,0,0,0], // level 3
  [3,0,0,0,0], // level 4
  [4,2,0,0,0], // level 5
  [4,2,0,0,0], // level 6
  [4,3,0,0,0], // level 7
  [4,3,0,0,0], // level 8
  [4,3,2,0,0], // level 9
  [4,3,2,0,0], // level 10
  [4,3,3,0,0], // level 11
  [4,3,3,0,0], // level 12
  [4,3,3,1,0], // level 13
  [4,3,3,1,0], // level 14
  [4,3,3,2,0], // level 15
  [4,3,3,2,0], // level 16
  [4,3,3,3,1], // level 17
  [4,3,3,3,1], // level 18
  [4,3,3,3,2], // level 19
  [4,3,3,3,2], // level 20
];

// Warlock Pact Magic: [slots, slotLevel] per character level
const _WARLOCK_PACT = [
  [1,1],[2,1],[2,2],[2,2],[2,3],[2,3],[2,4],[2,4],
  [2,5],[2,5],[3,5],[3,5],[3,5],[3,5],[3,5],[3,5],
  [4,5],[4,5],[4,5],[4,5],
];

/**
 * Get the base spell slots for a class at a given character level.
 *
 * Returns an object `{ [slotLevel]: { total: N, used: 0 } }` for all
 * levels where total > 0.  Returns null for non-spellcasting classes.
 *
 * For Warlocks the Pact Magic slots appear at a single level (e.g. all
 * L5 slots at higher levels); they recover on a short rest.
 *
 * @param {string} className  - case-insensitive class name
 * @param {number} charLevel  - 1–20
 * @returns {Object.<number,{total:number,used:number}>|null}
 */
export function getBaseSpellSlots(className, charLevel) {
  const cls = (className || '').toLowerCase().trim();
  const idx = Math.max(0, Math.min(19, charLevel - 1));

  const fullCasters  = ['wizard','sorcerer','druid','cleric','bard'];
  const halfCasters  = ['paladin','ranger'];

  if (fullCasters.includes(cls)) {
    const row = _FULL_CASTER_SLOTS[idx];
    const result = {};
    row.forEach((n, i) => { if (n > 0) result[i + 1] = { total: n, used: 0 }; });
    return Object.keys(result).length ? result : null;
  }

  if (halfCasters.includes(cls)) {
    const row = _HALF_CASTER_SLOTS[idx];
    const result = {};
    row.forEach((n, i) => { if (n > 0) result[i + 1] = { total: n, used: 0 }; });
    return Object.keys(result).length ? result : null;
  }

  if (cls === 'warlock') {
    const [slots, level] = _WARLOCK_PACT[idx];
    return { [level]: { total: slots, used: 0, pactMagic: true } };
  }

  // Non-casters (fighter, rogue, barbarian, monk, etc.) — no spell slots
  return null;
}

export const SPELL_SCHOOLS = [
  'Abjuration', 'Conjuration', 'Divination', 'Enchantment',
  'Evocation', 'Illusion', 'Necromancy', 'Transmutation',
];

export const CONDITIONS = [
  'Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened',
  'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified',
  'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
];

// ── Starting Spells by Class ──────────────────────────────────

/**
 * Static starting spells for each spellcasting class.
 * Each entry has all Spell fields except id, iconBase64, iconPrompt, createdAt
 * (those are filled in at character-creation time).
 */
export const CLASS_STARTING_SPELLS = {
  wizard: [
    { name: 'Fire Bolt',        level: 0, school: 'Evocation',     castingTime: '1 action',   range: '120 ft', components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d10', damageType: 'fire',   savingThrow: '', description: 'You hurl a mote of fire at a creature or object within range. On a hit, the target takes 1d10 fire damage.' },
    { name: 'Prestidigitation', level: 0, school: 'Transmutation', castingTime: '1 action',   range: '10 ft',  components: 'V, S',    duration: '1 hour',        concentration: false, ritual: false, damage: '',     damageType: '',       savingThrow: '', description: 'A minor magical trick that novice spellcasters use for practice.' },
    { name: 'Mage Hand',        level: 0, school: 'Conjuration',   castingTime: '1 action',   range: '30 ft',  components: 'V, S',    duration: '1 minute',      concentration: false, ritual: false, damage: '',     damageType: '',       savingThrow: '', description: 'A spectral, floating hand appears at a point you choose. It can manipulate objects, open unlocked doors and containers, stow or retrieve items, or pour out vials.' },
    { name: 'Magic Missile',    level: 1, school: 'Evocation',     castingTime: '1 action',   range: '120 ft', components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d4+1', damageType: 'force', savingThrow: '', description: 'You create three glowing darts of magical force. Each dart automatically hits a target and deals 1d4+1 force damage.' },
    { name: 'Shield',           level: 1, school: 'Abjuration',    castingTime: '1 reaction', range: 'Self',   components: 'V, S',    duration: '1 round',       concentration: false, ritual: false, damage: '',     damageType: '',       savingThrow: '', description: 'An invisible barrier of magical force appears and protects you. Until the start of your next turn, you gain +5 AC, including against the triggering attack, and take no damage from magic missile.' },
    { name: 'Burning Hands',    level: 1, school: 'Evocation',     castingTime: '1 action',   range: 'Self (15-ft cone)', components: 'V, S', duration: 'Instantaneous', concentration: false, ritual: false, damage: '3d6', damageType: 'fire', savingThrow: 'DEX', description: 'A thin sheet of flames shoots forth from your hands. Each creature in a 15-foot cone must make a Dexterity saving throw, taking 3d6 fire damage on a failed save, or half on a success.' },
  ],
  sorcerer: [
    { name: 'Fire Bolt',        level: 0, school: 'Evocation',     castingTime: '1 action',   range: '120 ft', components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d10', damageType: 'fire',    savingThrow: '', description: 'You hurl a mote of fire at a creature or object within range. On a hit, the target takes 1d10 fire damage.' },
    { name: 'Ray of Frost',     level: 0, school: 'Evocation',     castingTime: '1 action',   range: '60 ft',  components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d8',  damageType: 'cold',    savingThrow: '', description: 'A frigid beam of blue-white light streaks toward a creature. On a hit, it takes 1d8 cold damage and its speed is reduced by 10 ft until the start of your next turn.' },
    { name: 'Prestidigitation', level: 0, school: 'Transmutation', castingTime: '1 action',   range: '10 ft',  components: 'V, S',    duration: '1 hour',        concentration: false, ritual: false, damage: '',     damageType: '',        savingThrow: '', description: 'A minor magical trick that novice spellcasters use for practice.' },
    { name: 'Magic Missile',    level: 1, school: 'Evocation',     castingTime: '1 action',   range: '120 ft', components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d4+1', damageType: 'force',  savingThrow: '', description: 'You create three glowing darts of magical force. Each dart automatically hits a target and deals 1d4+1 force damage.' },
    { name: 'Thunderwave',      level: 1, school: 'Evocation',     castingTime: '1 action',   range: 'Self (15-ft cube)', components: 'V, S', duration: 'Instantaneous', concentration: false, ritual: false, damage: '2d8', damageType: 'thunder', savingThrow: 'CON', description: 'A wave of thunderous force sweeps out from you. Each creature in a 15-foot cube must make a CON save or take 2d8 thunder damage and be pushed 10 feet away. On a save, half damage.' },
  ],
  cleric: [
    { name: 'Sacred Flame',     level: 0, school: 'Evocation',     castingTime: '1 action',   range: '60 ft',  components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d8',  damageType: 'radiant', savingThrow: 'DEX', description: 'Flame-like radiance descends on a creature you can see. The target must succeed on a DEX save or take 1d8 radiant damage. The target gains no benefit from cover.' },
    { name: 'Guidance',         level: 0, school: 'Divination',    castingTime: '1 action',   range: 'Touch',  components: 'V, S',    duration: '1 minute',      concentration: true,  ritual: false, damage: '',     damageType: '',        savingThrow: '', description: 'You touch one willing creature. Once before the spell ends, the target can roll a d4 and add the number rolled to one ability check of its choice.' },
    { name: 'Thaumaturgy',      level: 0, school: 'Transmutation', castingTime: '1 action',   range: '30 ft',  components: 'V',       duration: '1 minute',      concentration: false, ritual: false, damage: '',     damageType: '',        savingThrow: '', description: 'You manifest a minor wonder, a sign of supernatural power. You create one of several magical effects.' },
    { name: 'Cure Wounds',      level: 1, school: 'Evocation',     castingTime: '1 action',   range: 'Touch',  components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d8',  damageType: 'healing', savingThrow: '', description: 'A creature you touch regains 1d8 + your spellcasting modifier hit points. This spell has no effect on undead or constructs.' },
    { name: 'Guiding Bolt',     level: 1, school: 'Evocation',     castingTime: '1 action',   range: '120 ft', components: 'V, S',    duration: '1 round',       concentration: false, ritual: false, damage: '4d6',  damageType: 'radiant', savingThrow: '', description: 'A flash of light streaks toward a creature of your choice. On a hit, the target takes 4d6 radiant damage, and the next attack roll against it has advantage.' },
  ],
  druid: [
    { name: 'Druidcraft',       level: 0, school: 'Transmutation', castingTime: '1 action',   range: '30 ft',  components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '',    damageType: '',         savingThrow: '', description: 'You create minor effects that mimic nature: predict weather, make flowers bloom, light or snuff a flame, or produce earthy scents.' },
    { name: 'Produce Flame',    level: 0, school: 'Conjuration',   castingTime: '1 action',   range: 'Self',   components: 'V, S',    duration: '10 minutes',    concentration: false, ritual: false, damage: '1d8', damageType: 'fire',      savingThrow: '', description: 'A flickering flame appears in your hand. It sheds bright light 10 ft and dim light 20 ft. You can hurl it at a creature within 30 ft as an attack, dealing 1d8 fire damage on a hit.' },
    { name: 'Cure Wounds',      level: 1, school: 'Evocation',     castingTime: '1 action',   range: 'Touch',  components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d8', damageType: 'healing',   savingThrow: '', description: 'A creature you touch regains 1d8 + your spellcasting modifier hit points. This spell has no effect on undead or constructs.' },
    { name: 'Entangle',         level: 1, school: 'Conjuration',   castingTime: '1 action',   range: '90 ft',  components: 'V, S',    duration: '1 minute',      concentration: true,  ritual: false, damage: '',    damageType: '',         savingThrow: 'STR', description: 'Grasping weeds and vines sprout from the ground in a 20-ft square. Creatures in the area must succeed on a STR save or be restrained for the duration.' },
  ],
  bard: [
    { name: 'Vicious Mockery',  level: 0, school: 'Enchantment',   castingTime: '1 action',   range: '60 ft',  components: 'V',       duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d4', damageType: 'psychic',  savingThrow: 'WIS', description: 'You unleash a string of insults at a creature. On a failed WIS save, it takes 1d4 psychic damage and has disadvantage on its next attack roll.' },
    { name: 'Prestidigitation', level: 0, school: 'Transmutation', castingTime: '1 action',   range: '10 ft',  components: 'V, S',    duration: '1 hour',        concentration: false, ritual: false, damage: '',    damageType: '',         savingThrow: '', description: 'A minor magical trick that novice spellcasters use for practice.' },
    { name: 'Healing Word',     level: 1, school: 'Evocation',     castingTime: '1 bonus action', range: '60 ft', components: 'V',  duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d4', damageType: 'healing',  savingThrow: '', description: 'A creature of your choice that you can see within range regains hit points equal to 1d4 + your spellcasting ability modifier.' },
    { name: 'Thunderwave',      level: 1, school: 'Evocation',     castingTime: '1 action',   range: 'Self (15-ft cube)', components: 'V, S', duration: 'Instantaneous', concentration: false, ritual: false, damage: '2d8', damageType: 'thunder', savingThrow: 'CON', description: 'A wave of thunderous force sweeps out from you. Each creature in a 15-foot cube must make a CON save or take 2d8 thunder damage and be pushed 10 feet. Half damage on a save.' },
    { name: 'Charm Person',     level: 1, school: 'Enchantment',   castingTime: '1 action',   range: '30 ft',  components: 'V, S',    duration: '1 hour',        concentration: false, ritual: false, damage: '',    damageType: '',         savingThrow: 'WIS', description: 'You attempt to charm a humanoid. It must succeed on a WIS save or be charmed until the spell ends or until you or your companions do something harmful to it.' },
  ],
  warlock: [
    { name: 'Eldritch Blast',   level: 0, school: 'Evocation',     castingTime: '1 action',   range: '120 ft', components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d10', damageType: 'force',   savingThrow: '', description: 'A beam of crackling energy streaks toward a creature. On a hit, the target takes 1d10 force damage.' },
    { name: 'Chill Touch',      level: 0, school: 'Necromancy',    castingTime: '1 action',   range: '120 ft', components: 'V, S',    duration: '1 round',       concentration: false, ritual: false, damage: '1d8',  damageType: 'necrotic',savingThrow: '', description: 'You create a ghostly skeletal hand. On a hit, the target takes 1d8 necrotic damage and can\'t regain hit points until the start of your next turn.' },
    { name: 'Hex',              level: 1, school: 'Enchantment',   castingTime: '1 bonus action', range: '90 ft', components: 'V, S, M', duration: '1 hour',   concentration: true,  ritual: false, damage: '1d6',  damageType: 'necrotic',savingThrow: '', description: 'You place a curse on a creature. Until the spell ends, you deal an extra 1d6 necrotic damage to the target whenever you hit it with an attack.' },
    { name: 'Armor of Agathys', level: 1, school: 'Abjuration',    castingTime: '1 action',   range: 'Self',   components: 'V, S, M', duration: '1 hour',        concentration: false, ritual: false, damage: '5',    damageType: 'cold',    savingThrow: '', description: 'A protective magical force surrounds you, granting 5 temporary HP. If a creature hits you while you have these HP, the creature takes 5 cold damage.' },
  ],
  paladin: [
    { name: 'Bless',            level: 1, school: 'Enchantment',   castingTime: '1 action',   range: '30 ft',  components: 'V, S, M', duration: '1 minute',      concentration: true,  ritual: false, damage: '',    damageType: '',         savingThrow: '', description: 'You bless up to 3 creatures of your choice. Whenever a target makes an attack roll or saving throw before the spell ends, the target can roll a d4 and add the number to the roll.' },
    { name: 'Cure Wounds',      level: 1, school: 'Evocation',     castingTime: '1 action',   range: 'Touch',  components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d8', damageType: 'healing',  savingThrow: '', description: 'A creature you touch regains 1d8 + your spellcasting modifier hit points. This spell has no effect on undead or constructs.' },
    { name: 'Wrathful Smite',   level: 1, school: 'Evocation',     castingTime: '1 bonus action', range: 'Self', components: 'V', duration: '1 minute',        concentration: true,  ritual: false, damage: '1d6', damageType: 'psychic',  savingThrow: 'WIS', description: 'The next time you hit a creature with a melee attack, your weapon erupts with divine wrath. The attack deals an extra 1d6 psychic damage, and the target must make a WIS save or be frightened.' },
  ],
  ranger: [
    { name: "Hunter's Mark",    level: 1, school: 'Divination',    castingTime: '1 bonus action', range: '90 ft', components: 'V', duration: '1 hour',           concentration: true,  ritual: false, damage: '1d6', damageType: 'extra',    savingThrow: '', description: 'You choose a creature you can see and mystically mark it as your quarry. Until the spell ends, you deal an extra 1d6 damage to the target whenever you hit it with a weapon attack.' },
    { name: 'Cure Wounds',      level: 1, school: 'Evocation',     castingTime: '1 action',   range: 'Touch',  components: 'V, S',    duration: 'Instantaneous', concentration: false, ritual: false, damage: '1d8', damageType: 'healing',  savingThrow: '', description: 'A creature you touch regains 1d8 + your spellcasting modifier hit points. This spell has no effect on undead or constructs.' },
  ],
};
