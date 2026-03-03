/**
 * dm-engine.js — Core AI Dungeon Master engine.
 *
 * Exports:
 *   buildDMSystemPrompt(story, characters) → string
 *   parseDMToolCalls(responseText)         → Object[]
 *   sendDMMessage(storyId, userMessage)    → Promise<{dmResponse, toolCallsExecuted, toolSummaries}>
 */

import {
  getStory, saveStory, getCharacter, getAllItems, getItem,
} from './db.js';
import { geminiChat, toGeminiHistory } from './api-gemini.js';
import { generateImage } from './api-image.js';
import { getModifier, getProficiencyBonus } from './utils.js';
import { executeDMTools, toolResultSummary } from './dm-tools.js';

// ── System Prompt Builder ─────────────────────────────────────

/**
 * Construct the rich DM system prompt for Gemini.
 * @param {import('./db.js').Story} story
 * @param {import('./db.js').Character[]} characters
 * @returns {string}
 */
export function buildDMSystemPrompt(story, characters) {
  const currentScene = story.scenes[story.currentSceneIndex] || story.scenes[story.scenes.length - 1];
  const completedCount = story.scenes.filter(s => s.completedAt).length;

  // Character sheets section
  const charSheets = characters.map(ch => {
    const inv = ch.inventory.map(inst => {
      const item = getItem(inst.itemId);
      return item ? `${item.name} (x${inst.quantity})` : `Unknown item x${inst.quantity}`;
    });
    const mods = ['strength','dexterity','constitution','intelligence','wisdom','charisma']
      .map(stat => `${stat.slice(0,3).toUpperCase()} ${ch.stats[stat]}(${getModifier(ch.stats[stat]) >= 0 ? '+' : ''}${getModifier(ch.stats[stat])})`)
      .join(', ');
    const profBonus = getProficiencyBonus(ch.level);
    const logSummary = ch.adventureLog.slice(-3).join(' | ') || 'No prior adventures.';

    return `
--- Character: ${ch.name} ---
Race: ${ch.race} | Class: ${ch.class} | Level: ${ch.level} | ID: ${ch.id}
HP: ${ch.stats.hp}/${ch.stats.maxHp} | AC: ${ch.stats.ac} | Gold: ${ch.gold} gp | XP: ${ch.xp}
Ability Scores: ${mods}
Proficiency Bonus: +${profBonus}
Skills: ${ch.skills.join(', ') || 'None noted'}
Conditions: ${ch.conditions.length ? ch.conditions.join(', ') : 'None'}
Inventory: ${inv.length ? inv.join(', ') : 'Empty'}
Backstory: ${ch.backstory ? ch.backstory.slice(0, 200) : 'Unknown origins.'}
Recent Adventure Log: ${logSummary}`.trim();
  }).join('\n\n');

  // Character reference for tool calls
  const charRef = characters.map(ch =>
    `- ${ch.name} | ID: ${ch.id} | HP: ${ch.stats.hp}/${ch.stats.maxHp} | Class: ${ch.class} | Level: ${ch.level}`
  ).join('\n');

  const toolDocs = `
== TOOLS (use these to modify game state) ==
When you want to use a tool, embed it in your response with these exact markers:
<!-- TOOL_CALL -->
{"tool":"tool_name", ...params}
<!-- /TOOL_CALL -->

You may use multiple tool calls in a single response. Always narrate the outcome AFTER the tool block.

Available tools:

READ TOOLS (never narrate these, just use results silently):
- get_character_stats: {"tool":"get_character_stats","characterId":"<id>"}
- get_character_inventory: {"tool":"get_character_inventory","characterId":"<id>"}

WRITE TOOLS (narrate all outcomes dramatically):
- modify_hp: {"tool":"modify_hp","characterId":"<id>","delta":<number>,"reason":"<why>"}
  delta: positive = heal, negative = damage. Example: -5 for taking 5 damage.
- modify_gold: {"tool":"modify_gold","characterId":"<id>","delta":<number>}
- add_item: {"tool":"add_item","characterId":"<id>","itemId":"<item-id>"}
- remove_item: {"tool":"remove_item","characterId":"<id>","itemId":"<item-id>"}
- add_condition: {"tool":"add_condition","characterId":"<id>","condition":"Poisoned"}
- remove_condition: {"tool":"remove_condition","characterId":"<id>","condition":"Poisoned"}
- log_event: {"tool":"log_event","characterId":"<id>","entry":"Brief summary of what happened"}
- advance_scene: {"tool":"advance_scene","storyId":"${story.id}","newSceneTitle":"<title>","newSceneDescription":"<vivid description>"}
- create_item: {"tool":"create_item","name":"<name>","type":"weapon|armor|potion|misc|quest","description":"<desc>","rarity":"common|uncommon|rare|legendary","stats":{}}`.trim();

  return `You are a seasoned, immersive Dungeon Master running a DND 5e campaign. You are the voice of the world — its narrator, its NPCs, its fate. You never break character.

== CAMPAIGN ==
Title: ${story.title}
Setting: ${story.setting || 'A classic fantasy world'}
Premise: ${story.premise || 'Heroes seek glory and treasure.'}
Status: ${completedCount} of ${story.scenes.length} scenes completed

== CURRENT SCENE ==
${currentScene ? `Title: ${currentScene.title}\n${currentScene.description}` : 'The adventure is just beginning.'}

== CHARACTERS (your players) ==
${charSheets || 'No characters assigned yet.'}

== CHARACTER REFERENCE (use these IDs in tool calls) ==
${charRef || 'No characters yet.'}

${toolDocs}

== DUNGEON MASTER RULES ==
1. Always stay in character. You ARE the world, not just describing it.
2. Describe the world with vivid, sensory detail — sights, smells, sounds.
3. React meaningfully to every player action. Choices have consequences.
4. When dice rolls are needed, describe them narratively ("roll for stealth" → "The shadows seem to part for you as you slip past the guard...").
5. Build tension slowly. Not every action needs combat.
6. Create memorable, distinct NPCs with personality and motivation.
7. When a character takes damage or heals, ALWAYS use the modify_hp tool.
8. When a scene naturally concludes and a new environment begins, use advance_scene.
9. Keep responses to 2-4 paragraphs unless the scene demands more.
10. End each response with a clear prompt for what the players can do next.
11. Use tool calls BEFORE narrating their outcome — the system will execute them.

== TONE ==
Dark fantasy with moments of wonder. Build dread before combat. Celebrate victories. Make death feel real and weighty. Reference character backstories when appropriate.`;
}

