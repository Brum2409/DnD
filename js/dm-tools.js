/**
 * dm-tools.js — Agentic DM tool implementations.
 *
 * Each tool is a function: (params) => result  (sync)
 *                       or: (params) => Promise<result>  (async)
 *
 * The DM embeds tool calls in its response using markers:
 *   <!-- TOOL_CALL -->
 *   {"tool":"modify_hp","characterId":"...","delta":-5,"reason":"Goblin stab"}
 *   <!-- /TOOL_CALL -->
 *
 * The engine runs an AGENTIC LOOP:
 *   1. DM response → parse tool calls → execute → feed results back to DM
 *   2. DM can continue (more tool calls or final narration)
 *   3. Loop until no tool calls remain (max 8 iterations)
 *
 * ── TOOL CATEGORIES ──────────────────────────────────────────────
 *  DICE    roll_dice
 *  READ    get_character_stats, get_full_character, get_character_inventory,
 *          get_character_stat, get_npc_details, get_adventure_log,
 *          get_scene_history
 *  WRITE   modify_hp, roll_death_save, modify_gold, modify_xp, add_item, remove_item,
 *          add_condition, remove_condition, log_event, advance_scene,
 *          create_item, set_npc_stat
 *  NPC     introduce_npc, npc_speak
 *  QUEST   create_quest, update_quest_objective, complete_quest, get_quests
 *  COMBAT  start_combat, end_combat, next_turn
 *  REST    short_rest, long_rest
 *  MAGIC+  check_concentration, drop_concentration (extend use_spell_slot)
 *  INSPI   give_inspiration, use_inspiration
 *  META    compress_history
 */

import * as db from './db.js';
import { geminiGenerate } from './api-gemini.js';
import { generateIconBase64 } from './api-image.js';
import { uuid, getBaseSpellSlots, getModifier } from './utils.js';

// ── Hit die by class (5e) ──────────────────────────────────────
const HIT_DICE = {
  barbarian: 12,
  fighter: 10, paladin: 10, ranger: 10,
  rogue: 8, bard: 8, cleric: 8, druid: 8, monk: 8, warlock: 8,
  wizard: 6, sorcerer: 6,
};

// ── NPC portrait generator (async, updates NPC after creation) ─

async function generateNPCPortraitAsync(npcId, prompt) {
  try {
    const portrait = await generateIconBase64(prompt);
    const npc = db.getCharacter(npcId);
    if (npc && portrait) {
      npc.portrait = portrait;
      db.saveCharacter(npc);
    }
  } catch (err) {
    console.warn('[dm-tools] NPC portrait generation failed:', err.message);
  }
}

// ── Tool definitions ──────────────────────────────────────────

