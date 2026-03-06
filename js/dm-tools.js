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
 *  WRITE   modify_hp, modify_gold, modify_xp, add_item, remove_item,
 *          add_condition, remove_condition, log_event, advance_scene,
 *          create_item, set_npc_stat
 *  NPC     introduce_npc, npc_speak
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
    return {
      newHp:  char.stats.hp,
      maxHp:  char.stats.maxHp,
      delta:  params.delta,
      isDead: char.stats.hp <= 0,
      reason: params.reason || '',
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
   * Introduce a new world character (NPC, enemy, merchant, creature…).
   * Call this the FIRST time a named character appears. They are then
   * remembered across all sessions via the characters table.
   * Returns npcId — use it in npc_speak in your next turn.
   */
  async introduce_npc(params) {
    const {
      storyId, name, role = 'neutral', race = 'Human',
      personality = '', appearance = '',
      hp = 10, ac = 10,
    } = params;

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
      case 'introduce_npc':
        return `✅ introduce_npc: NPC "${result.npc?.name}" created. npcId="${result.npcId}" — use this ID in npc_speak calls`;
      case 'modify_hp':
        return `✅ modify_hp: HP updated → ${result.newHp}/${result.maxHp}${result.isDead ? ' — CHARACTER IS DOWN (0 HP)' : ''}`;
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
      if (result.isDead) return `💀 ${name} has fallen to 0 HP!`;
      return params.delta < 0
        ? `⚔️ ${name} takes ${amount} damage (${hpStr})${params.reason ? ' — ' + params.reason : ''}`
        : `❤️ ${name} heals ${amount} HP (${hpStr})`;
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
      return `🎭 ${result.npc?.name || params.name} enters the story`;
    case 'npc_speak':
      return ''; // NPC speech renders as its own bubble
    case 'compress_history':
      return `📜 History compressed (${result.compressedCount} messages → summary, ${result.keptCount} recent kept)`;
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
