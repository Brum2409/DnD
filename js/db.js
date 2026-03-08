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
 * @typedef {Object} SpellSlotLevel
 * @property {number} total
 * @property {number} used
 * @property {boolean} [pactMagic]
 *
 * @typedef {Object} Spell
 * @property {string} id
 * @property {string} name
 * @property {number} level
 * @property {string} school
 * @property {string} castingTime
 * @property {string} range
 * @property {string} components
 * @property {string} duration
 * @property {boolean} concentration
 * @property {boolean} ritual
 * @property {string} description
 * @property {string} lore
 * @property {string} iconBase64
 * @property {string} iconPrompt
 * @property {string} [damage]
 * @property {string} [damageType]
 * @property {string} [savingThrow]
 * @property {number} createdAt
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
 * @property {boolean} [isNPC]        - true for world characters (NPCs, enemies, etc.)
 * @property {string} [npcRole]       - e.g. 'enemy', 'merchant', 'ally', 'neutral', 'boss'
 * @property {string} [personality]   - short personality description
 * @property {string} [appearance]    - physical description
 * @property {string[]} [metInStoryIds] - story IDs where this NPC has appeared
 * @property {string} [lastSceneId]   - ID of the scene where this NPC was last present
 * @property {string[]} [spells]      - spell IDs known/prepared (empty for non-casters)
 * @property {Object.<number,SpellSlotLevel>|null} [spellSlots] - keyed by slot level 1–9; null for non-casters
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
 * @typedef {Object} QuestObjective
 * @property {string} text
 * @property {boolean} done
 *
 * @typedef {Object} Quest
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} [giver]        - NPC name who gave the quest
 * @property {'active'|'completed'|'failed'} status
 * @property {QuestObjective[]} objectives
 * @property {string} [reward]       - Description of the reward
 * @property {number} createdAt
 *
 * @typedef {Object} Story
 * @property {string} id
 * @property {string} title
 * @property {string} setting
 * @property {string} premise
 * @property {string[]} characterIds
 * @property {string[]} [npcIds]      - IDs of world characters (NPCs) encountered in this story
 * @property {Scene[]} scenes
 * @property {number} currentSceneIndex
 * @property {Message[]} dmChatHistory
 * @property {'active'|'completed'|'paused'} status
 * @property {string} sceneImageUrl
 * @property {Quest[]} [quests]       - Quest journal for this story
 * @property {number} createdAt
 * @property {number} updatedAt
 */

// ── In-memory cache ────────────────────────────────────────────