export const DM_TOOLS = {

  // ─── DICE ──────────────────────────────────────────────────

  /**
   * Roll dice using standard notation (e.g. "1d20+5", "2d6", "d8-1").
   * Always call this BEFORE narrating the outcome — the engine feeds
   * the real result back so you can write accurate narrative.
   */
  roll_dice(params) {
    const notation = String(params.notation || params.dice || '1d20').trim().toLowerCase();
    const match = notation.match(/^(\d*)d(\d+)([+-]\d+)?$/);
    if (!match) {
      return { error: `Invalid dice notation: "${notation}". Use format like "1d20", "2d6+3", "d8-1"` };
    }

    const count    = Math.min(parseInt(match[1] || '1', 10), 20);
    const sides    = parseInt(match[2], 10);
    const modifier = parseInt(match[3] || '0', 10);

    if (sides < 2 || sides > 1000) return { error: `Invalid die size: d${sides}` };

    const rolls  = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const sum    = rolls.reduce((a, b) => a + b, 0);
    const total  = sum + modifier;

    return {
      notation,
      rolls,
      sum,
      modifier,
      total,
      reason:     params.reason || '',
      isCrit:     sides === 20 && count === 1 && rolls[0] === 20,
      isCritFail: sides === 20 && count === 1 && rolls[0] === 1,
    };
  },

  // ─── READ tools ────────────────────────────────────────────

  /** Quick stats snapshot — HP, AC, gold, conditions. */
  get_character_stats(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    return {
      name:       char.name,
      hp:         char.stats.hp,
      maxHp:      char.stats.maxHp,
      ac:         char.stats.ac,
      conditions: char.conditions,
      gold:       char.gold,
      xp:         char.xp,
    };
  },

  /**
   * Full character sheet — ability scores, skills, inventory, backstory,
   * adventure log. Use when you need deeper context about a character.
   */
  get_full_character(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    const inv = char.inventory.map(inst => {
      const item = db.getItem(inst.itemId);
      return item
        ? { name: item.name, type: item.type, rarity: item.rarity, quantity: inst.quantity, stats: item.stats }
        : { name: 'Unknown item', quantity: inst.quantity };
    });
    return {
      name:         char.name,
      race:         char.race,
      class:        char.class,
      level:        char.level,
      hp:           char.stats.hp,
      maxHp:        char.stats.maxHp,
      ac:           char.stats.ac,
      gold:         char.gold,
      xp:           char.xp,
      strength:     char.stats.strength,
      dexterity:    char.stats.dexterity,
      constitution: char.stats.constitution,
      intelligence: char.stats.intelligence,
      wisdom:       char.stats.wisdom,
      charisma:     char.stats.charisma,
      skills:       char.skills,
      conditions:   char.conditions,
      inventory:    inv,
      backstory:    char.backstory || '',
      adventureLog: char.adventureLog.slice(-15),
    };
  },

  /** Inventory list with item details. */
  get_character_inventory(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    return char.inventory.map(inst => {
      const item = db.getItem(inst.itemId);
      return item ? { ...item, quantity: inst.quantity } : { itemId: inst.itemId, quantity: inst.quantity };
    });
  },

  /** Single stat value lookup. */
  get_character_stat(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    return { value: char.stats[params.stat] ?? char[params.stat] ?? null };
  },

  /**
   * Full NPC details — personality, appearance, backstory, HP/AC.
   * Use when you need context beyond what the NPC quick-reference shows.
   * Accepts npcId OR npcName.
   */
  get_npc_details(params) {
    let npc = null;
    if (params.npcId)   npc = db.getCharacter(params.npcId);
    if (!npc && params.npcName) npc = db.getNPCByName(params.npcName);
    if (!npc) return { error: 'NPC not found' };
    return {
      id:          npc.id,
      name:        npc.name,
      race:        npc.race,
      role:        npc.npcRole || npc.class,
      hp:          npc.stats.hp,
      maxHp:       npc.stats.maxHp,
      ac:          npc.stats.ac,
      conditions:  npc.conditions || [],
      personality: npc.personality || '',
      appearance:  npc.appearance  || '',
      backstory:   npc.backstory   || '',
    };
  },

  /** Full adventure log for a character (all entries). */
  get_adventure_log(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    return {
      name: char.name,
      log:  char.adventureLog,
    };
  },

  /** List of all past and current scenes in this story. */
  get_scene_history(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    return {
      currentSceneIndex: story.currentSceneIndex,
      scenes: story.scenes.map((s, i) => ({
        index:       i,
        title:       s.title,
        description: s.description.slice(0, 250),
        completed:   Boolean(s.completedAt),
        isCurrent:   i === story.currentSceneIndex,
      })),
    };
  },

  // ─── WRITE tools ───────────────────────────────────────────

  /** Damage (negative delta) or heal (positive delta) a character or NPC. */
  modify_hp(params) {
    const char = db.updateCharacterHP(params.characterId, params.delta);
    if (!char) return { error: 'Character not found' };

    const isDead = char.stats.hp <= 0;

    // When an NPC/enemy dies, move them from scene.npcs[] to scene.deadNpcs[].
    // They stay in deadNpcs so the DM retains context for looting, death narration,
    // and any post-combat interactions with the body.
    if (isDead && char.isNPC) {
      const allStories = db.getAllStories();
      for (const story of allStories) {
        const currentScene = story.scenes[story.currentSceneIndex];
        if (currentScene?.npcs?.includes(char.id)) {
          currentScene.npcs = currentScene.npcs.filter(id => id !== char.id);
          if (!currentScene.deadNpcs) currentScene.deadNpcs = [];
          if (!currentScene.deadNpcs.includes(char.id)) {
            currentScene.deadNpcs.push(char.id);
          }
          db.saveStory(story);
          break;
        }
      }
    }

    // When a PLAYER CHARACTER drops to 0 HP, begin death saving throws (5e rule).
    // NPCs/enemies just die immediately — death saves are a PC-only mechanic.
    let needsDeathSaves = false;
    if (isDead && !char.isNPC) {
      if (!char.conditions.includes('Unconscious')) {
        char.conditions.push('Unconscious');
      }
      if (!char.deathSaves) {
        char.deathSaves = { successes: 0, failures: 0 };
      }
      needsDeathSaves = true;
      db.saveCharacter(char);
    }

    // If a PC is healed above 0 HP, clear death saves and unconscious state
    if (!isDead && !char.isNPC && char.deathSaves) {
      char.deathSaves = null;
      char.conditions = char.conditions.filter(c => c !== 'Unconscious' && c !== 'Stable');
      db.saveCharacter(char);
    }

    return {
      newHp:  char.stats.hp,
      maxHp:  char.stats.maxHp,
      delta:  params.delta,
      isDead,
      needsDeathSaves,
      reason: params.reason || '',
    };
  },

  /**
   * Roll a death saving throw for a downed player character (5e rules).
   * 1       = two failures (critical fail)
   * 2–9     = one failure
   * 10–19   = one success
   * 20      = character regains 1 HP and stabilises (critical success)
   * Three successes → stable (conscious at 0 HP, no longer rolling)
   * Three failures  → character dies
   */
  roll_death_save(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (char.isNPC) return { error: 'Death saves are only for player characters' };
    if (char.stats.hp > 0) return { error: 'Character is not downed (HP > 0)' };

    // Ensure deathSaves exists
    if (!char.deathSaves) char.deathSaves = { successes: 0, failures: 0 };

    const roll = Math.floor(Math.random() * 20) + 1;
    let successes = char.deathSaves.successes;
    let failures  = char.deathSaves.failures;
    let outcome   = '';

    if (roll === 20) {
      // Miraculous recovery — regain 1 HP
      char.stats.hp = 1;
      char.deathSaves = null;
      char.conditions = char.conditions.filter(c => c !== 'Unconscious' && c !== 'Stable');
      outcome = 'critical_success';
    } else if (roll === 1) {
      // Critical fail — two failures
      failures = Math.min(3, failures + 2);
      outcome = 'critical_fail';
    } else if (roll >= 10) {
      successes = Math.min(3, successes + 1);
      outcome = 'success';
    } else {
      failures = Math.min(3, failures + 1);
      outcome = 'fail';
    }

    let isDead   = false;
    let isStable = false;

    if (outcome !== 'critical_success') {
      if (failures >= 3) {
        isDead = true;
        char.conditions = char.conditions.filter(c => c !== 'Unconscious');
        char.conditions.push('Dead');
        char.deathSaves = { successes, failures };
        outcome = 'dead';
      } else if (successes >= 3) {
        isStable = true;
        char.conditions = char.conditions.filter(c => c !== 'Unconscious');
        char.conditions.push('Stable');
        char.deathSaves = { successes, failures };
        outcome = 'stable';
      } else {
        char.deathSaves = { successes, failures };
      }
    }

    db.saveCharacter(char);

    return {
      roll,
      outcome,
      successes: char.deathSaves?.successes ?? successes,
      failures:  char.deathSaves?.failures  ?? failures,
      isDead,
      isStable,
      newHp: char.stats.hp,
      charName: char.name,
    };
  },

  /** Earn (positive) or spend/lose (negative) gold. */
  modify_gold(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    char.gold = Math.max(0, (char.gold || 0) + params.delta);
    db.saveCharacter(char);
    return { newGold: char.gold, delta: params.delta };
  },

  /** Award (positive) or remove (negative) XP. */
  modify_xp(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    char.xp = Math.max(0, (char.xp || 0) + params.delta);
    db.saveCharacter(char);
    return { newXp: char.xp, delta: params.delta };
  },

  /** Give an item (by itemId) to a character. Use create_item first if the item doesn't exist yet. */
  add_item(params) {
    db.updateCharacterInventory(params.characterId, params.itemId, 'add');
    const item = db.getItem(params.itemId);
    return { success: true, itemName: item?.name || params.itemId };
  },

  /** Remove an item from a character's inventory. */
  remove_item(params) {
    db.updateCharacterInventory(params.characterId, params.itemId, 'remove');
    const item = db.getItem(params.itemId);
    return { success: true, itemName: item?.name || params.itemId };
  },

  /** Apply a 5e status condition (Poisoned, Blinded, Grappled, etc.). */
  add_condition(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (!char.conditions.includes(params.condition)) {
      char.conditions.push(params.condition);
      db.saveCharacter(char);
    }
    return { conditions: char.conditions };
  },

  /** Remove a status condition. */
  remove_condition(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    char.conditions = char.conditions.filter(c => c !== params.condition);
    db.saveCharacter(char);
    return { conditions: char.conditions };
  },

  /** Append a summary entry to a character's adventure log. */
  log_event(params) {
    db.addToAdventureLog(params.characterId, params.entry);
    return { success: true };
  },

  /** Modify an NPC stat (hp, maxHp, ac) or add/remove a condition. */
  set_npc_stat(params) {
    const npc = params.npcId
      ? db.getCharacter(params.npcId)
      : db.getNPCByName(params.npcName || '');
    if (!npc || !npc.isNPC) return { error: 'NPC not found' };

    if (params.stat === 'hp') {
      const delta = params.value - npc.stats.hp;
      return DM_TOOLS.modify_hp({ characterId: npc.id, delta, reason: params.reason });
    }
    if (['maxHp', 'ac'].includes(params.stat)) {
      npc.stats[params.stat] = params.value;
      db.saveCharacter(npc);
      return { success: true, stat: params.stat, value: params.value };
    }
    if (params.stat === 'add_condition') {
      return DM_TOOLS.add_condition({ characterId: npc.id, condition: params.value });
    }
    if (params.stat === 'remove_condition') {
      return DM_TOOLS.remove_condition({ characterId: npc.id, condition: params.value });
    }
    return { error: `Unknown stat "${params.stat}". Use: hp, maxHp, ac, add_condition, remove_condition` };
  },

  /** Mark the current scene complete and open a new one. */
  advance_scene(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    const currentScene = story.scenes[story.currentSceneIndex];
    if (currentScene && !currentScene.completedAt) {
      currentScene.completedAt = Date.now();
    }

    const newScene = {
      id:           uuid(),
      title:        params.newSceneTitle || 'New Scene',
      description:  params.newSceneDescription || '',
      imagePrompt:  params.newSceneDescription || '',
      imageUrl:     '',
      npcs:         [],
      loot:         [],
      completedAt:  null,
    };

    story.scenes.push(newScene);
    story.currentSceneIndex = story.scenes.length - 1;
    story.sceneImageUrl = '';
    db.saveStory(story);

    return {
      newSceneIndex: story.currentSceneIndex,
      newSceneId:    newScene.id,
      needsImage:    true,
      imagePrompt:   newScene.imagePrompt,
    };
  },

  /**
   * Create a brand-new item and save it to the item library.
   * Returns itemId — use it immediately in add_item in your next turn.
   */
  async create_item(params) {
    const lore = await geminiGenerate(
      `Write a 2-sentence fantasy lore backstory for a DND item named "${params.name}". ${params.description || ''}. Be evocative and mysterious. Just the lore text, no labels.`
    ).catch(() => '');

    const iconPrompt = `${params.name}, ${params.type || 'misc'}, fantasy RPG item icon, ${params.rarity || 'common'} rarity, dark background, detailed art, full item visible and centered`;
    const iconBase64 = await generateIconBase64(iconPrompt).catch(() => '');

    const item = {
      id:          uuid(),
      name:        params.name,
      type:        params.type || 'misc',
      description: params.description || '',
      lore,
      iconBase64,
      iconPrompt,
      stats:       params.stats || {},
      rarity:      params.rarity || 'common',
      createdAt:   Date.now(),
    };
    db.saveItem(item);
    return { itemId: item.id, item };
  },

  // ─── NPC / World Character tools ───────────────────────────

  /**
   * Introduce a world character (NPC, enemy, merchant, creature…).
   * Call this the FIRST time a named character appears. They are then
   * remembered across all sessions via the characters table.
   *
   * If an NPC with the same name already exists in this story, that existing
   * character is reused (no duplicate created) and added to the current scene.
   *
   * Returns npcId — use it in npc_speak in your next turn.
   */
  async introduce_npc(params) {
    const {
      storyId, name, role = 'neutral', race = 'Human',
      personality = '', appearance = '',
      hp = 10, ac = 10,
    } = params;

    // ── Deduplication guard ──────────────────────────────────────
    // Unique named characters (ally, merchant, neutral, boss) are deduplicated by name:
    // calling introduce_npc for an already-known character just re-adds them to the scene.
    //
    // Generic enemies/creatures (role = 'enemy' | 'creature') intentionally allow
    // multiple instances with the same name — e.g. three Goblins, two Zombies, etc.
    const UNIQUE_NPC_ROLES = ['ally', 'merchant', 'neutral', 'boss'];
    const isUniqueRole = UNIQUE_NPC_ROLES.includes(role);

    if (storyId && isUniqueRole) {
      const existingNPCs = db.getNPCsForStory(storyId);
      const duplicate = existingNPCs.find(
        n => n.name.trim().toLowerCase() === name.trim().toLowerCase()
      );
      if (duplicate) {
        // Make sure they're registered in the current scene
        const story = db.getStory(storyId);
        if (story) {
          const currentScene = story.scenes[story.currentSceneIndex];
          if (currentScene) {
            if (!currentScene.npcs) currentScene.npcs = [];
            if (!currentScene.npcs.includes(duplicate.id)) {
              currentScene.npcs.push(duplicate.id);
            }
            duplicate.lastSceneId = currentScene.id;
            db.saveStory(story);
            db.saveCharacter(duplicate);
          }
        }
        return {
          npcId: duplicate.id,
          npc:   duplicate,
          reused: true,
          note:  `Existing character "${duplicate.name}" (ID: ${duplicate.id}) reused — no duplicate created.`,
        };
      }
    }

    const backstory = await geminiGenerate(
      `Write a 2-3 sentence backstory for a DND NPC. Name: ${name}. Role: ${role}. Race: ${race}. Personality: ${personality || 'mysterious'}. Appearance: ${appearance || 'unremarkable'}. Be evocative. Return only the backstory text, no labels or formatting.`
    ).catch(() => `${name} is a ${race} ${role} with a past shrouded in mystery.`);

    const npc = {
      id:          uuid(),
      name,
      race,
      class:       role,
      level:       1,
      isNPC:       true,
      npcRole:     role,
      personality,
      appearance,
      backstory,
      portrait:    '',
      stats: {
        hp, maxHp: hp, ac,
        strength: 10, dexterity: 10, constitution: 10,
        intelligence: 10, wisdom: 10, charisma: 10,
      },
      skills:          [],
      inventory:       [],
      conditions:      [],
      gold:            0,
      xp:              0,
      adventureLog:    [],
      metInStoryIds:   storyId ? [storyId] : [],
      createdAt:       Date.now(),
      updatedAt:       Date.now(),
    };

    db.saveCharacter(npc);

    if (storyId) {
      db.addNPCToStory(storyId, npc.id);

      // Add NPC to the current scene's npcs[] and record lastSceneId
      const story = db.getStory(storyId);
      if (story) {
        const currentScene = story.scenes[story.currentSceneIndex];
        if (currentScene) {
          if (!currentScene.npcs) currentScene.npcs = [];
          if (!currentScene.npcs.includes(npc.id)) {
            currentScene.npcs.push(npc.id);
          }
          db.saveStory(story);
          npc.lastSceneId = currentScene.id;
          db.saveCharacter(npc);
        }
      }
    }

    const portraitPrompt = `${name}, ${race} ${role}, DND fantasy character portrait, ${appearance || 'dramatic lighting'}, detailed face, dark fantasy art, circular portrait, subject centered`;
    generateNPCPortraitAsync(npc.id, portraitPrompt);

    return { npcId: npc.id, npc };
  },

  /**
   * Remove an NPC from the current scene without killing them.
   * Use this when an NPC leaves, flees, or departs while still alive.
   * They remain a known character in the story and can reappear later.
   * Accepts npcId OR npcName, plus storyId.
   */
  remove_npc_from_scene(params) {
    const npc = params.npcId
      ? db.getCharacter(params.npcId)
      : db.getNPCByName(params.npcName || '');
    if (!npc || !npc.isNPC) return { error: 'NPC not found' };

    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    const currentScene = story.scenes[story.currentSceneIndex];
    if (!currentScene) return { error: 'No current scene' };

    if (!currentScene.npcs) currentScene.npcs = [];
    const wasInScene = currentScene.npcs.includes(npc.id);
    currentScene.npcs = currentScene.npcs.filter(id => id !== npc.id);
    db.saveStory(story);

    return {
      success: true,
      npcId:   npc.id,
      npcName: npc.name,
      wasInScene,
    };
  },

  /**
   * Make an NPC say something out loud.
   * Renders as a distinct speech bubble — the ONLY way NPC dialogue should appear.
   * Accepts npcId OR npcName.
   */
  npc_speak(params) {
    let npc = null;
    if (params.npcId) npc = db.getCharacter(params.npcId);
    if (!npc && params.npcName) npc = db.getNPCByName(params.npcName);
    if (!npc) {
      return { error: 'NPC not found', npcName: params.npcName || params.npcId };
    }
    return {
      npcId:   npc.id,
      npcName: npc.name,
      npcRole: npc.npcRole || npc.class,
      portrait: npc.portrait,
      speech:  params.speech,
    };
  },

  // ─── MAGIC / SPELL tools ───────────────────────────────────

  /**
   * Create a brand-new spell and save it to the spell library.
   * Returns spellId — use it immediately in give_spell in your next turn.
   * For cantrips set level=0. For regular spells set level 1–9.
   */
  async create_spell(params) {
    const level     = Number(params.level ?? 0);
    const levelName = level === 0 ? 'cantrip' : `level-${level} spell`;

    const lore = await geminiGenerate(
      `Write a 2-sentence flavour lore for a DND 5e ${levelName} named "${params.name}" (${params.school || 'Evocation'} school). ${params.description || ''}. Be evocative and mysterious. Return only the lore text, no labels.`
    ).catch(() => '');

    const iconPrompt = `${params.name}, ${params.school || 'magic'} spell, DND 5e ${levelName}, glowing magical effect, fantasy art icon, dark background, detailed, centered composition`;
    const iconBase64 = await generateIconBase64(iconPrompt).catch(() => '');

    const spell = {
      id:           uuid(),
      name:         params.name,
      level,
      school:       params.school       || 'Evocation',
      castingTime:  params.castingTime  || '1 action',
      range:        params.range        || '60 feet',
      components:   params.components   || 'V, S',
      duration:     params.duration     || 'Instantaneous',
      concentration: Boolean(params.concentration),
      ritual:        Boolean(params.ritual),
      description:  params.description  || '',
      lore,
      iconBase64,
      iconPrompt,
      damage:       params.damage       || '',
      damageType:   params.damageType   || '',
      savingThrow:  params.savingThrow  || '',
      createdAt:    Date.now(),
    };

    db.saveSpell(spell);
    return { spellId: spell.id, spell };
  },

  /**
   * Teach a character a spell (add to their known/prepared spells).
   * Use create_spell first if the spell doesn't exist yet.
   * Also auto-initialises spell slots for the character if they have none yet.
   */
  give_spell(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    const spell = db.getSpell(params.spellId);
    if (!spell) return { error: `Spell ${params.spellId} not found — run create_spell first` };

    // Auto-initialise spell slots the first time a spellcaster gets a spell
    if (!char.spellSlots) {
      const slots = getBaseSpellSlots(char.class, char.level);
      if (slots) db.setSpellSlots(char.id, slots);
    }

    db.learnSpell(char.id, params.spellId);
    return { success: true, spellName: spell.name, charName: char.name };
  },

  /**
   * Remove a spell from a character's known/prepared spells.
   */
  remove_spell(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    const spell = db.getSpell(params.spellId);
    db.forgetSpell(char.id, params.spellId);
    return { success: true, spellName: spell?.name || params.spellId };
  },

  /**
   * Expend one spell slot of the given level.
   * Call this whenever a character casts a levelled spell (NOT cantrips — they're free).
   * If concentration=true, any existing concentration spell is dropped automatically.
   */
  use_spell_slot(params) {
    const result = db.useSpellSlot(params.characterId, Number(params.slotLevel));
    if (!result.ok) return { error: result.error };
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };

    let droppedConcentration = null;
    if (params.concentration) {
      if (char.activeConcentration) {
        droppedConcentration = char.activeConcentration.spellName;
      }
      char.activeConcentration = {
        spellName:  params.spellName || 'Unknown spell',
        slotLevel:  Number(params.slotLevel),
        startedAt:  Date.now(),
      };
      db.saveCharacter(char);
    }

    return {
      success:              true,
      slotLevel:            params.slotLevel,
      remaining:            result.remaining,
      charName:             char.name,
      spellName:            params.spellName || '',
      concentration:        Boolean(params.concentration),
      droppedConcentration,
    };
  },

  /**
   * Restore spell slots after a long rest (all slots) or short rest (warlock pact only).
   * Also auto-initialises slots from the class/level table if the character has none.
   */
  restore_spell_slots(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };

    const restType = params.restType || 'long';

    // Auto-initialise if character has no slots yet
    if (!char.spellSlots) {
      const slots = getBaseSpellSlots(char.class, char.level);
      if (!slots) return { success: true, message: `${char.name} has no spell slots (${char.class} is a non-caster)` };
      db.setSpellSlots(char.id, slots);
    } else {
      db.restoreSpellSlots(char.id, restType);
    }

    const updated = db.getCharacter(char.id);
    const slotSummary = updated?.spellSlots
      ? Object.entries(updated.spellSlots)
          .map(([lvl, s]) => `L${lvl}: ${s.total - s.used}/${s.total}${s.pactMagic ? ' (Pact)' : ''}`)
          .join(', ')
      : 'none';

    return { success: true, restType, charName: char.name, slots: slotSummary };
  },

  /**
   * Read a character's current spell slots and known spells.
   * Use this to check if the character can cast or has slots remaining.
   */
  get_spell_slots(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };

    const knownSpells = (char.spells || []).map(id => {
      const sp = db.getSpell(id);
      return sp
        ? { id: sp.id, name: sp.name, level: sp.level, school: sp.school, castingTime: sp.castingTime }
        : { id, name: 'Unknown spell' };
    });

    const slotStatus = char.spellSlots
      ? Object.entries(char.spellSlots).map(([lvl, s]) => ({
          level: Number(lvl),
          total: s.total,
          used: s.used,
          available: s.total - s.used,
          pactMagic: Boolean(s.pactMagic),
        }))
      : [];

    return {
      charName:    char.name,
      class:       char.class,
      level:       char.level,
      isSpellcaster: Boolean(char.spellSlots || (char.spells || []).length > 0),
      spellSlots:  slotStatus,
      knownSpells,
    };
  },

  // ─── SCENE IMAGE ──────────────────────────────────────────

  /**
   * Update the current scene image mid-scene without advancing the scene.
   * Use this whenever the visual environment changes meaningfully:
   *   — fire breaks out or is extinguished
   *   — a powerful NPC / creature arrives or departs
   *   — time of day shifts (day → night, etc.)
   *   — the room / area is significantly transformed
   *   — any major visual change that would make the current image look wrong
   *
   * imageDescription should be the full new visual state of the scene.
   */
  refresh_scene_image(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    const scene = story.scenes[story.currentSceneIndex];
    if (!scene) return { error: 'No current scene' };

    // Clear existing image so client knows to generate a new one
    scene.imageUrl    = '';
    story.sceneImageUrl = '';

    // Update the prompt with the new visual description
    if (params.imageDescription) {
      scene.imagePrompt = params.imageDescription;
    }

    db.saveStory(story);
    return { sceneId: scene.id, imagePrompt: scene.imagePrompt, needsImage: true };
  },

  // ─── META tools ────────────────────────────────────────────

  /**
   * Compress the chat history using AI to keep the context manageable.
   * The full history is preserved server-side and visible to the player.
   * After compression the DM operates from a compact adventure summary.
   *
   * Use this proactively when the conversation is getting very long (> 40 messages)
   * or when the player asks for it.
   */
  async compress_history(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    // Separate out all conversational messages (skip npc/compression/summary entries)
    const conversational = story.dmChatHistory.filter(
      m => (m.role === 'user' || m.role === 'assistant') && !m.isCompressionSummary
    );

    // Always keep the most recent messages uncompressed so the DM has
    // live context for the current scene. Only older messages are summarised.
    const KEEP_RECENT = 8;

    if (conversational.length <= KEEP_RECENT) {
      return { error: `History is too short to compress (need more than ${KEEP_RECENT} messages). Continue playing.` };
    }

    const toCompress = conversational.slice(0, -KEEP_RECENT);
    const toKeep     = conversational.slice(-KEEP_RECENT);

    // Build plain-text transcript of only the messages being compressed
    const transcript = toCompress
      .map(m => `${m.role === 'user' ? 'PLAYER' : 'DM'}: ${m.content.slice(0, 600)}`)
      .join('\n\n');

    const summary = await geminiGenerate(
      `You are an AI memory system for a DND campaign. Compress the following conversation into a dense adventure summary for the Dungeon Master's memory. Cover ALL of the following:

- Major events and their outcomes
- Combat encounters (who fought, who won, damage taken)
- Items received or lost by each character, with item names
- Gold and XP changes
- NPCs met, their names, roles, and current relationship to the party
- Key decisions the players made and consequences
- Current quest objective and where the party is heading
- The mood / tone of the session so far

Be specific with names and numbers. Write in present tense ("The party is…"). Under 700 words.

CONVERSATION TRANSCRIPT:
${transcript.slice(0, 10000)}`,
      '',
      0.5
    ).catch(() => 'Adventure history compressed. The party has been adventuring.');

    // Archive the full history (append to any existing archive from prior compressions)
    if (!story.dmChatHistoryFull) story.dmChatHistoryFull = [];
    story.dmChatHistoryFull.push(...story.dmChatHistory);

    const compressedCount = toCompress.length;

    // Rebuild live history:
    //   1. compression marker  (UI divider, invisible to Gemini)
    //   2. summary user msg    (read by Gemini as condensed prior-session context)
    //   3. the recent messages that were NOT compressed (kept verbatim)
    story.dmChatHistory = [
      {
        role:             'compression',
        content:          'Session history compressed',
        summary,
        compressedCount,
        keptCount:        toKeep.length,
        compressedAt:     Date.now(),
        compressionIndex: story.dmChatHistoryFull.length - story.dmChatHistory.length,
      },
      {
        role:                 'user',
        content:              `[ADVENTURE SUMMARY — ${compressedCount} older messages compressed; the ${toKeep.length} most recent messages follow in full]\n\n${summary}`,
        isCompressionSummary: true,
        timestamp:            Date.now(),
      },
      ...toKeep,
    ];

    db.saveStory(story);

    return {
      success:        true,
      compressedCount,
      keptCount:      toKeep.length,
      summary,
    };
  },

  // ─── QUEST tools ───────────────────────────────────────────

  /**
   * Create a new quest in the story's quest journal.
   * objectives is an array of strings (each string becomes one objective).
   */
  create_quest(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    if (!story.quests) story.quests = [];

    const quest = {
      id:          uuid(),
      title:       params.title || 'Untitled Quest',
      description: params.description || '',
      giver:       params.giver || '',
      status:      'active',
      objectives:  (params.objectives || []).map(text => ({ text, done: false })),
      reward:      params.reward || '',
      createdAt:   Date.now(),
    };

    story.quests.push(quest);
    db.saveStory(story);

    return { questId: quest.id, quest };
  },

  /**
   * Mark a single quest objective as done or not done.
   * objectiveIndex is 0-based.
   */
  update_quest_objective(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    const quest = (story.quests || []).find(q => q.id === params.questId);
    if (!quest) return { error: `Quest not found: ${params.questId}` };

    const obj = quest.objectives[params.objectiveIndex];
    if (!obj) return { error: `Objective index out of range: ${params.objectiveIndex}` };

    obj.done = !!params.done;
    db.saveStory(story);

    return {
      questId:         quest.id,
      questTitle:      quest.title,
      objectiveIndex:  params.objectiveIndex,
      objectiveText:   obj.text,
      done:            obj.done,
      allObjectives:   quest.objectives,
    };
  },

  /**
   * Mark a quest as completed or failed and optionally award XP/gold to all party members.
   */
  complete_quest(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    const quest = (story.quests || []).find(q => q.id === params.questId);
    if (!quest) return { error: `Quest not found: ${params.questId}` };

    quest.status = params.status === 'failed' ? 'failed' : 'completed';
    db.saveStory(story);

    return { questId: quest.id, questTitle: quest.title, status: quest.status };
  },

  /**
   * Return all quests for a story (active and completed).
   */
  get_quests(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    return { quests: story.quests || [] };
  },

  // ─── COMBAT tools ──────────────────────────────────────────

  /**
   * Begin structured combat. Rolls initiative for all participants
   * (d20 + DEX modifier) and sets story.combat.active = true.
   * participants: [{ id: characterId|npcId, name: string, isNPC: bool }]
   */
  start_combat(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    const defs = params.participants || [];
    if (!defs.length) return { error: 'No participants provided' };

    const rolled = defs.map(p => {
      const char = p.id ? db.getCharacter(p.id) : null;
      const dexMod = char ? getModifier(char.stats?.dexterity ?? 10) : 0;
      const roll = Math.floor(Math.random() * 20) + 1;
      return {
        id:         p.id || '',
        name:       char?.name || p.name || 'Unknown',
        isNPC:      Boolean(p.isNPC ?? char?.isNPC),
        initiative: roll + dexMod,
        roll,
        dexMod,
      };
    });

    // Sort descending; PCs before NPCs on ties
    rolled.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      if (a.isNPC !== b.isNPC) return a.isNPC ? 1 : -1;
      return Math.random() - 0.5;
    });

    story.combat = {
      active:       true,
      round:        1,
      turnIndex:    0,
      participants: rolled,
      startedAt:    Date.now(),
    };
    db.saveStory(story);

    return {
      combat: story.combat,
      order:  rolled.map((p, i) =>
        `${i + 1}. ${p.name} — Initiative ${p.initiative} (d20[${p.roll}]${p.dexMod >= 0 ? '+' : ''}${p.dexMod})`),
    };
  },

  /** End combat and clear the combat state. */
  end_combat(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    story.combat = { active: false, round: 0, turnIndex: 0, participants: [] };
    db.saveStory(story);
    return { success: true };
  },

  /**
   * Advance to the next combatant's turn.
   * Automatically increments round when all participants have gone.
   */
  next_turn(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    if (!story.combat?.active) return { error: 'No active combat' };

    const combat = story.combat;
    combat.turnIndex = (combat.turnIndex + 1) % combat.participants.length;
    if (combat.turnIndex === 0) combat.round++;
    db.saveStory(story);

    const current = combat.participants[combat.turnIndex];
    const char = current.id ? db.getCharacter(current.id) : null;
    return {
      round:              combat.round,
      turnIndex:          combat.turnIndex,
      currentParticipant: {
        ...current,
        hp:         char?.stats?.hp,
        maxHp:      char?.stats?.maxHp,
        conditions: char?.conditions || [],
      },
    };
  },

  // ─── CONCENTRATION tools ────────────────────────────────────

  /**
   * Roll a Constitution saving throw to maintain concentration after damage.
   * DC = max(10, half damage taken). On failure, concentration is dropped.
   */
  check_concentration(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (!char.activeConcentration) return { error: `${char.name} is not concentrating` };

    const dc     = Math.max(10, Math.floor((params.damage || 0) / 2));
    const conMod = getModifier(char.stats?.constitution ?? 10);
    const roll   = Math.floor(Math.random() * 20) + 1;
    const total  = roll + conMod;
    const success = total >= dc;

    let lost = null;
    if (!success) {
      lost = char.activeConcentration.spellName;
      char.activeConcentration = null;
      db.saveCharacter(char);
    }

    return {
      charName: char.name,
      roll, conMod, total, dc, success,
      maintaining:       success ? char.activeConcentration?.spellName : null,
      lostConcentration: lost,
    };
  },

  /** Voluntarily drop a concentration spell. */
  drop_concentration(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    const dropped = char.activeConcentration?.spellName || null;
    char.activeConcentration = null;
    db.saveCharacter(char);
    return { success: true, dropped, charName: char.name };
  },

  // ─── REST tools ─────────────────────────────────────────────

  /**
   * Short rest: spend hit dice to recover HP.
   * diceToSpend: how many hit dice to roll (capped at available).
   * Each die: 1d[hitDie] + CON modifier, minimum 1 HP per die.
   */
  short_rest(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (char.isNPC) return { error: 'Short rest is only for player characters' };
    if ((char.stats.hp || 0) <= 0) return { error: 'Cannot rest while at 0 HP — stabilise first' };

    const hitDie   = HIT_DICE[(char.class || '').toLowerCase()] ?? 8;
    const level    = char.level || 1;
    const used     = char.hitDiceUsed || 0;
    const avail    = level - used;

    if (avail <= 0) {
      return { error: `No hit dice remaining (used all ${level}). Take a long rest to recover them.` };
    }

    const toSpend = Math.min(Math.max(1, params.diceToSpend || 1), avail);
    const conMod  = getModifier(char.stats?.constitution ?? 10);

    let healed = 0;
    const rolls = [];
    for (let i = 0; i < toSpend; i++) {
      const r = Math.floor(Math.random() * hitDie) + 1;
      rolls.push(r);
      healed += Math.max(1, r + conMod);
    }

    const prevHp       = char.stats.hp;
    char.stats.hp      = Math.min(char.stats.maxHp, prevHp + healed);
    char.hitDiceUsed   = used + toSpend;
    db.saveCharacter(char);

    // Warlocks also recover pact magic slots on a short rest
    if ((char.class || '').toLowerCase() === 'warlock') {
      db.restoreSpellSlots(char.id, 'short');
    }

    return {
      charName:      char.name,
      hitDie:        `d${hitDie}`,
      diceSpent:     toSpend,
      diceAvailable: avail - toSpend,
      rolls,
      conMod,
      healed:        char.stats.hp - prevHp,
      newHp:         char.stats.hp,
      maxHp:         char.stats.maxHp,
    };
  },

  /**
   * Long rest: restore HP to max, recover all spell slots,
   * restore half total hit dice (rounded up), clear resting conditions.
   */
  long_rest(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (char.isNPC) return { error: 'Long rest is only for player characters' };

    const prevHp = char.stats.hp;
    char.stats.hp = char.stats.maxHp;

    // Restore half total hit dice (rounded up)
    const level    = char.level || 1;
    const prevUsed = char.hitDiceUsed || 0;
    const restored = Math.ceil(level / 2);
    char.hitDiceUsed = Math.max(0, prevUsed - restored);

    // Drop concentration
    const droppedConc = char.activeConcentration?.spellName || null;
    char.activeConcentration = null;

    // Clear conditions restored by a full rest
    const REST_CLEARS = ['Unconscious', 'Stable', 'Prone', 'Incapacitated', 'Exhaustion'];
    char.conditions = char.conditions.filter(c => !REST_CLEARS.includes(c));

    db.saveCharacter(char);
    db.restoreSpellSlots(char.id, 'long');

    const updated = db.getCharacter(char.id);
    const slotSummary = updated?.spellSlots
      ? Object.entries(updated.spellSlots)
          .map(([lvl, s]) => `L${lvl}:${s.total - s.used}/${s.total}`)
          .join(' ')
      : 'none';

    return {
      charName:         char.name,
      hpRestored:       char.stats.maxHp - prevHp,
      newHp:            char.stats.maxHp,
      maxHp:            char.stats.maxHp,
      hitDiceRestored:  restored,
      hitDiceAvailable: level - char.hitDiceUsed,
      hitDiceTotal:     level,
      spellSlots:       slotSummary,
      droppedConcentration: droppedConc,
    };
  },

  // ─── INSPIRATION tools ──────────────────────────────────────

  /**
   * Award Inspiration to a player character for great roleplay.
   * Per 5e rules, a character can only hold one Inspiration at a time.
   */
  give_inspiration(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (char.isNPC) return { error: 'Inspiration is only for player characters' };
    char.inspiration = true;
    db.saveCharacter(char);
    return { charName: char.name, reason: params.reason || '', hasInspiration: true };
  },

  /**
   * Expend a character's Inspiration for advantage on a d20 roll.
   * Returns whether they had Inspiration to use.
   */
  use_inspiration(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (!char.inspiration) {
      return { charName: char.name, hadInspiration: false, error: `${char.name} does not have Inspiration` };
    }
    char.inspiration = false;
    db.saveCharacter(char);
    return { charName: char.name, hadInspiration: true, used: true };
  },
};

