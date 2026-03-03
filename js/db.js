/**
 * db.js — Single source of truth for all localStorage read/write operations.
 *
 * Data models (JSDoc types):
 *
 * @typedef {Object} ItemInstance
 * @property {string} itemId
 * @property {number} quantity
 *
 * @typedef {Object} CharacterStats
 * @property {number} hp
 * @property {number} maxHp
 * @property {number} ac
 * @property {number} strength
 * @property {number} dexterity
 * @property {number} constitution
 * @property {number} intelligence
 * @property {number} wisdom
 * @property {number} charisma
 *
 * @typedef {Object} Character
 * @property {string} id
 * @property {string} name
 * @property {string} race
 * @property {string} class
 * @property {number} level
 * @property {string} backstory
 * @property {string} portrait        - base64 or URL
 * @property {CharacterStats} stats
 * @property {string[]} skills
 * @property {ItemInstance[]} inventory
 * @property {string[]} conditions
 * @property {number} gold
 * @property {number} xp
 * @property {string[]} adventureLog
 * @property {number} createdAt
 * @property {number} updatedAt
 *
 * @typedef {Object} ItemStats
 * @property {string} [damage]       - e.g. "1d6+2"
 * @property {number} [armorClass]
 * @property {string} [effect]
 * @property {number} [value]        - gold value
 *
 * @typedef {Object} Item
 * @property {string} id
 * @property {string} name
 * @property {'weapon'|'armor'|'potion'|'misc'|'quest'} type
 * @property {string} description
 * @property {string} lore
 * @property {string} iconBase64
 * @property {string} iconPrompt
 * @property {ItemStats} stats
 * @property {'common'|'uncommon'|'rare'|'legendary'} rarity
 * @property {number} createdAt
 *
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {number} timestamp
 * @property {Object[]} [toolCalls]
 *
 * @typedef {Object} Scene
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} imagePrompt
 * @property {string} imageUrl
 * @property {string[]} npcs
 * @property {string[]} loot         - item IDs
 * @property {number|null} completedAt
 *
 * @typedef {Object} Story
 * @property {string} id
 * @property {string} title
 * @property {string} setting
 * @property {string} premise
 * @property {string[]} characterIds
 * @property {Scene[]} scenes
 * @property {number} currentSceneIndex
 * @property {Message[]} dmChatHistory
 * @property {'active'|'completed'|'paused'} status
 * @property {string} sceneImageUrl
 * @property {number} createdAt
 * @property {number} updatedAt
 */

// ── Storage keys ──────────────────────────────────────────────
const KEYS = {
  characters: 'dnd_characters',
  items:      'dnd_items',
  stories:    'dnd_stories',
};

// ── Internal helpers ──────────────────────────────────────────

function readAll(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    console.error(`[db] Failed to read "${key}" from localStorage`);
    return [];
  }
}

function writeAll(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      console.error('[db] localStorage quota exceeded');
      throw new Error('Storage full. Try clearing icon caches in Settings.');
    }
    throw e;
  }
}

function findById(arr, id) {
  return arr.find(item => item.id === id) || null;
}

// ── Characters ────────────────────────────────────────────────

/**
 * @returns {Character[]}
 */
export function getAllCharacters() {
  return readAll(KEYS.characters);
}

/**
 * @param {string} id
 * @returns {Character|null}
 */
export function getCharacter(id) {
  return findById(getAllCharacters(), id);
}

/**
 * Upserts a character (insert or update by id).
 * @param {Character} char
 */
export function saveCharacter(char) {
  const all = getAllCharacters();
  const idx = all.findIndex(c => c.id === char.id);
  char.updatedAt = Date.now();
  if (idx >= 0) {
    all[idx] = char;
  } else {
    all.push(char);
  }
  writeAll(KEYS.characters, all);
}

/**
 * @param {string} id
 */
export function deleteCharacter(id) {
  const filtered = getAllCharacters().filter(c => c.id !== id);
  writeAll(KEYS.characters, filtered);
}

// ── Items ─────────────────────────────────────────────────────

/**
 * @returns {Item[]}
 */
export function getAllItems() {
  return readAll(KEYS.items);
}

/**
 * @param {string} id
 * @returns {Item|null}
 */
export function getItem(id) {
  return findById(getAllItems(), id);
}

/**
 * @param {Item} item
 */
export function saveItem(item) {
  const all = getAllItems();
  const idx = all.findIndex(i => i.id === item.id);
  if (idx >= 0) {
    all[idx] = item;
  } else {
    all.push(item);
  }
  writeAll(KEYS.items, all);
}

/**
 * @param {string} id
 */
export function deleteItem(id) {
  const filtered = getAllItems().filter(i => i.id !== id);
  writeAll(KEYS.items, filtered);
}

