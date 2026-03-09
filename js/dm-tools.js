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
 *  COMBAT  enter_combat, end_combat, next_turn, skip_turn,
 *          use_action, use_bonus_action, use_reaction, use_movement,
 *          action_surge, add_to_combat, remove_from_combat, set_initiative, get_combat_state
 *  QUEST   create_quest, update_quest_objective, complete_quest, get_quests
 *  META    compress_history
 */

import * as db from './db.js';
import { geminiGenerate } from './api-gemini.js';
import { generateIconBase64 } from './api-image.js';
import { uuid, getBaseSpellSlots } from './utils.js';

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

// ── Combat helper ─────────────────────────────────────────────

/**
 * Add an NPC to an active combat initiative order, rolling initiative for them.
 * Called automatically by introduce_npc (for enemy/boss/creature roles) and
 * by enter_combat (for scene enemies not explicitly listed).
 *
 * @param {import('./db.js').Character} npc
 * @param {string} storyId
 * @param {number|null} [initiativeOverride] - use this value instead of rolling
 * @returns {number|null} rolled/assigned initiative, or null if not joined
 */
function autoJoinCombat(npc, storyId, initiativeOverride = null) {
  if (!storyId) return null;
  const story = db.getStory(storyId);
  if (!story?.combat?.active) return null;

  // Already in the order?
  if (story.combat.initiativeOrder.some(e => e.characterId === npc.id)) return null;

  const dexMod    = Math.floor(((npc.stats?.dexterity || 10) - 10) / 2);
  const initiative = initiativeOverride ?? (Math.floor(Math.random() * 20) + 1 + dexMod);
  const moveMax   = npc.stats?.speed || npc.movementSpeed || 30;

  story.combat.initiativeOrder.push({
    characterId:       npc.id,
    name:              npc.name,
    isNPC:             true,
    initiative,
    hasAction:         true,
    hasBonusAction:    true,
    hasReaction:       true,
    hasExtraAction:    false,
    movementRemaining: moveMax,
    movementMax:       moveMax,
    isAlive:           true,
  });

  // Re-sort by initiative descending; tiebreak by DEX
  story.combat.initiativeOrder.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    const ca = db.getCharacter(a.characterId);
    const cb = db.getCharacter(b.characterId);
    return ((cb?.stats?.dexterity || 10) - (ca?.stats?.dexterity || 10));
  });

  db.saveStory(story);
  return initiative;
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
    // Also mark them as dead in the active combat initiative order.
    if (isDead) {
      const allStories = db.getAllStories();
      for (const story of allStories) {
        let storyChanged = false;

        // Remove dead NPC from scene npcs / add to deadNpcs
        if (char.isNPC) {
          const currentScene = story.scenes[story.currentSceneIndex];
          if (currentScene?.npcs?.includes(char.id)) {
            currentScene.npcs = currentScene.npcs.filter(id => id !== char.id);
            if (!currentScene.deadNpcs) currentScene.deadNpcs = [];
            if (!currentScene.deadNpcs.includes(char.id)) {
              currentScene.deadNpcs.push(char.id);
            }
            storyChanged = true;
          }
        }

        // Auto-mark the combatant as isAlive=false in the initiative order.
        // PCs at 0 HP stay isAlive=true — they still need death save turns.
        // Only NPCs (no death saves) or PCs with 'Dead' condition are truly out.
        if (story.combat?.active) {
          const combatEntry = story.combat.initiativeOrder.find(e => e.characterId === char.id);
          if (combatEntry && combatEntry.isAlive && (char.isNPC || char.conditions?.includes('Dead'))) {
            combatEntry.isAlive = false;
            storyChanged = true;
          }
        }

        if (storyChanged) db.saveStory(story);
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

    // If a PC is healed above 0 HP, clear death saves and unconscious state,
    // and restore their isAlive flag in any active combat initiative order.
    if (!isDead && !char.isNPC && char.deathSaves) {
      char.deathSaves = null;
      char.conditions = char.conditions.filter(c => c !== 'Unconscious' && c !== 'Stable');
      db.saveCharacter(char);

      // Restore isAlive in initiative order so they can take turns again
      const allStories = db.getAllStories();
      for (const story of allStories) {
        if (story.combat?.active) {
          const combatEntry = story.combat.initiativeOrder.find(e => e.characterId === char.id);
          if (combatEntry && !combatEntry.isAlive) {
            combatEntry.isAlive = true;
            db.saveStory(story);
          }
        }
      }
    }

    // Report alive counts when in active combat so the DM knows when to call end_combat.
    let combatAliveCounts = null;
    {
      const allStories = db.getAllStories();
      for (const story of allStories) {
        if (story.combat?.active) {
          const inCombat = story.combat.initiativeOrder.some(e => e.characterId === char.id);
          if (inCombat) {
            const alive = story.combat.initiativeOrder.filter(e => e.isAlive);
            combatAliveCounts = {
              aliveNPCs: alive.filter(e =>  e.isNPC).length,
              alivePCs:  alive.filter(e => !e.isNPC).length,
            };
            break;
          }
        }
      }
    }

    return {
      newHp:  char.stats.hp,
      maxHp:  char.stats.maxHp,
      delta:  params.delta,
      isDead,
      needsDeathSaves,
      reason: params.reason || '',
      ...(combatAliveCounts ?? {}),
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

        // Mark the PC as out of the initiative order — three failures = truly dead
        const allStories = db.getAllStories();
        for (const story of allStories) {
          if (story.combat?.active) {
            const combatEntry = story.combat.initiativeOrder.find(e => e.characterId === char.id);
            if (combatEntry && combatEntry.isAlive) {
              combatEntry.isAlive = false;
              db.saveStory(story);
            }
          }
        }
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
        // Auto-join combat if it's active and this NPC is combat-relevant
        const combatRoles = ['enemy', 'boss', 'creature'];
        const joinedInitiative = combatRoles.includes(role) ? autoJoinCombat(duplicate, storyId) : null;
        return {
          npcId: duplicate.id,
          npc:   duplicate,
          reused: true,
          note:  `Existing character "${duplicate.name}" (ID: ${duplicate.id}) reused — no duplicate created.`,
          ...(joinedInitiative !== null ? { autoJoinedCombat: true, initiative: joinedInitiative } : {}),
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

    // Auto-join active combat if this NPC is a combat-relevant role
    const combatRoles = ['enemy', 'boss', 'creature'];
    const joinedInitiative = combatRoles.includes(role) ? autoJoinCombat(npc, storyId) : null;

    return {
      npcId: npc.id,
      npc,
      ...(joinedInitiative !== null ? { autoJoinedCombat: true, initiative: joinedInitiative } : {}),
    };
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
   */
  use_spell_slot(params) {
    const result = db.useSpellSlot(params.characterId, Number(params.slotLevel));
    if (!result.ok) return { error: result.error };
    const char = db.getCharacter(params.characterId);
    return {
      success:    true,
      slotLevel:  params.slotLevel,
      remaining:  result.remaining,
      charName:   char?.name || params.characterId,
      spellName:  params.spellName || '',
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

  // ─── COMBAT tools ──────────────────────────────────────────

  /**
   * Start a combat encounter. Rolls initiative (1d20 + DEX mod) for all
   * participants, sorts them into initiative order, and stores the state
   * inside story.combat.
   *
   * All PCs in story.characterIds are included automatically.
   * NPCs/enemies must be listed explicitly via params.npcIds.
   *
   * params:
   *   storyId             {string}   — required
   *   npcIds              {string[]} — IDs of NPCs/enemies joining combat
   *   initiativeOverrides {Object}   — { characterId: initiativeTotal } to skip rolling
   */
  enter_combat(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    if (story.combat?.active) return { error: 'Combat already active. Call end_combat first.' };

    const pcIds     = story.characterIds  || [];
    const npcIds    = [...(params.npcIds  || [])];
    const overrides = params.initiativeOverrides || {};

    // ── Auto-include any enemy/boss/creature NPCs already in the current scene
    // that the DM forgot (or hadn't yet got IDs for) in their npcIds list.
    // This is the #1 source of "combatant not found" errors.
    const currentScene = story.scenes[story.currentSceneIndex];
    const autoAddedNames = [];
    if (currentScene?.npcs) {
      for (const sceneNpcId of currentScene.npcs) {
        if (!npcIds.includes(sceneNpcId)) {
          const sceneNpc = db.getCharacter(sceneNpcId);
          if (sceneNpc && ['enemy', 'boss', 'creature'].includes(sceneNpc.npcRole)) {
            npcIds.push(sceneNpcId);
            autoAddedNames.push(sceneNpc.name);
          }
        }
      }
    }

    const allIds = [...new Set([...pcIds, ...npcIds])];

    const entries = [];
    for (const id of allIds) {
      const char = db.getCharacter(id);
      if (!char) continue;
      // PCs at 0 HP still need death save turns; only skip NPCs (or confirmed Dead PCs)
      if (char.stats.hp <= 0 && (char.isNPC || char.conditions?.includes('Dead'))) continue;

      const dexMod  = Math.floor(((char.stats.dexterity || 10) - 10) / 2);
      const roll    = (id in overrides)
        ? Number(overrides[id])
        : Math.floor(Math.random() * 20) + 1 + dexMod;
      const moveMax = char.stats.speed || char.movementSpeed || 30;

      entries.push({
        characterId:       id,
        name:              char.name,
        isNPC:             char.isNPC || false,
        initiative:        roll,
        hasAction:         true,
        hasBonusAction:    true,
        hasReaction:       true,
        hasExtraAction:    false,
        movementRemaining: moveMax,
        movementMax:       moveMax,
        isAlive:           true,
      });
    }

    // Sort by initiative desc; tiebreak by DEX score desc
    entries.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      const ca = db.getCharacter(a.characterId);
      const cb = db.getCharacter(b.characterId);
      return ((cb?.stats?.dexterity || 10) - (ca?.stats?.dexterity || 10));
    });

    story.combat = {
      active:           true,
      round:            1,
      initiativeOrder:  entries,
      currentTurnIndex: 0,
      startedAt:        Date.now(),
    };
    db.saveStory(story);

    return {
      message:         'Combat started!',
      round:           1,
      currentTurn:     entries[0]?.name || '—',
      initiativeOrder: entries.map((e, i) => ({
        position:   i + 1,
        name:       e.name,
        initiative: e.initiative,
        isNPC:      e.isNPC,
        isCurrent:  i === 0,
      })),
      ...(autoAddedNames.length > 0 ? { autoAddedEnemies: autoAddedNames } : {}),
    };
  },

  /**
   * End the combat encounter and clear all combat state.
   * Call when: all enemies are defeated, party flees, or combat is otherwise resolved.
   */
  end_combat(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    if (!story.combat?.active) return { error: 'No active combat to end.' };

    story.combat = null;
    db.saveStory(story);
    return { message: 'Combat ended. All combatants return to normal activity.' };
  },

  /**
   * Advance to the next combatant in the initiative order.
   * Resets the incoming combatant's Action, Bonus Action, and movement.
   * Reactions reset for ALL when the round counter increments.
   *
   * ⚠️ IMPORTANT: Only call next_turn when the current combatant has used ALL
   * of their available actions (hasAction=false, hasExtraAction=false) AND
   * their bonus action (hasBonusAction=false), OR when there is genuinely
   * nothing more for them to do this turn.
   *
   * If the player/DM explicitly wants to end the turn while actions remain,
   * use skip_turn instead — it signals intentional forfeiture.
   *
   * The result includes a `warning` field if unused actions are detected.
   */
  next_turn(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    if (!story.combat?.active) return { error: 'No active combat.' };

    const combat = story.combat;
    const order  = combat.initiativeOrder;
    const total  = order.length;

    // Check if the current combatant still has actions/bonus actions remaining
    const prev = order[combat.currentTurnIndex];
    const wasted = [];
    if (prev?.isAlive) {
      if (prev.hasAction)      wasted.push('action');
      if (prev.hasExtraAction) wasted.push('extra action (Action Surge)');
      if (prev.hasBonusAction) wasted.push('bonus action');
    }

    // Advance index, skipping dead/removed combatants
    let nextIdx = (combat.currentTurnIndex + 1) % total;
    let guard   = 0;
    while (!order[nextIdx].isAlive && guard < total) {
      nextIdx = (nextIdx + 1) % total;
      guard++;
    }
    if (guard >= total) return { error: 'No alive combatants remain. Call end_combat.' };

    // Detect round wrap-around (we looped past the end of the order)
    const newRound = nextIdx <= combat.currentTurnIndex;
    if (newRound) {
      combat.round++;
      // Restore reactions for every living combatant at the top of a new round
      for (const entry of order) {
        if (entry.isAlive) entry.hasReaction = true;
      }
    }

    combat.currentTurnIndex = nextIdx;
    const current = order[nextIdx];

    // Reset action economy for the incoming combatant
    current.hasAction      = true;
    current.hasBonusAction = true;
    current.hasExtraAction = false;

    // Sync movement to the character's current speed
    const char    = db.getCharacter(current.characterId);
    const moveMax = char?.stats?.speed || char?.movementSpeed || 30;
    current.movementRemaining = moveMax;
    current.movementMax       = moveMax;

    db.saveStory(story);

    const result = {
      round:       combat.round,
      currentTurn: current.name,
      characterId: current.characterId,
      isNPC:       current.isNPC,
      newRound,
      actions: {
        hasAction:         current.hasAction,
        hasBonusAction:    current.hasBonusAction,
        hasReaction:       current.hasReaction,
        movementRemaining: current.movementRemaining,
      },
    };

    if (wasted.length > 0) {
      result.warning = `⚠️ ${prev.name} ended their turn with unused ${wasted.join(' + ')} remaining. If this was intentional, use skip_turn in future to signal deliberate forfeiture.`;
    }

    return result;
  },

  /**
   * Explicitly skip (forfeit) the current combatant's turn even if they have
   * actions or bonus actions remaining.
   *
   * Use this when:
   *   • The player says "I skip my turn" / "I pass" / "I end my turn early"
   *   • The DM decides an NPC forfeits its remaining actions (e.g. stunned resolve,
   *     tactical retreat decision, incapacitated-but-alive condition)
   *   • Any situation where deliberately ending a turn early is the intent
   *
   * params:
   *   storyId     {string}  — required
   *   characterId {string}  — optional; if omitted, skips the current active combatant
   *   reason      {string}  — optional description of why the turn is being skipped
   */
  skip_turn(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    if (!story.combat?.active) return { error: 'No active combat.' };

    const combat = story.combat;
    const order  = combat.initiativeOrder;
    const total  = order.length;

    // Determine whose turn to skip
    let skipIdx = combat.currentTurnIndex;
    if (params.characterId) {
      const idx = order.findIndex(e => e.characterId === params.characterId);
      if (idx === -1) return { error: 'Combatant not found in initiative order.' };
      skipIdx = idx;
    }

    const skipped = order[skipIdx];
    if (!skipped.isAlive) return { error: `${skipped.name} is already dead/removed.` };

    // Record what was forfeited for the result
    const forfeited = [];
    if (skipped.hasAction)      forfeited.push('action');
    if (skipped.hasExtraAction) forfeited.push('extra action (Action Surge)');
    if (skipped.hasBonusAction) forfeited.push('bonus action');

    // Clear all action economy flags on the skipped combatant
    skipped.hasAction      = false;
    skipped.hasBonusAction = false;
    skipped.hasExtraAction = false;

    // Advance to the next living combatant
    let nextIdx = (skipIdx + 1) % total;
    let guard   = 0;
    while (!order[nextIdx].isAlive && guard < total) {
      nextIdx = (nextIdx + 1) % total;
      guard++;
    }
    if (guard >= total) return { error: 'No alive combatants remain. Call end_combat.' };

    const newRound = nextIdx <= skipIdx;
    if (newRound) {
      combat.round++;
      for (const entry of order) {
        if (entry.isAlive) entry.hasReaction = true;
      }
    }

    combat.currentTurnIndex = nextIdx;
    const current = order[nextIdx];

    // Reset action economy for the incoming combatant
    current.hasAction      = true;
    current.hasBonusAction = true;
    current.hasExtraAction = false;

    const char    = db.getCharacter(current.characterId);
    const moveMax = char?.stats?.speed || char?.movementSpeed || 30;
    current.movementRemaining = moveMax;
    current.movementMax       = moveMax;

    db.saveStory(story);

    return {
      skippedName:    skipped.name,
      forfeited:      forfeited.length > 0 ? forfeited : ['nothing (turn was already spent)'],
      reason:         params.reason || 'Turn skipped by request',
      round:          combat.round,
      currentTurn:    current.name,
      characterId:    current.characterId,
      isNPC:          current.isNPC,
      newRound,
      actions: {
        hasAction:         current.hasAction,
        hasBonusAction:    current.hasBonusAction,
        hasReaction:       current.hasReaction,
        movementRemaining: current.movementRemaining,
      },
    };
  },

  /**
   * Mark the current combatant's Action as used.
   * If Action Surge is active (hasExtraAction=true), the extra action is
   * consumed first; the base action is preserved for that iteration.
   *
   * Call BEFORE narrating the result of any action
   * (Attack, Cast Spell, Dash, Disengage, Dodge, Help, Hide, Ready, etc.).
   * For Extra Attack: call use_action ONCE for the full Attack action,
   * not once per individual attack roll.
   */
  use_action(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat.' };

    const entry = story.combat.initiativeOrder.find(e => e.characterId === params.characterId);
    if (!entry) return { error: 'Combatant not found in initiative order.' };
    if (!entry.hasAction && !entry.hasExtraAction) {
      return { error: `${entry.name} has no actions remaining this turn.` };
    }

    if (entry.hasExtraAction) {
      entry.hasExtraAction = false; // burn extra action (Action Surge) first
    } else {
      entry.hasAction = false;
    }

    db.saveStory(story);
    return {
      name:           entry.name,
      hasAction:      entry.hasAction,
      hasExtraAction: entry.hasExtraAction,
      hasBonusAction: entry.hasBonusAction,
    };
  },

  /**
   * Mark the current combatant's Bonus Action as used.
   * Bonus actions are ONLY available when a class feature or spell explicitly
   * grants one (e.g. off-hand TWF attack, Misty Step, Cunning Action, Wild Shape,
   * Bardic Inspiration, Second Wind for some builds, etc.).
   * You cannot "save" a bonus action for later — if unused, it is simply lost.
   */
  use_bonus_action(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat.' };

    const entry = story.combat.initiativeOrder.find(e => e.characterId === params.characterId);
    if (!entry) return { error: 'Combatant not found in initiative order.' };
    if (!entry.hasBonusAction) {
      return { error: `${entry.name} has already used their bonus action this turn.` };
    }

    entry.hasBonusAction = false;
    db.saveStory(story);
    return { name: entry.name, hasAction: entry.hasAction, hasBonusAction: entry.hasBonusAction };
  },

  /**
   * Mark a combatant's Reaction as used.
   * Reactions reset at the START of each new round — NOT each turn.
   * A reaction can be triggered on ANY combatant's turn (not just your own).
   * Examples: Opportunity Attack, Shield spell, Counterspell, Uncanny Dodge,
   *           Hellish Rebuke, Absorb Elements, Parry (Battle Master).
   */
  use_reaction(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat.' };

    const entry = story.combat.initiativeOrder.find(e => e.characterId === params.characterId);
    if (!entry) return { error: 'Combatant not found in initiative order.' };
    if (!entry.hasReaction) {
      return { error: `${entry.name} has already used their reaction this round.` };
    }

    entry.hasReaction = false;
    db.saveStory(story);
    return {
      name:        entry.name,
      hasReaction: entry.hasReaction,
      note:        'Reaction restores at the start of the next round.',
    };
  },

  /**
   * Track movement used by a combatant this turn (in feet).
   * Movement can be split: some before the action and some after.
   * Full movement speed is restored at the start of each of their turns.
   * Difficult terrain costs 2ft of movement per 1ft moved.
   *
   * params: { storyId, characterId, feet }
   */
  use_movement(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat.' };

    const entry = story.combat.initiativeOrder.find(e => e.characterId === params.characterId);
    if (!entry) return { error: 'Combatant not found in initiative order.' };

    const feet = Number(params.feet) || 5;
    if (feet > entry.movementRemaining) {
      return {
        error:             `Not enough movement. ${entry.name} only has ${entry.movementRemaining}ft remaining this turn.`,
        movementRemaining: entry.movementRemaining,
      };
    }

    entry.movementRemaining -= feet;
    db.saveStory(story);
    return {
      name:              entry.name,
      feetUsed:          feet,
      movementRemaining: entry.movementRemaining,
      movementMax:       entry.movementMax,
    };
  },

  /**
   * Trigger a Fighter's Action Surge — grants ONE additional Action this turn.
   * Per 5e rules: usable once per short or long rest (twice at Fighter level 17+).
   * The DM must verify the character is a Fighter with this feature available.
   * Cannot be granted if hasExtraAction is already true.
   */
  action_surge(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat.' };

    const entry = story.combat.initiativeOrder.find(e => e.characterId === params.characterId);
    if (!entry) return { error: 'Combatant not found in initiative order.' };
    if (entry.hasExtraAction) {
      return { error: `${entry.name} already has an extra action queued this turn.` };
    }

    entry.hasExtraAction = true;
    db.saveStory(story);
    return {
      name:           entry.name,
      message:        `Action Surge! ${entry.name} gains an extra action this turn.`,
      hasAction:      entry.hasAction,
      hasExtraAction: entry.hasExtraAction,
    };
  },

  /**
   * Remove a combatant from the initiative order permanently.
   * Use for: permanent fleeing from the battlefield, petrification that
   * removes them from the fight, or extraordinary circumstances.
   * Death is handled automatically by modify_hp — do NOT call this for death.
   *
   * Reports whether one side has been fully eliminated (suggests end_combat).
   */
  remove_from_combat(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat.' };

    const entry = story.combat.initiativeOrder.find(e => e.characterId === params.characterId);
    if (!entry) return { error: 'Combatant not found in initiative order.' };

    entry.isAlive = false;
    db.saveStory(story);

    const alive    = story.combat.initiativeOrder.filter(e => e.isAlive);
    const aliveNPC = alive.filter(e =>  e.isNPC).length;
    const alivePC  = alive.filter(e => !e.isNPC).length;

    return {
      removed:    entry.name,
      aliveNPCs:  aliveNPC,
      alivePCs:   alivePC,
      suggestion: aliveNPC === 0
        ? 'All enemies defeated! Consider calling end_combat.'
        : alivePC === 0
        ? 'All PCs are out! Consider calling end_combat.'
        : null,
    };
  },

  /**
   * Add a character or NPC to an already-active combat encounter.
   * Use this when a new enemy joins mid-fight (reinforcements, ambush from stealth, etc.)
   * or when you forgot to include an NPC in the original enter_combat call.
   *
   * Rolls initiative automatically (1d20 + DEX mod) unless you pass an override.
   * The combatant is inserted in the correct sorted position.
   *
   * params:
   *   storyId     {string}  — required
   *   characterId {string}  — ID of the character/NPC to add
   *   initiative  {number}  — optional override (skip roll)
   */
  add_to_combat(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat. Call enter_combat first.' };

    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found.' };

    const alreadyIn = story.combat.initiativeOrder.some(e => e.characterId === params.characterId);
    if (alreadyIn) return { error: `${char.name} is already in the initiative order.` };

    // Skip dead NPCs (they have nothing to add)
    if (char.stats.hp <= 0 && (char.isNPC || char.conditions?.includes('Dead'))) {
      return { error: `${char.name} is already dead and cannot join combat.` };
    }

    const dexMod    = Math.floor(((char.stats?.dexterity || 10) - 10) / 2);
    const initiative = params.initiative != null
      ? Number(params.initiative)
      : Math.floor(Math.random() * 20) + 1 + dexMod;
    const moveMax   = char.stats?.speed || char.movementSpeed || 30;

    const entry = {
      characterId:       params.characterId,
      name:              char.name,
      isNPC:             char.isNPC || false,
      initiative,
      hasAction:         true,
      hasBonusAction:    true,
      hasReaction:       true,
      hasExtraAction:    false,
      movementRemaining: moveMax,
      movementMax:       moveMax,
      isAlive:           true,
    };

    story.combat.initiativeOrder.push(entry);

    // Re-sort by initiative descending; tiebreak by DEX
    const currentCombatant = story.combat.initiativeOrder[story.combat.currentTurnIndex];
    story.combat.initiativeOrder.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      const ca = db.getCharacter(a.characterId);
      const cb = db.getCharacter(b.characterId);
      return ((cb?.stats?.dexterity || 10) - (ca?.stats?.dexterity || 10));
    });
    // Keep currentTurnIndex pointing at the same combatant after re-sort
    story.combat.currentTurnIndex = story.combat.initiativeOrder
      .findIndex(e => e.characterId === currentCombatant.characterId);

    db.saveStory(story);

    const newPosition = story.combat.initiativeOrder.findIndex(e => e.characterId === params.characterId) + 1;
    return {
      name:       char.name,
      initiative,
      position:   newPosition,
      message:    `${char.name} joins combat! Initiative ${initiative}, position ${newPosition} in the order.`,
    };
  },

  /**
   * Override a combatant's initiative value and re-sort the full order.
   * Useful for: surprise rounds, readied actions, special class features,
   * or DM adjustment. The turn pointer is updated to still reference the
   * same combatant after the re-sort.
   */
  set_initiative(params) {
    const story = db.getStory(params.storyId);
    if (!story?.combat?.active) return { error: 'No active combat.' };

    const entry = story.combat.initiativeOrder.find(e => e.characterId === params.characterId);
    if (!entry) return { error: 'Combatant not found in initiative order.' };

    const currentCombatant = story.combat.initiativeOrder[story.combat.currentTurnIndex];
    entry.initiative = Number(params.initiative);

    story.combat.initiativeOrder.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      const ca = db.getCharacter(a.characterId);
      const cb = db.getCharacter(b.characterId);
      return ((cb?.stats?.dexterity || 10) - (ca?.stats?.dexterity || 10));
    });
    story.combat.currentTurnIndex = story.combat.initiativeOrder
      .findIndex(e => e.characterId === currentCombatant.characterId);

    db.saveStory(story);
    return {
      name:         entry.name,
      newInitiative: params.initiative,
      newPosition:  story.combat.initiativeOrder.findIndex(e => e.characterId === params.characterId) + 1,
    };
  },

  /**
   * Return the full current combat state — initiative order, action economy,
   * HP, AC, conditions, and round number.
   * Use to orient yourself before narrating a complex multi-target turn,
   * or whenever you need to confirm who acts next and what resources are left.
   */
  get_combat_state(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };
    if (!story.combat?.active) return { active: false, message: 'No active combat.' };

    const combat = story.combat;
    return {
      active:           true,
      round:            combat.round,
      currentTurnIndex: combat.currentTurnIndex,
      currentCombatant: combat.initiativeOrder[combat.currentTurnIndex]?.name,
      initiativeOrder:  combat.initiativeOrder.map((e, i) => {
        const char = db.getCharacter(e.characterId);
        return {
          position:          i + 1,
          name:              e.name,
          initiative:        e.initiative,
          isNPC:             e.isNPC,
          isCurrent:         i === combat.currentTurnIndex,
          isAlive:           e.isAlive,
          hp:                char?.stats?.hp    ?? '?',
          maxHp:             char?.stats?.maxHp ?? '?',
          ac:                char?.stats?.ac    ?? '?',
          conditions:        char?.conditions    || [],
          hasAction:         e.hasAction,
          hasBonusAction:    e.hasBonusAction,
          hasReaction:       e.hasReaction,
          hasExtraAction:    e.hasExtraAction   || false,
          movementRemaining: e.movementRemaining,
          movementMax:       e.movementMax,
        };
      }),
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
      case 'use_spell_slot':
        return `✅ use_spell_slot: Level-${result.slotLevel} slot expended${result.spellName ? ` for ${result.spellName}` : ''} — ${result.remaining} remaining for ${result.charName}`;
      case 'restore_spell_slots':
        return `✅ restore_spell_slots: ${result.charName} recovers slots (${result.restType} rest) — ${result.slots}`;
      case 'get_spell_slots': {
        const slotStr = result.spellSlots?.map(s => `L${s.level}: ${s.available}/${s.total}${s.pactMagic ? '(P)' : ''}`).join(' ') || 'none';
        const spellStr = result.knownSpells?.map(s => `${s.name}(L${s.level})`).join(', ') || 'none';
        return `ℹ️ ${result.charName} spell slots: ${slotStr} | Known: ${spellStr}`;
      }
      case 'create_item':
        return `✅ create_item: Item "${result.item?.name}" created. itemId="${result.itemId}" — use this exact ID in your next add_item call`;
      case 'introduce_npc': {
        let introLine = result.reused
          ? `✅ introduce_npc: Existing character "${result.npc?.name}" reused (no duplicate). npcId="${result.npcId}" — use this ID in npc_speak calls`
          : `✅ introduce_npc: NPC "${result.npc?.name}" created. npcId="${result.npcId}" — use this ID in npc_speak calls`;
        if (result.autoJoinedCombat) {
          introLine += `\n⚔️ AUTO-JOINED COMBAT: ${result.npc?.name} rolled initiative ${result.initiative} and is now in the initiative order. Call get_combat_state to see the updated order. No need to call add_to_combat.`;
        }
        return introLine;
      }
      case 'remove_npc_from_scene':
        return `✅ remove_npc_from_scene: "${result.npcName}" removed from current scene (still a known character for future scenes)`;
      case 'modify_hp': {
        let hpLine = `✅ modify_hp: HP updated → ${result.newHp}/${result.maxHp}`;
        if (result.isDead && result.needsDeathSaves) {
          hpLine += ` — PC IS DOWN (0 HP) — DEATH SAVES ACTIVE: call roll_death_save at the START of each of their turns`;
        }
        if (result.isDead && !result.needsDeathSaves) {
          hpLine += ` — NPC/creature DEAD`;
        }
        if (result.aliveNPCs !== undefined) {
          const combatSummary = `${result.aliveNPCs} enemy/NPC(s) and ${result.alivePCs} PC(s) still in initiative`;
          hpLine += ` | Combat: ${combatSummary}`;
          if (result.aliveNPCs === 0) hpLine += ` — ALL ENEMIES DOWN → call end_combat`;
          else if (result.alivePCs === 0) hpLine += ` — ALL PCs DOWN → call end_combat`;
        }
        return hpLine;
      }
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
      // ── COMBAT ────────────────────────────────────────────────
      case 'enter_combat': {
        const order = (result.initiativeOrder || [])
          .map(e => `${e.position}. ${e.name} (Init:${e.initiative})${e.isCurrent ? ' ◄' : ''}`)
          .join(', ');
        const npcCount = (result.initiativeOrder || []).filter(e => e.isNPC).length;
        let combatLine = `⚔️ enter_combat: COMBAT STARTED — Round 1 | Initiative: ${order} | First to act: ${result.currentTurn}`;
        if (result.autoAddedEnemies?.length > 0) {
          combatLine += `\nℹ️ Auto-added from current scene: ${result.autoAddedEnemies.join(', ')}`;
        }
        if (npcCount === 0) {
          combatLine += `\n⚠️ CRITICAL WARNING: No enemy NPCs are in the initiative order! Only player characters are in combat. If enemies should be present, call add_to_combat with their characterId to add them now. Never run combat with only PCs in the order.`;
        }
        return combatLine;
      }
      case 'end_combat':
        return `✅ end_combat: ${result.message}`;
      case 'next_turn': {
        const newRoundNote = result.newRound ? ` — ⏰ NEW ROUND ${result.round} (reactions restored for all)` : '';
        const warnNote = result.warning ? `\n${result.warning}` : '';
        return `▶ next_turn: Now acting — ${result.currentTurn} (Round ${result.round})${newRoundNote}${warnNote}`;
      }
      case 'skip_turn': {
        const newRoundNote = result.newRound ? ` — ⏰ NEW ROUND ${result.round}` : '';
        const forfeitNote  = result.forfeited?.length > 0 ? ` [forfeited: ${result.forfeited.join(', ')}]` : '';
        return `⏭ skip_turn: ${result.skippedName} skipped${forfeitNote} — Now acting: ${result.currentTurn} (Round ${result.round})${newRoundNote}`;
      }
      case 'use_action':
        return `✅ use_action: ${result.name} — Action used${result.hasExtraAction ? ' (Action Surge still available)' : ''}. Bonus: ${result.hasBonusAction ? '✓' : '✗'}`;
      case 'use_bonus_action':
        return `✅ use_bonus_action: ${result.name} — Bonus Action used. Action: ${result.hasAction ? '✓' : '✗'}`;
      case 'use_reaction':
        return `✅ use_reaction: ${result.name} — Reaction used. Restores next round.`;
      case 'use_movement':
        return `✅ use_movement: ${result.name} moved ${result.feetUsed}ft (${result.movementRemaining}ft remaining of ${result.movementMax}ft)`;
      case 'action_surge':
        return `⚡ action_surge: ${result.message}`;
      case 'add_to_combat':
        return `⚔️ add_to_combat: ${result.message}`;
      case 'remove_from_combat':
        return `🚪 remove_from_combat: ${result.removed} removed from combat${result.suggestion ? ` — ${result.suggestion}` : ''}`;
      case 'set_initiative':
        return `✅ set_initiative: ${result.name} new initiative ${result.newInitiative} (position ${result.newPosition})`;
      case 'get_combat_state': {
        if (!result.active) return `ℹ️ get_combat_state: No active combat`;
        const order = (result.initiativeOrder || [])
          .map(e => `${e.position}. ${e.name} HP:${e.hp}/${e.maxHp} AC:${e.ac}${e.isCurrent ? ' ◄ACTIVE' : ''}${!e.isAlive ? ' ☠' : ''}`)
          .join(' | ');
        return `ℹ️ get_combat_state: Round ${result.round} | Acting: ${result.currentCombatant} | Order: ${order}`;
      }
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
    case 'use_spell_slot':
      return `✨ ${result.charName} casts${result.spellName ? ` ${result.spellName}` : ''} (L${result.slotLevel} slot — ${result.remaining} left)`;
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
    // ── COMBAT badges ─────────────────────────────────────────
    case 'enter_combat': {
      const total    = result.initiativeOrder?.length || 0;
      const npcCount = result.initiativeOrder?.filter(e => e.isNPC).length || 0;
      const autoNote = result.autoAddedEnemies?.length > 0 ? ` (incl. ${result.autoAddedEnemies.join(', ')})` : '';
      const warnNote = npcCount === 0 ? ' ⚠️ no enemies!' : '';
      return `⚔️ Combat begins! Round 1 — ${total} combatants${autoNote}${warnNote}`;
    }
    case 'end_combat':
      return `🏁 Combat ended`;
    case 'add_to_combat':
      return `⚔️ ${result.name} joins combat (initiative ${result.initiative})`;
    case 'next_turn':
      return result.newRound
        ? `🔔 Round ${result.round} begins — ${result.currentTurn}'s turn`
        : `▶ ${result.currentTurn}'s turn`;
    case 'skip_turn':
      return `⏭ ${result.skippedName} skipped → ${result.currentTurn}'s turn`;
    case 'use_action':
      return `⚡ ${result.name}: Action used`;
    case 'use_bonus_action':
      return `⚡ ${result.name}: Bonus Action used`;
    case 'use_reaction':
      return `⚡ ${result.name}: Reaction used`;
    case 'use_movement':
      return `🏃 ${result.name} moves ${result.feetUsed}ft (${result.movementRemaining}ft left)`;
    case 'action_surge':
      return `⚡ Action Surge! ${result.name} gets an extra action`;
    case 'remove_from_combat':
      return `🚪 ${result.removed} removed from combat`;
    case 'set_initiative':
      return `🎲 Initiative set: ${result.name} → ${result.newInitiative}`;
    case 'get_combat_state':
      return ''; // read-only, no badge
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