// ── Agentic re-prompt formatter ───────────────────────────────

/**
 * Format tool results into a concise, machine-readable summary that is
 * injected back into the DM's context after each agentic iteration.
 *
 * @param {Array<{tool:string, params:Object, result:any}>} toolResults
 * @returns {string}
 */
export function formatToolResultsForRePrompt(toolResults) {
  if (!toolResults.length) return '(no tools executed)';
  return toolResults.map(({ tool, params, result }) => {
    if (result?.error) return `❌ ${tool} FAILED: ${result.error}`;

    switch (tool) {
      case 'roll_dice': {
        const mod = result.modifier !== 0
          ? (result.modifier > 0 ? `+${result.modifier}` : `${result.modifier}`)
          : '';
        const rollStr = result.rolls.length > 1
          ? `[${result.rolls.join(', ')}] sum ${result.sum}${mod}`
          : `${result.rolls[0]}${mod}`;
        const flag = result.isCrit ? ' ⚡ CRITICAL HIT!' : result.isCritFail ? ' 💀 CRITICAL FAIL!' : '';
        return `🎲 roll_dice(${result.notation}${result.reason ? ' — ' + result.reason : ''}): ${rollStr} = TOTAL **${result.total}**${flag}`;
      }
      case 'create_spell':
        return `✅ create_spell: Spell "${result.spell?.name}" created (Level ${result.spell?.level ?? 0} ${result.spell?.school}). spellId="${result.spellId}" — use this exact ID in your next give_spell call`;
      case 'give_spell':
        return `✅ give_spell: ${result.charName} learned "${result.spellName}"`;
      case 'remove_spell':
        return `✅ remove_spell: "${result.spellName}" removed from known spells`;
      case 'use_spell_slot': {
        let slotMsg = `✅ use_spell_slot: Level-${result.slotLevel} slot expended${result.spellName ? ` for ${result.spellName}` : ''} — ${result.remaining} remaining for ${result.charName}`;
        if (result.concentration) slotMsg += ` — CONCENTRATING on ${result.spellName}`;
        if (result.droppedConcentration) slotMsg += ` (dropped ${result.droppedConcentration})`;
        return slotMsg;
      }
      case 'restore_spell_slots':
        return `✅ restore_spell_slots: ${result.charName} recovers slots (${result.restType} rest) — ${result.slots}`;
      case 'get_spell_slots': {
        const slotStr = result.spellSlots?.map(s => `L${s.level}: ${s.available}/${s.total}${s.pactMagic ? '(P)' : ''}`).join(' ') || 'none';
        const spellStr = result.knownSpells?.map(s => `${s.name}(L${s.level})`).join(', ') || 'none';
        return `ℹ️ ${result.charName} spell slots: ${slotStr} | Known: ${spellStr}`;
      }
      case 'create_item':
        return `✅ create_item: Item "${result.item?.name}" created. itemId="${result.itemId}" — use this exact ID in your next add_item call`;
      case 'introduce_npc':
        return result.reused
          ? `✅ introduce_npc: Existing character "${result.npc?.name}" reused (no duplicate). npcId="${result.npcId}" — use this ID in npc_speak calls`
          : `✅ introduce_npc: NPC "${result.npc?.name}" created. npcId="${result.npcId}" — use this ID in npc_speak calls`;
      case 'remove_npc_from_scene':
        return `✅ remove_npc_from_scene: "${result.npcName}" removed from current scene (still a known character for future scenes)`;
      case 'modify_hp':
        return `✅ modify_hp: HP updated → ${result.newHp}/${result.maxHp}${result.isDead ? ` — PC IS DOWN (0 HP)${result.needsDeathSaves ? ' — DEATH SAVES ACTIVE: call roll_death_save each round until stable or dead' : ''}` : ''}`;
      case 'roll_death_save': {
        const icons = `${result.successes}✓ / ${result.failures}✗`;
        if (result.outcome === 'dead')             return `💀 roll_death_save(${result.charName}): rolled ${result.roll} — THREE FAILURES — ${result.charName} has DIED`;
        if (result.outcome === 'stable')           return `💚 roll_death_save(${result.charName}): rolled ${result.roll} — THREE SUCCESSES — ${result.charName} is now STABLE`;
        if (result.outcome === 'critical_success') return `⭐ roll_death_save(${result.charName}): rolled 20! — MIRACULOUS RECOVERY — ${result.charName} regains 1 HP and stands!`;
        if (result.outcome === 'critical_fail')    return `💀 roll_death_save(${result.charName}): rolled 1! — CRITICAL FAIL — two failures added (${icons})`;
        if (result.outcome === 'success')          return `✅ roll_death_save(${result.charName}): rolled ${result.roll} — SUCCESS (${icons})`;
        return `❌ roll_death_save(${result.charName}): rolled ${result.roll} — FAIL (${icons})`;
      }
      case 'modify_gold':
        return `✅ modify_gold: Gold → ${result.newGold} gp (${result.delta >= 0 ? '+' : ''}${result.delta})`;
      case 'modify_xp':
        return `✅ modify_xp: XP → ${result.newXp} (${result.delta >= 0 ? '+' : ''}${result.delta})`;
      case 'add_item':
        return `✅ add_item: "${result.itemName}" added to inventory`;
      case 'remove_item':
        return `✅ remove_item: "${result.itemName}" removed from inventory`;
      case 'add_condition':
        return `✅ add_condition: Active conditions → [${(result.conditions || []).join(', ') || 'none'}]`;
      case 'remove_condition':
        return `✅ remove_condition: Active conditions → [${(result.conditions || []).join(', ') || 'none'}]`;
      case 'set_npc_stat':
        return result.newHp !== undefined
          ? `✅ set_npc_stat: NPC HP → ${result.newHp}/${result.maxHp}`
          : `✅ set_npc_stat: ${result.stat} set to ${result.value}`;
      case 'get_character_stat':
        return `ℹ️ ${params.stat} = ${result.value}`;
      case 'get_character_stats':
        return `ℹ️ ${result.name || 'Character'}: HP ${result.hp}/${result.maxHp} | AC ${result.ac} | Gold ${result.gold} gp | XP ${result.xp} | Conditions: [${(result.conditions || []).join(', ') || 'none'}]`;
      case 'get_full_character': {
        const inv = Array.isArray(result.inventory) && result.inventory.length
          ? result.inventory.map(i => `${i.name} ×${i.quantity}`).join(', ')
          : 'empty';
        return `ℹ️ Full sheet for ${result.name}: Lv${result.level} ${result.race} ${result.class} | HP ${result.hp}/${result.maxHp} | AC ${result.ac} | STR${result.strength} DEX${result.dexterity} CON${result.constitution} INT${result.intelligence} WIS${result.wisdom} CHA${result.charisma} | Gold ${result.gold} gp | XP ${result.xp} | Inventory: ${inv} | Skills: ${(result.skills || []).join(', ') || 'none'} | Conditions: [${(result.conditions || []).join(', ') || 'none'}] | Backstory: ${(result.backstory || '').slice(0, 200)}`;
      }
      case 'get_character_inventory':
        return `ℹ️ Inventory: ${Array.isArray(result) ? (result.map(i => `${i.name} ×${i.quantity}`).join(', ') || 'empty') : JSON.stringify(result)}`;
      case 'get_npc_details':
        return `ℹ️ NPC ${result.name} (${result.role}): HP ${result.hp}/${result.maxHp} | AC ${result.ac} | Conditions: [${(result.conditions || []).join(', ') || 'none'}] | Personality: ${result.personality} | Appearance: ${result.appearance} | Backstory: ${(result.backstory || '').slice(0, 200)}`;
      case 'get_adventure_log':
        return `ℹ️ Adventure log for ${result.name}: ${(result.log || []).slice(-10).join(' | ') || 'No entries'}`;
      case 'get_scene_history': {
        const scenes = (result.scenes || []).map(s =>
          `[${s.completed ? '✓' : s.isCurrent ? '▶' : '○'}] Scene ${s.index + 1}: ${s.title}`
        ).join(' → ');
        return `ℹ️ Scene history: ${scenes}`;
      }
      case 'advance_scene':
        return `✅ advance_scene: New scene started (sceneId="${result.newSceneId}")`;
      case 'refresh_scene_image':
        return `✅ refresh_scene_image: Scene image queued for regeneration`;
      case 'npc_speak':
        return `✅ npc_speak: Dialogue recorded for "${result.npcName}"`;
      case 'log_event':
        return `✅ log_event: Adventure log updated`;
      case 'compress_history':
        return `✅ compress_history: ${result.compressedCount} older messages compressed into adventure summary; the ${result.keptCount} most recent messages are kept verbatim. Continue from this fresh context.`;
      case 'create_quest': {
        const objs = (result.quest?.objectives || []).map((o, i) => `${i}. ${o.text}`).join(' | ');
        return `✅ create_quest: Quest "${result.quest?.title}" created (questId="${result.questId}") — Objectives: ${objs || 'none'}`;
      }
      case 'update_quest_objective':
        return `✅ update_quest_objective: "${result.objectiveText}" → ${result.done ? 'DONE ✓' : 'not done'} (Quest: ${result.questTitle})`;
      case 'complete_quest':
        return `✅ complete_quest: Quest "${result.questTitle}" marked as ${result.status.toUpperCase()}`;
      case 'get_quests': {
        const quests = result.quests || [];
        const active = quests.filter(q => q.status === 'active').map(q => `"${q.title}"`).join(', ');
        const done   = quests.filter(q => q.status !== 'active').length;
        return `ℹ️ Quests — Active: ${active || 'none'} | Completed/Failed: ${done}`;
      }
      case 'start_combat': {
        const order = (result.order || []).join(' | ');
        return `⚔️ start_combat: Combat begins! Initiative order: ${order}`;
      }
      case 'end_combat':
        return `✅ end_combat: Combat ended.`;
      case 'next_turn': {
        const p = result.currentParticipant;
        return `⏭️ next_turn: Round ${result.round} — ${p?.name || '?'}'s turn (Initiative: ${p?.initiative})${p?.hp !== undefined ? ` | HP: ${p.hp}/${p.maxHp}` : ''}`;
      }
      case 'check_concentration': {
        const modStr = result.conMod >= 0 ? `+${result.conMod}` : `${result.conMod}`;
        if (result.success) return `✅ check_concentration(${result.charName}): rolled ${result.roll}${modStr}=${result.total} vs DC ${result.dc} — SUCCESS, maintaining ${result.maintaining}`;
        return `❌ check_concentration(${result.charName}): rolled ${result.roll}${modStr}=${result.total} vs DC ${result.dc} — FAILED, concentration on ${result.lostConcentration} broken`;
      }
      case 'drop_concentration':
        return `✅ drop_concentration(${result.charName}): ${result.dropped ? `Dropped ${result.dropped}` : 'Not concentrating'}`;
      case 'short_rest': {
        const rollStr = (result.rolls || []).join(', ');
        const conModStr = result.conMod >= 0 ? `+${result.conMod}` : `${result.conMod}`;
        return `✅ short_rest(${result.charName}): Spent ${result.diceSpent}×${result.hitDie}${conModStr} [${rollStr}] → healed ${result.healed} HP (now ${result.newHp}/${result.maxHp}) | Hit dice left: ${result.diceAvailable}`;
      }
      case 'long_rest': {
        let restMsg = `✅ long_rest(${result.charName}): Full rest — HP ${result.newHp}/${result.maxHp} | Spell slots: ${result.spellSlots} | Hit dice restored: ${result.hitDiceRestored} (${result.hitDiceAvailable}/${result.hitDiceTotal} available)`;
        if (result.droppedConcentration) restMsg += ` | Dropped concentration on ${result.droppedConcentration}`;
        return restMsg;
      }
      case 'give_inspiration':
        return `✅ give_inspiration(${result.charName}): Inspiration awarded${result.reason ? ` — ${result.reason}` : ''}`;
      case 'use_inspiration':
        return result.hadInspiration
          ? `✅ use_inspiration(${result.charName}): Inspiration used — roll with advantage!`
          : `❌ use_inspiration(${result.charName}): No Inspiration to use`;
      default:
        return `✅ ${tool}: ${JSON.stringify(result).slice(0, 120)}`;
    }
  }).join('\n');
}

