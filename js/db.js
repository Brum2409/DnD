/**
 * db.js — Single source of truth for all data operations.
 *
 * After Vercel migration: data is stored server-side in Postgres (per user).
 * An in-memory cache is populated once on page load via init().
 * All read operations are synchronous (from cache).
 * All write operations update the cache immediately, then sync to the server async.
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

// ── In-memory cache ────────────────────────────────────────────

const cache = {
  characters: [],
  items: [],
  stories: [],
  loaded: false,
};

// ── Initialization ─────────────────────────────────────────────

/**
 * Load all user data from the server into the in-memory cache.
 * Idempotent — safe to call multiple times (only fetches once).
 * Must be awaited before any read/write operations.
 * Called automatically by auth.js initPage().
 *
 * @returns {Promise<void>}
 */
export async function init() {
  if (cache.loaded) return;
  const resp = await fetch('/api/data', { credentials: 'include' });
  if (!resp.ok) throw new Error('Failed to load user data from server');
  const data = await resp.json();
  cache.characters = Array.isArray(data.characters) ? data.characters : [];
  cache.items      = Array.isArray(data.items)      ? data.items      : [];
  cache.stories    = Array.isArray(data.stories)    ? data.stories    : [];
  cache.loaded = true;
}

// ── Internal API helpers ───────────────────────────────────────

function apiPut(path, body) {
  fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(err => console.error(`[db] PUT ${path} failed:`, err));
}

function apiDelete(path) {
  fetch(path, {
    method: 'DELETE',
    credentials: 'include',
  }).catch(err => console.error(`[db] DELETE ${path} failed:`, err));
}

// ── Characters ────────────────────────────────────────────────

/**
 * @returns {Character[]}
 */
export function getAllCharacters() {
  return [...cache.characters];
}

/**
 * @param {string} id
 * @returns {Character|null}
 */
export function getCharacter(id) {
  return cache.characters.find(c => c.id === id) || null;
}

/**
 * Upsert a character (insert or update by id).
 * Updates cache immediately; syncs to server async.
 * @param {Character} char
 */
export function saveCharacter(char) {
  char.updatedAt = Date.now();
  const idx = cache.characters.findIndex(c => c.id === char.id);
  if (idx >= 0) {
    cache.characters[idx] = char;
  } else {
    cache.characters.push(char);
  }
  apiPut(`/api/characters/${char.id}`, char);
}

/**
 * @param {string} id
 */
export function deleteCharacter(id) {
  cache.characters = cache.characters.filter(c => c.id !== id);
  apiDelete(`/api/characters/${id}`);
}

// ── Items ─────────────────────────────────────────────────────

/**
 * @returns {Item[]}
 */
export function getAllItems() {
  return [...cache.items];
}

/**
 * @param {string} id
 * @returns {Item|null}
 */
export function getItem(id) {
  return cache.items.find(i => i.id === id) || null;
}

/**
 * Upsert an item.
 * @param {Item} item
 */
export function saveItem(item) {
  const idx = cache.items.findIndex(i => i.id === item.id);
  if (idx >= 0) {
    cache.items[idx] = item;
  } else {
    cache.items.push(item);
  }
  apiPut(`/api/items/${item.id}`, item);
}

/**
 * @param {string} id
 */
export function deleteItem(id) {
  cache.items = cache.items.filter(i => i.id !== id);
  apiDelete(`/api/items/${id}`);
}

// ── Stories ───────────────────────────────────────────────────

/**
 * @returns {Story[]}
 */
export function getAllStories() {
  return [...cache.stories];
}

/**
 * @param {string} id
 * @returns {Story|null}
 */
export function getStory(id) {
  return cache.stories.find(s => s.id === id) || null;
}

/**
 * Upsert a story.
 * @param {Story} story
 */
export function saveStory(story) {
  story.updatedAt = Date.now();
  const idx = cache.stories.findIndex(s => s.id === story.id);
  if (idx >= 0) {
    cache.stories[idx] = story;
  } else {
    cache.stories.push(story);
  }
  apiPut(`/api/stories/${story.id}`, story);
}

/**
 * @param {string} id
 */
export function deleteStory(id) {
  cache.stories = cache.stories.filter(s => s.id !== id);
  apiDelete(`/api/stories/${id}`);
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
  return cache.stories.find(s => s.status === 'active') || null;
}

/**
 * Clears all icon base64 data from items to reduce storage size.
 * Syncs the updated items to the server.
 */
export function clearIconCache() {
  cache.items = cache.items.map(item => ({ ...item, iconBase64: '' }));
  // Sync all items to server
  for (const item of cache.items) {
    apiPut(`/api/items/${item.id}`, item);
  }
}

/**
 * Returns storage usage summary based on in-memory cache sizes.
 * @returns {{ characters: number, items: number, stories: number, total: number }}
 */
export function getStorageStats() {
  const measure = obj => new Blob([JSON.stringify(obj)]).size;
  const c = measure(cache.characters);
  const i = measure(cache.items);
  const s = measure(cache.stories);
  return { characters: c, items: i, stories: s, total: c + i + s };
}

/**
 * Export all data as a JSON object (reads from cache).
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
 * Syncs all imported entities to the server.
 * @param {Object} data
 */
export function importData(data) {
  if (data.characters) {
    for (const c of data.characters) {
      if (!cache.characters.find(x => x.id === c.id)) {
        cache.characters.push(c);
        apiPut(`/api/characters/${c.id}`, c);
      }
    }
  }
  if (data.items) {
    for (const i of data.items) {
      if (!cache.items.find(x => x.id === i.id)) {
        cache.items.push(i);
        apiPut(`/api/items/${i.id}`, i);
      }
    }
  }
  if (data.stories) {
    for (const s of data.stories) {
      if (!cache.stories.find(x => x.id === s.id)) {
        cache.stories.push(s);
        apiPut(`/api/stories/${s.id}`, s);
      }
    }
  }
}

/**
 * Wipe all user data from cache and the server.
 */
export function clearAllData() {
  // Delete all entities from server
  for (const c of cache.characters) apiDelete(`/api/characters/${c.id}`);
  for (const i of cache.items)      apiDelete(`/api/items/${i.id}`);
  for (const s of cache.stories)    apiDelete(`/api/stories/${s.id}`);

  // Clear cache
  cache.characters = [];
  cache.items      = [];
  cache.stories    = [];
}