// ── Stories ───────────────────────────────────────────────────

/**
 * @returns {Story[]}
 */
export function getAllStories() {
  return readAll(KEYS.stories);
}

/**
 * @param {string} id
 * @returns {Story|null}
 */
export function getStory(id) {
  return findById(getAllStories(), id);
}

/**
 * @param {Story} story
 */
export function saveStory(story) {
  const all = getAllStories();
  const idx = all.findIndex(s => s.id === story.id);
  story.updatedAt = Date.now();
  if (idx >= 0) {
    all[idx] = story;
  } else {
    all.push(story);
  }
  writeAll(KEYS.stories, all);
}

/**
 * @param {string} id
 */
export function deleteStory(id) {
  const filtered = getAllStories().filter(s => s.id !== id);
  writeAll(KEYS.stories, filtered);
}

// ── Convenience operations ────────────────────────────────────

/**
 * Add or subtract HP for a character, clamped to [0, maxHp].
 * @param {string} charId
 * @param {number} delta  - positive = heal, negative = damage
 * @returns {Character|null}
 */
export function updateCharacterHP(charId, delta) {
  const char = getCharacter(charId);
  if (!char) return null;
  char.stats.hp = Math.max(0, Math.min(char.stats.maxHp, char.stats.hp + delta));
  saveCharacter(char);
  return char;
}

/**
 * Add or remove an item from a character's inventory.
 * @param {string} charId
 * @param {string} itemId
 * @param {'add'|'remove'} action
 */
export function updateCharacterInventory(charId, itemId, action) {
  const char = getCharacter(charId);
  if (!char) return;

  if (action === 'add') {
    const existing = char.inventory.find(i => i.itemId === itemId);
    if (existing) {
      existing.quantity += 1;
    } else {
      char.inventory.push({ itemId, quantity: 1 });
    }
  } else if (action === 'remove') {
    const existing = char.inventory.find(i => i.itemId === itemId);
    if (existing) {
      existing.quantity -= 1;
      if (existing.quantity <= 0) {
        char.inventory = char.inventory.filter(i => i.itemId !== itemId);
      }
    }
  }

  saveCharacter(char);
}

/**
 * Append an entry to a character's adventure log.
 * @param {string} charId
 * @param {string} entry
 */
export function addToAdventureLog(charId, entry) {
  const char = getCharacter(charId);
  if (!char) return;
  const timestamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  char.adventureLog.push(`[${timestamp}] ${entry}`);
  saveCharacter(char);
}

/**
 * Returns the first story with status 'active', or null.
 * @returns {Story|null}
 */
export function getActiveStory() {
  return getAllStories().find(s => s.status === 'active') || null;
}

/**
 * Clears all icon base64 data from items to free localStorage space.
 * Call when storage is approaching quota.
 */
export function clearIconCache() {
  const items = getAllItems().map(item => ({ ...item, iconBase64: '' }));
  writeAll(KEYS.items, items);
}

/**
 * Returns an approximate storage usage summary.
 * @returns {{ characters: number, items: number, stories: number, total: number }}
 */
export function getStorageStats() {
  const measure = key => {
    const val = localStorage.getItem(key) || '';
    return new Blob([val]).size;
  };
  const c = measure(KEYS.characters);
  const i = measure(KEYS.items);
  const s = measure(KEYS.stories);
  return { characters: c, items: i, stories: s, total: c + i + s };
}

/**
 * Export all data as a JSON object.
 * @returns {Object}
 */
export function exportAllData() {
  return {
    characters: getAllCharacters(),
    items: getAllItems(),
    stories: getAllStories(),
    exportedAt: Date.now(),
    version: 1,
  };
}

/**
 * Import data from an export object, merging by id (no duplicates).
 * @param {Object} data
 */
export function importData(data) {
  if (data.characters) {
    const existing = getAllCharacters();
    const merged = [...existing];
    for (const c of data.characters) {
      if (!merged.find(x => x.id === c.id)) merged.push(c);
    }
    writeAll(KEYS.characters, merged);
  }
  if (data.items) {
    const existing = getAllItems();
    const merged = [...existing];
    for (const i of data.items) {
      if (!merged.find(x => x.id === i.id)) merged.push(i);
    }
    writeAll(KEYS.items, merged);
  }
  if (data.stories) {
    const existing = getAllStories();
    const merged = [...existing];
    for (const s of data.stories) {
      if (!merged.find(x => x.id === s.id)) merged.push(s);
    }
    writeAll(KEYS.stories, merged);
  }
}

/**
 * Wipe all DND data from localStorage. Use with caution!
 */
export function clearAllData() {
  localStorage.removeItem(KEYS.characters);
  localStorage.removeItem(KEYS.items);
  localStorage.removeItem(KEYS.stories);
}