const cache = {
  characters: [],
  items: [],
  stories: [],
  spells: [],
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
  cache.spells     = Array.isArray(data.spells)     ? data.spells     : [];
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

// ── NPC / World Characters ────────────────────────────────────

/**
 * Get all NPC characters encountered in a story.
 * @param {string} storyId
 * @returns {Character[]}
 */
export function getNPCsForStory(storyId) {
  const story = getStory(storyId);
  if (!story || !story.npcIds) return [];
  return story.npcIds.map(id => getCharacter(id)).filter(Boolean);
}

/**
 * Register an NPC as having appeared in a story.
 * @param {string} storyId
 * @param {string} npcId
 */
export function addNPCToStory(storyId, npcId) {
  const story = getStory(storyId);
  if (!story) return;
  if (!story.npcIds) story.npcIds = [];
  if (!story.npcIds.includes(npcId)) {
    story.npcIds.push(npcId);
    saveStory(story);
  }
}

/**
 * Find a world character by name (case-insensitive). Used when the DM
 * references an NPC by name instead of ID in the same turn they introduced it.
 * @param {string} name
 * @returns {Character|null}
 */
export function getNPCByName(name) {
  const lower = name.toLowerCase();
  return cache.characters.find(c => c.isNPC && c.name.toLowerCase() === lower) || null;
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
    spells: getAllSpells(),
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
  if (data.spells) {
    for (const sp of data.spells) {
      if (!cache.spells.find(x => x.id === sp.id)) {
        cache.spells.push(sp);
        apiPut(`/api/spells/${sp.id}`, sp);
      }
    }
  }
}

// ── Spells ────────────────────────────────────────────────────

/**
 * @returns {Spell[]}
 */
export function getAllSpells() {
  return [...cache.spells];
}

/**
 * @param {string} id
 * @returns {Spell|null}
 */
export function getSpell(id) {
  return cache.spells.find(s => s.id === id) || null;
}

/**
 * Upsert a spell.
 * @param {Spell} spell
 */
export function saveSpell(spell) {
  const idx = cache.spells.findIndex(s => s.id === spell.id);
  if (idx >= 0) {
    cache.spells[idx] = spell;
  } else {
    cache.spells.push(spell);
  }
  apiPut(`/api/spells/${spell.id}`, spell);
}

/**
 * @param {string} id
 */
export function deleteSpell(id) {
  cache.spells = cache.spells.filter(s => s.id !== id);
  apiDelete(`/api/spells/${id}`);
}

// ── Character spell operations ────────────────────────────────

/**
 * Add a spell to a character's known spells list.
 * Idempotent — does nothing if already known.
 * @param {string} charId
 * @param {string} spellId
 */
export function learnSpell(charId, spellId) {
  const char = getCharacter(charId);
  if (!char) return;
  if (!char.spells) char.spells = [];
  if (!char.spells.includes(spellId)) {
    char.spells.push(spellId);
    saveCharacter(char);
  }
}

/**
 * Remove a spell from a character's known spells list.
 * @param {string} charId
 * @param {string} spellId
 */
export function forgetSpell(charId, spellId) {
  const char = getCharacter(charId);
  if (!char) return;
  char.spells = (char.spells || []).filter(id => id !== spellId);
  saveCharacter(char);
}

/**
 * Expend one spell slot of the given level for a character.
 * @param {string} charId
 * @param {number} slotLevel  1–9
 * @returns {{ ok: boolean, remaining: number, error?: string }}
 */
export function useSpellSlot(charId, slotLevel) {
  const char = getCharacter(charId);
  if (!char) return { ok: false, error: 'Character not found' };
  if (!char.spellSlots) return { ok: false, error: 'Character has no spell slots' };

  const slot = char.spellSlots[slotLevel];
  if (!slot) return { ok: false, error: `No level-${slotLevel} spell slots` };

  const available = slot.total - slot.used;
  if (available <= 0) return { ok: false, error: `No level-${slotLevel} slots remaining` };

  slot.used += 1;
  saveCharacter(char);
  return { ok: true, remaining: slot.total - slot.used };
}

/**
 * Restore spell slots for a character (long rest = all; short rest = warlock pact only).
 * If spellSlots is null the function initialises them from the class/level table.
 * @param {string} charId
 * @param {'long'|'short'|'all'} restType
 * @returns {Character|null}
 */
export function restoreSpellSlots(charId, restType = 'long') {
  const char = getCharacter(charId);
  if (!char) return null;

  if (!char.spellSlots) {
    // Lazily initialise using the class/level table (imported at call site)
    return char;  // caller (dm-tools) handles initialisation
  }

  if (restType === 'long' || restType === 'all') {
    // Restore everything
    for (const level of Object.keys(char.spellSlots)) {
      char.spellSlots[level].used = 0;
    }
  } else if (restType === 'short') {
    // Only pact magic slots recover on short rest
    for (const level of Object.keys(char.spellSlots)) {
      if (char.spellSlots[level].pactMagic) {
        char.spellSlots[level].used = 0;
      }
    }
  }

  saveCharacter(char);
  return char;
}

/**
 * Initialise or overwrite a character's spell slots to the given map.
 * Used by the DM tools when first granting spell slots.
 * @param {string} charId
 * @param {Object.<number,{total:number,used:number,pactMagic?:boolean}>} slots
 * @returns {Character|null}
 */
export function setSpellSlots(charId, slots) {
  const char = getCharacter(charId);
  if (!char) return null;
  char.spellSlots = slots;
  saveCharacter(char);
  return char;
}

/**
 * Wipe all user data from cache and the server.
 */
export function clearAllData() {
  // Delete all entities from server
  for (const c of cache.characters) apiDelete(`/api/characters/${c.id}`);
  for (const i of cache.items)      apiDelete(`/api/items/${i.id}`);
  for (const s of cache.stories)    apiDelete(`/api/stories/${s.id}`);
  for (const sp of cache.spells)    apiDelete(`/api/spells/${sp.id}`);

  // Clear cache
  cache.characters = [];
  cache.items      = [];
  cache.stories    = [];
  cache.spells     = [];
}