// ── Tool executor ─────────────────────────────────────────────

/**
 * Execute an array of tool calls parsed from the DM response.
 *
 * Dependency resolution — the DM can't know generated UUIDs before tools run,
 * so it sometimes uses placeholder IDs.  We fix this in two ways:
 *
 *  1. Same-batch:  if create_item and add_item (or introduce_npc and npc_speak)
 *     appear in the same turn, the producer runs first (sequential for-loop),
 *     then the consumer's ID is patched before it executes.
 *
 *  2. Cross-iteration: an optional sessionContext object (created once per
 *     sendDMMessage call and passed here each iteration) remembers the IDs from
 *     the most recent produce-tools so a stale/wrong ID in a later turn still
 *     resolves correctly — without any extra Gemini API calls.
 *
 * @param {Object[]} toolCalls
 * @param {{ lastCreatedItemId: string|null, lastIntroducedNpcId: string|null, lastCreatedSpellId: string|null }|null} sessionContext
 * @returns {Promise<Array<{tool:string, params:Object, result:any}>>}
 */
export async function executeDMTools(toolCalls, sessionContext = null) {
  const results = [];

  // Seed from cross-iteration context (may be null on first iteration)
  let lastCreatedItemId   = sessionContext?.lastCreatedItemId   ?? null;
  let lastIntroducedNpcId = sessionContext?.lastIntroducedNpcId ?? null;
  let lastCreatedSpellId  = sessionContext?.lastCreatedSpellId  ?? null;

  for (const call of toolCalls) {
    // ── Resolve add_item / remove_item → create_item dependency ──
    if ((call.tool === 'add_item' || call.tool === 'remove_item') && call.itemId && lastCreatedItemId) {
      if (!db.getItem(call.itemId)) {
        console.warn(`[dm-tools] ${call.tool}: itemId "${call.itemId}" not in cache — substituting last created item "${lastCreatedItemId}"`);
        call.itemId = lastCreatedItemId;
      }
    }

    // ── Resolve give_spell → create_spell dependency ─────────────
    if (call.tool === 'give_spell' && call.spellId && lastCreatedSpellId) {
      if (!db.getSpell(call.spellId)) {
        console.warn(`[dm-tools] give_spell: spellId "${call.spellId}" not in cache — substituting last created spell "${lastCreatedSpellId}"`);
        call.spellId = lastCreatedSpellId;
      }
    }

    // ── Resolve npc_speak → introduce_npc dependency ─────────────
    if (call.tool === 'npc_speak' && call.npcId && lastIntroducedNpcId) {
      if (!db.getCharacter(call.npcId)) {
        console.warn(`[dm-tools] npc_speak: npcId "${call.npcId}" not in cache — substituting last introduced NPC "${lastIntroducedNpcId}"`);
        call.npcId = lastIntroducedNpcId;
      }
    }

    const fn = DM_TOOLS[call.tool];
    if (!fn) {
      results.push({ tool: call.tool, params: call, result: { error: `Unknown tool: ${call.tool}` } });
      continue;
    }
    try {
      const result = await fn(call);

      // Track produced IDs for downstream resolution (same-batch and cross-iteration)
      if (call.tool === 'create_item' && result.itemId && !result.error) {
        lastCreatedItemId = result.itemId;
        if (sessionContext) sessionContext.lastCreatedItemId = result.itemId;
      }
      if (call.tool === 'introduce_npc' && result.npcId && !result.error) {
        lastIntroducedNpcId = result.npcId;
        if (sessionContext) sessionContext.lastIntroducedNpcId = result.npcId;
      }
      if (call.tool === 'create_spell' && result.spellId && !result.error) {
        lastCreatedSpellId = result.spellId;
        if (sessionContext) sessionContext.lastCreatedSpellId = result.spellId;
      }

      results.push({ tool: call.tool, params: call, result });
    } catch (err) {
      results.push({ tool: call.tool, params: call, result: { error: err.message } });
    }
  }
  return results;
}