// ── Tool Call Parser ──────────────────────────────────────────

/**
 * Extract and parse tool calls from a DM response string.
 * @param {string} responseText
 * @returns {Object[]}
 */
export function parseDMToolCalls(responseText) {
  const calls = [];
  const regex = /<!--\s*TOOL_CALL\s*-->([\s\S]*?)<!--\s*\/TOOL_CALL\s*-->/g;
  let match;
  while ((match = regex.exec(responseText)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed.tool === 'string') {
        calls.push(parsed);
      }
    } catch (e) {
      console.warn('[dm-engine] Failed to parse tool call JSON:', match[1].trim());
    }
  }
  return calls;
}

/**
 * Strip tool call markers from the response text to get clean narrative.
 * @param {string} responseText
 * @returns {string}
 */
export function stripToolCalls(responseText) {
  return responseText
    .replace(/<!--\s*TOOL_CALL\s*-->[\s\S]*?<!--\s*\/TOOL_CALL\s*-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Main DM Message Handler ───────────────────────────────────

/**
 * Send a player message to the AI DM and return its response + any tool effects.
 *
 * @param {string} storyId
 * @param {string} userMessage
 * @returns {Promise<{
 *   dmResponse: string,
 *   cleanResponse: string,
 *   toolCalls: Object[],
 *   toolCallsExecuted: Array<{tool:string, params:Object, result:any}>,
 *   toolSummaries: string[],
 *   sceneAdvanced: boolean,
 *   newSceneImagePrompt: string|null,
 * }>}
 */
export async function sendDMMessage(storyId, userMessage) {
  // 1. Load story and characters
  const story = getStory(storyId);
  if (!story) throw new Error('Story not found: ' + storyId);

  const characters = story.characterIds
    .map(id => getCharacter(id))
    .filter(Boolean);

  // 2. Build system prompt
  const systemPrompt = buildDMSystemPrompt(story, characters);

  // 3. Append player message to chat history
  const playerMsg = {
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  };
  story.dmChatHistory.push(playerMsg);

  // 4. Convert history to Gemini format
  const geminiHistory = toGeminiHistory(story.dmChatHistory);

  // 5. Call Gemini
  let rawResponse;
  try {
    rawResponse = await geminiChat(geminiHistory, systemPrompt, 0.88);
  } catch (err) {
    // Remove the player message we just added so it doesn't corrupt history
    story.dmChatHistory.pop();
    throw err;
  }

  // 6. Parse tool calls from response
  const toolCalls = parseDMToolCalls(rawResponse);
  const cleanResponse = stripToolCalls(rawResponse);

  // 7. Execute tool calls
  const toolCallsExecuted = toolCalls.length > 0
    ? await executeDMTools(toolCalls)
    : [];

  // 8. Build human-readable tool summaries
  const toolSummaries = toolCallsExecuted.map(({ tool, params, result }) =>
    toolResultSummary(tool, params, result)
  );

  // 9. Check if a scene was advanced (needs new image)
  const sceneAdvance = toolCallsExecuted.find(r => r.tool === 'advance_scene' && r.result?.newSceneId);
  const sceneAdvanced = Boolean(sceneAdvance);
  const newSceneImagePrompt = sceneAdvance?.result?.imagePrompt || null;
  const newSceneId = sceneAdvance?.result?.newSceneId || null;

  // 10. Append DM response to history
  const dmMsg = {
    role: 'assistant',
    content: cleanResponse,
    timestamp: Date.now(),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };

  // Reload story (tools may have mutated it)
  const updatedStory = getStory(storyId) || story;
  updatedStory.dmChatHistory.push(dmMsg);
  saveStory(updatedStory);

  // 11. Async: generate new scene image if scene advanced
  if (sceneAdvanced && newSceneImagePrompt && newSceneId) {
    generateSceneImageAsync(storyId, newSceneId, newSceneImagePrompt);
  }

  return {
    dmResponse: rawResponse,
    cleanResponse,
    toolCalls,
    toolCallsExecuted,
    toolSummaries,
    sceneAdvanced,
    newSceneImagePrompt,
  };
}

/**
 * Generate a scene image in the background and save to story.
 */
async function generateSceneImageAsync(storyId, sceneId, prompt) {
  try {
    const url = await generateImage(
      prompt + ', fantasy digital art, cinematic, dramatic lighting, wide angle',
      768, 432
    );
    const story = getStory(storyId);
    if (!story) return;
    const scene = story.scenes.find(s => s.id === sceneId);
    if (scene) {
      scene.imageUrl = url;
      if (story.currentSceneIndex === story.scenes.indexOf(scene)) {
        story.sceneImageUrl = url;
      }
      saveStory(story);
    }
  } catch (err) {
    console.warn('[dm-engine] Scene image generation failed:', err.message);
  }
}
