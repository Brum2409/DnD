/**
 * dm-tools.js — Agentic DM tool implementations.
 *
 * Each tool is a function: (params, db) => result  (sync)
 *                       or: (params, db, gemini, imageApi) => Promise<result>  (async)
 *
 * The DM calls these by embedding JSON in its response wrapped in markers:
 *   <!-- TOOL_CALL -->
 *   {"tool":"modify_hp","characterId":"...","delta":-5,"reason":"Goblin stab"}
 *   <!-- /TOOL_CALL -->
 */

import * as db from './db.js';
import { geminiGenerate } from './api-gemini.js';
import { generateIconBase64, generateImage } from './api-image.js';
import { uuid } from './utils.js';

// ── Tool definitions ──────────────────────────────────────────

export const DM_TOOLS = {

  // ─── READ tools ────────────────────────────────────────────

  get_character_stats(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    return {
      hp: char.stats.hp,
      maxHp: char.stats.maxHp,
      ac: char.stats.ac,
      conditions: char.conditions,
      gold: char.gold,
    };
  },

  get_character_inventory(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    return char.inventory.map(inst => {
      const item = db.getItem(inst.itemId);
      return item ? { ...item, quantity: inst.quantity } : { itemId: inst.itemId, quantity: inst.quantity };
    });
  },

  get_character_stat(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    return { value: char.stats[params.stat] ?? char[params.stat] ?? null };
  },

  // ─── WRITE tools ───────────────────────────────────────────

  modify_hp(params) {
    const char = db.updateCharacterHP(params.characterId, params.delta);
    if (!char) return { error: 'Character not found' };
    return {
      newHp: char.stats.hp,
      maxHp: char.stats.maxHp,
      delta: params.delta,
      isDead: char.stats.hp <= 0,
      reason: params.reason || '',
    };
  },

  add_item(params) {
    db.updateCharacterInventory(params.characterId, params.itemId, 'add');
    const item = db.getItem(params.itemId);
    return { success: true, itemName: item?.name || params.itemId };
  },

  remove_item(params) {
    db.updateCharacterInventory(params.characterId, params.itemId, 'remove');
    const item = db.getItem(params.itemId);
    return { success: true, itemName: item?.name || params.itemId };
  },

  add_condition(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    if (!char.conditions.includes(params.condition)) {
      char.conditions.push(params.condition);
      db.saveCharacter(char);
    }
    return { conditions: char.conditions };
  },

  remove_condition(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    char.conditions = char.conditions.filter(c => c !== params.condition);
    db.saveCharacter(char);
    return { conditions: char.conditions };
  },

  modify_gold(params) {
    const char = db.getCharacter(params.characterId);
    if (!char) return { error: 'Character not found' };
    char.gold = Math.max(0, (char.gold || 0) + params.delta);
    db.saveCharacter(char);
    return { newGold: char.gold, delta: params.delta };
  },

  log_event(params) {
    db.addToAdventureLog(params.characterId, params.entry);
    return { success: true };
  },

  advance_scene(params) {
    const story = db.getStory(params.storyId);
    if (!story) return { error: 'Story not found' };

    // Mark current scene complete
    const currentScene = story.scenes[story.currentSceneIndex];
    if (currentScene && !currentScene.completedAt) {
      currentScene.completedAt = Date.now();
    }

    const newScene = {
      id: uuid(),
      title: params.newSceneTitle || 'New Scene',
      description: params.newSceneDescription || '',
      imagePrompt: params.newSceneDescription || '',
      imageUrl: '',
      npcs: [],
      loot: [],
      completedAt: null,
    };

    story.scenes.push(newScene);
    story.currentSceneIndex = story.scenes.length - 1;
    story.sceneImageUrl = '';
    db.saveStory(story);

    // Trigger async image generation (caller handles this)
    return {
      newSceneIndex: story.currentSceneIndex,
      newSceneId: newScene.id,
      needsImage: true,
      imagePrompt: newScene.imagePrompt,
    };
  },

  async create_item(params) {
    const lore = await geminiGenerate(
      `Write a 2-sentence fantasy lore backstory for a DND item named "${params.name}". ${params.description || ''}. Be evocative and mysterious. Just the lore text, no labels.`
    ).catch(() => '');

    const iconPrompt = `${params.name}, ${params.type || 'misc'}, fantasy RPG item icon, ${params.rarity || 'common'} rarity, dark background, detailed art`;
    const iconBase64 = await generateIconBase64(iconPrompt).catch(() => '');

    const item = {
      id: uuid(),
      name: params.name,
      type: params.type || 'misc',
      description: params.description || '',
      lore,
      iconBase64,
      iconPrompt,
      stats: params.stats || {},
      rarity: params.rarity || 'common',
      createdAt: Date.now(),
    };
    db.saveItem(item);
    return { itemId: item.id, item };
  },
};

// ── Tool executor ─────────────────────────────────────────────

/**
 * Execute an array of tool calls parsed from DM response.
 * @param {Object[]} toolCalls
 * @returns {Promise<Array<{tool:string, params:Object, result:any}>>}
 */
export async function executeDMTools(toolCalls) {
  const results = [];
  for (const call of toolCalls) {
    const fn = DM_TOOLS[call.tool];
    if (!fn) {
      results.push({ tool: call.tool, params: call, result: { error: `Unknown tool: ${call.tool}` } });
      continue;
    }
    try {
      const result = await fn(call);
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
    case 'modify_hp': {
      const name = charName();
      const arrow = params.delta < 0 ? 'takes' : 'heals';
      const amount = Math.abs(params.delta);
      const hpStr = `${result.newHp}/${result.maxHp} HP`;
      if (result.isDead) return `💀 ${name} has fallen to 0 HP and is unconscious!`;
      return params.delta < 0
        ? `⚔️ ${name} ${arrow} ${amount} damage (${hpStr})${params.reason ? ' — ' + params.reason : ''}`
        : `❤️ ${name} ${arrow} ${amount} HP (${hpStr})`;
    }
    case 'add_item':
      return `🎒 ${charName()} receives: ${result.itemName}`;
    case 'remove_item':
      return `🎒 ${charName()} loses: ${result.itemName}`;
    case 'add_condition':
      return `⚡ ${charName()} gains condition: ${params.condition}`;
    case 'remove_condition':
      return `✨ ${charName()} loses condition: ${params.condition}`;
    case 'modify_gold': {
      const sign = params.delta >= 0 ? '+' : '';
      return `💰 ${charName()} ${params.delta >= 0 ? 'earns' : 'spends'} ${Math.abs(params.delta)} gold (now ${result.newGold} gp)`;
    }
    case 'advance_scene':
      return `🗺️ Scene advances: ${params.newSceneTitle || 'New Scene'}`;
    case 'create_item':
      return `🌟 New item created: ${result.item?.name || params.name}`;
    case 'log_event':
      return `📜 Adventure log updated`;
    default:
      return `🔧 Tool executed: ${tool}`;
  }
}