/**
 * Build a human-readable summary of a tool call result for the chat UI.
 * @param {string} tool
 * @param {Object} params
 * @param {Object} result
 * @returns {string}
 */
export function toolResultSummary(tool, params, result) {
  if (result?.error) return `⚠️ Tool "${tool}" failed: ${result.error}`;

  const charName = () => {
    const c = db.getCharacter(params.characterId);
    return c?.name || 'Character';
  };

  switch (tool) {
    case 'roll_dice': {
      const flag  = result.isCrit ? ' ⚡ Critical!' : result.isCritFail ? ' 💀 Fumble!' : '';
      const label = params.reason ? ` (${params.reason})` : '';
      return `🎲 ${result.notation}${label}: **${result.total}**${flag}`;
    }
    case 'modify_hp': {
      const name   = charName();
      const amount = Math.abs(params.delta);
      const hpStr  = `${result.newHp}/${result.maxHp} HP`;
      if (result.isDead && result.needsDeathSaves) return `💀 ${name} is down! Death saving throws begin…`;
      if (result.isDead) return `💀 ${name} has fallen to 0 HP!`;
      return params.delta < 0
        ? `⚔️ ${name} takes ${amount} damage (${hpStr})${params.reason ? ' — ' + params.reason : ''}`
        : `❤️ ${name} heals ${amount} HP (${hpStr})`;
    }
    case 'roll_death_save': {
      const name = result.charName || charName();
      if (result.outcome === 'dead')             return `💀 ${name}: Death Save — rolled ${result.roll} — DIED (3 failures)`;
      if (result.outcome === 'stable')           return `💚 ${name}: Death Save — rolled ${result.roll} — STABLE (3 successes)`;
      if (result.outcome === 'critical_success') return `⭐ ${name}: Death Save — rolled 20! — Miraculous recovery! Regains 1 HP`;
      if (result.outcome === 'critical_fail')    return `💀 ${name}: Death Save — rolled 1! — Two failures (${result.successes}✓ ${result.failures}✗)`;
      if (result.outcome === 'success')          return `✅ ${name}: Death Save — rolled ${result.roll} — success (${result.successes}✓ ${result.failures}✗)`;
      return `❌ ${name}: Death Save — rolled ${result.roll} — fail (${result.successes}✓ ${result.failures}✗)`;
    }
    case 'modify_gold': {
      const name = charName();
      return `💰 ${name} ${params.delta >= 0 ? 'earns' : 'spends'} ${Math.abs(params.delta)} gp (now ${result.newGold} gp)`;
    }
    case 'modify_xp': {
      const name = charName();
      return `⭐ ${name} ${params.delta >= 0 ? 'gains' : 'loses'} ${Math.abs(params.delta)} XP (now ${result.newXp} XP)`;
    }
    case 'add_item':
      return `🎒 ${charName()} receives: ${result.itemName}`;
    case 'remove_item':
      return `🎒 ${charName()} loses: ${result.itemName}`;
    case 'add_condition':
      return `⚡ ${charName()} gains condition: ${params.condition}`;
    case 'remove_condition':
      return `✨ ${charName()} loses condition: ${params.condition}`;
    case 'set_npc_stat': {
      const npc = params.npcId ? db.getCharacter(params.npcId) : db.getNPCByName(params.npcName || '');
      const name = npc?.name || 'NPC';
      if (result.newHp !== undefined) {
        return result.isDead
          ? `💀 ${name} has fallen!`
          : `⚔️ ${name} HP → ${result.newHp}/${result.maxHp}`;
      }
      return `🔧 ${name}: ${params.stat} updated`;
    }
    case 'advance_scene':
      return `🗺️ Scene advances: ${params.newSceneTitle || 'New Scene'}`;
    case 'refresh_scene_image':
      return `🖼️ Scene image updating…`;
    case 'create_spell':
      return `✨ New spell created: ${result.spell?.name || params.name} (Level ${result.spell?.level ?? 0})`;
    case 'give_spell':
      return `📖 ${result.charName} learns: ${result.spellName}`;
    case 'remove_spell':
      return `📖 Spell forgotten: ${result.spellName}`;
    case 'use_spell_slot': {
      let castMsg = `✨ ${result.charName} casts${result.spellName ? ` ${result.spellName}` : ''} (L${result.slotLevel} slot — ${result.remaining} left)`;
      if (result.concentration) castMsg += ` 🔮 Concentrating`;
      if (result.droppedConcentration) castMsg += ` (ended ${result.droppedConcentration})`;
      return castMsg;
    }
    case 'restore_spell_slots':
      return `🌙 ${result.charName} recovers spell slots`;
    case 'get_spell_slots':
      return ''; // read-only, no badge
    case 'create_item':
      return `🌟 New item created: ${result.item?.name || params.name}`;
    case 'log_event':
      return `📜 Adventure log updated`;
    case 'introduce_npc':
      return result.reused
        ? `🎭 ${result.npc?.name || params.name} returns to the scene`
        : `🎭 ${result.npc?.name || params.name} enters the story`;
    case 'remove_npc_from_scene':
      return `🚪 ${result.npcName || params.npcName || 'NPC'} leaves the scene`;
    case 'npc_speak':
      return ''; // NPC speech renders as its own bubble
    case 'compress_history':
      return `📜 History compressed (${result.compressedCount} messages → summary, ${result.keptCount} recent kept)`;
    case 'create_quest':
      return `📋 New quest: ${result.quest?.title || params.title}`;
    case 'update_quest_objective':
      return `📋 Quest objective ${result.done ? 'completed' : 'updated'}: ${result.objectiveText || ''}`;
    case 'complete_quest':
      return `📋 Quest ${result.status}: ${result.questTitle || params.questId}`;
    case 'get_quests':
      return '';
    case 'start_combat': {
      const first = result.combat?.participants?.[0];
      return `⚔️ Combat begins! Round 1 — ${first?.name || '?'} goes first`;
    }
    case 'end_combat':
      return `✅ Combat ended`;
    case 'next_turn': {
      const p = result.currentParticipant;
      return `⏭️ Round ${result.round} — ${p?.name || '?'}'s turn`;
    }
    case 'check_concentration':
      return result.success
        ? `🔮 ${result.charName} maintains ${result.maintaining} (CON save ${result.total} ≥ DC ${result.dc})`
        : `💔 ${result.charName} loses concentration on ${result.lostConcentration}! (CON save ${result.total} < DC ${result.dc})`;
    case 'drop_concentration':
      return result.dropped
        ? `🔮 ${result.charName} drops concentration on ${result.dropped}`
        : '';
    case 'short_rest':
      return `💤 ${result.charName} short rests — heals ${result.healed} HP (now ${result.newHp}/${result.maxHp})`;
    case 'long_rest':
      return `🌙 ${result.charName} takes a long rest — fully restored`;
    case 'give_inspiration':
      return `✦ ${result.charName} gains Inspiration!${result.reason ? ' — ' + result.reason : ''}`;
    case 'use_inspiration':
      return result.hadInspiration ? `✦ ${result.charName} uses Inspiration for advantage!` : '';
    // Read tools produce no visible badge — they're internal DM actions
    case 'get_character_stats':
    case 'get_full_character':
    case 'get_character_inventory':
    case 'get_character_stat':
    case 'get_npc_details':
    case 'get_adventure_log':
    case 'get_scene_history':
      return '';
    default:
      return `🔧 Tool executed: ${tool}`;
  }
}
