/**
 * dm-engine.js — Core AI Dungeon Master engine.
 *
 * Exports:
 *   buildDMSystemPrompt(story, characters) → string
 *   parseDMToolCalls(responseText)         → Object[]
 *   sendDMMessage(storyId, userMessage)    → Promise<{dmResponse, toolCallsExecuted, toolSummaries}>
 */

import {
  getStory, saveStory, getCharacter, getAllItems, getItem, getNPCsForStory,
} from './db.js';
import { geminiChat, geminiGenerate, toGeminiHistory } from './api-gemini.js';
import { generateImage } from './api-image.js';
import { getModifier, getProficiencyBonus } from './utils.js';
import { executeDMTools, toolResultSummary, formatToolResultsForRePrompt } from './dm-tools.js';

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

  // Known NPCs section
  const knownNPCs = getNPCsForStory(story.id);
  const npcSection = knownNPCs.length > 0
    ? `\n\n== KNOWN WORLD CHARACTERS (use their IDs in npc_speak) ==\n` +
      knownNPCs.map(npc => {
        const condStr = npc.conditions?.length ? ` | Conditions: ${npc.conditions.join(', ')}` : '';
        return `- ${npc.name} | ID: ${npc.id} | Role: ${npc.npcRole || npc.class} | Race: ${npc.race} | HP: ${npc.stats.hp}/${npc.stats.maxHp}${condStr}
  Personality: ${npc.personality || 'Unknown'}
  Appearance: ${npc.appearance || 'Unknown'}
  Backstory: ${npc.backstory ? npc.backstory.slice(0, 150) : 'Unknown'}`;
      }).join('\n')
    : '';

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
== HOW TO USE TOOLS ==
Embed tool calls anywhere in your response using these exact markers:
<!-- TOOL_CALL -->
{"tool":"tool_name", ...params}
<!-- /TOOL_CALL -->

You may include multiple tool calls in a single response. They execute in order.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== AGENTIC LOOP — READ THIS CAREFULLY ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After you make tool calls, the system EXECUTES them and feeds you the results.
You then continue your response — make more tool calls or write your final narration.
This repeats until you produce a response with NO tool calls.

USE THIS TO:
• Roll dice → receive the real number → narrate the outcome truthfully
• create_item → receive the itemId → immediately call add_item in your next turn
• introduce_npc → receive the npcId → immediately call npc_speak(npcId) in your next turn
• Check stats or inventory → use the result to inform your narration

RULES FOR THE AGENTIC LOOP:
• NEVER invent dice results — always call roll_dice and wait for the actual number
• In turns where you are making tool calls, write brief setup text OR nothing at all
• Write your full prose narrative ONLY in the final turn (the one with no tool calls)
• Tool call turns are invisible to the player — only final narrative is shown

EXAMPLE — combat sequence:
  Turn 1: Call roll_dice(1d20+4, "attack roll against goblin")
  [System returns: total 17]
  Turn 2: Call roll_dice(1d8+2, "sword damage") + modify_hp(goblinId, -9, "sword strike")
  [System returns: damage 9, goblin HP 3/12]
  Turn 3: Write the full vivid narrative of the attack hitting for 9 damage.

EXAMPLE — giving a found item:
  Turn 1: Call create_item("Tarnished Silver Dagger", "weapon", ...)
  [System returns: itemId="abc123"]
  Turn 2: Call add_item(characterId, "abc123")
  [System returns: added successfully]
  Turn 3: Write narration of the character picking up the dagger.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== MANDATORY TOOL CALLS — NEVER SKIP THESE ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
These situations REQUIRE tool calls. Skipping them breaks the game:

• Player picks up / is given an item      → add_item (create_item first if the item doesn't exist yet)
• Player takes damage (from ANY source)   → modify_hp with a NEGATIVE delta
• Player heals (potions, spells, rest)    → modify_hp with a POSITIVE delta
• Player earns gold (loot, reward, sale)  → modify_gold with positive delta
• Player spends / loses gold              → modify_gold with negative delta
• Any attack roll                         → roll_dice (e.g. "1d20+3")
• Any skill check or saving throw         → roll_dice
• Any damage roll (after a hit)           → roll_dice (e.g. "2d6+2")
• New NPC named for the first time        → introduce_npc
• NPC says ANYTHING out loud              → npc_speak (never write NPC speech in narration)
• Party moves to a new location/scene     → advance_scene

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== AVAILABLE TOOLS ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DICE:
- roll_dice: {"tool":"roll_dice","notation":"1d20+4","reason":"attack roll"}
  notation supports: NdX, NdX+M, NdX-M  (e.g. "1d20", "2d6+3", "d8-1")
  Always await the result before narrating the outcome.

READ (query game state — no narration needed):
- get_character_stats:     {"tool":"get_character_stats","characterId":"<id>"}
- get_character_inventory: {"tool":"get_character_inventory","characterId":"<id>"}

WRITE (always narrate the outcome in your final turn):
- modify_hp:       {"tool":"modify_hp","characterId":"<id>","delta":<number>,"reason":"<why>"}
  delta: negative = damage, positive = healing
- modify_gold:     {"tool":"modify_gold","characterId":"<id>","delta":<number>}
- add_item:        {"tool":"add_item","characterId":"<id>","itemId":"<item-id>"}
- remove_item:     {"tool":"remove_item","characterId":"<id>","itemId":"<item-id>"}
- add_condition:   {"tool":"add_condition","characterId":"<id>","condition":"Poisoned"}
- remove_condition:{"tool":"remove_condition","characterId":"<id>","condition":"Poisoned"}
- log_event:       {"tool":"log_event","characterId":"<id>","entry":"Brief summary of event"}
- advance_scene:   {"tool":"advance_scene","storyId":"${story.id}","newSceneTitle":"<title>","newSceneDescription":"<vivid description>"}
- create_item:     {"tool":"create_item","name":"<name>","type":"weapon|armor|potion|misc|quest","description":"<desc>","rarity":"common|uncommon|rare|legendary","stats":{}}
  → Returns an itemId. Use it immediately in add_item in your next turn.

NPC / WORLD CHARACTER:
- introduce_npc: First time an NPC/creature/merchant appears. Remembered across sessions.
  {"tool":"introduce_npc","storyId":"${story.id}","name":"<name>","role":"enemy|merchant|ally|neutral|boss|creature","race":"<race>","personality":"<1-2 sentences>","appearance":"<1-2 sentences>","hp":<number>,"ac":<number>}
  → Returns an npcId. Use it in npc_speak in your next turn.

- npc_speak: Renders as a distinct speech bubble — the ONLY way NPC dialogue should appear.
  By npcId: {"tool":"npc_speak","npcId":"<id>","speech":"What they say..."}
  By name:  {"tool":"npc_speak","npcName":"<name>","speech":"What they say..."}`.trim();

  return `You are a seasoned, immersive Dungeon Master running a DND 5e campaign. You are the voice of the world — its narrator, its NPCs, its fate. You never break character.

== CAMPAIGN ==
Title: ${story.title}
Setting: ${story.setting || 'A classic fantasy world'}
Premise: ${story.premise || 'Heroes seek glory and treasure.'}
Status: ${completedCount} of ${story.scenes.length} scenes completed

== CURRENT SCENE ==
${currentScene ? `Title: ${currentScene.title}\n${currentScene.description}` : 'The adventure is just beginning.'}

== PLAYER CHARACTERS ==
${charSheets || 'No characters assigned yet.'}

== CHARACTER REFERENCE (use these IDs in tool calls) ==
${charRef || 'No characters yet.'}${npcSection}

${toolDocs}

== DUNGEON MASTER RULES ==
1. Always stay in character. You ARE the world, not just describing it.
2. Describe the world with vivid, sensory detail — sights, smells, sounds.
3. React meaningfully to every player action. Choices have consequences.
4. NEVER invent dice rolls. Use roll_dice and narrate based on the real result.
5. Build tension slowly. Not every action needs combat.
6. Every NPC, enemy, merchant, creature — anyone the party interacts with — is a WORLD CHARACTER. Use introduce_npc the FIRST time they appear. Use npc_speak for ALL their dialogue — never write NPC lines in narration. Known characters are listed under KNOWN WORLD CHARACTERS.
7. ALWAYS use modify_hp for any damage or healing — for both player characters AND NPCs.
8. ALWAYS use add_item when a player picks up, receives, or loots any item. Use create_item first if the item doesn't already exist, then add_item with the returned itemId.
9. When a scene naturally concludes and a new environment begins, use advance_scene.
10. Keep your final narrative to 2-4 paragraphs unless the scene demands more.
11. End each final response with a clear prompt for what the players can do next.
12. Give each NPC a distinct voice that matches their personality. An old wizard speaks differently from a gruff dwarf mercenary.
13. In intermediate tool-call turns, write nothing or only a brief fragment. Save the full prose for the final turn.

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
 * Uses an AGENTIC LOOP: after the DM makes tool calls the engine executes them,
 * feeds the results back, and lets the DM continue — rolling dice, chaining item
 * creation, etc. — before finally producing its narrative for the player.
 *
 * @param {string} storyId
 * @param {string} userMessage
 * @returns {Promise<{
 *   dmResponse: string,
 *   cleanResponse: string,
 *   toolCalls: Object[],
 *   toolCallsExecuted: Array<{tool:string, params:Object, result:any}>,
 *   toolSummaries: string[],
 *   npcSpeeches: Array<{npcId:string, npcName:string, npcRole:string, portrait:string, speech:string}>,
 *   sceneAdvanced: boolean,
 *   newSceneImagePrompt: string|null,
 * }>}
 */
export async function sendDMMessage(storyId, userMessage) {
  // ── 1. Load world state ──────────────────────────────────────
  const story = getStory(storyId);
  if (!story) throw new Error('Story not found: ' + storyId);

  const characters = story.characterIds
    .map(id => getCharacter(id))
    .filter(Boolean);

  const systemPrompt = buildDMSystemPrompt(story, characters);

  // ── 2. Append player message to permanent history ────────────
  story.dmChatHistory.push({ role: 'user', content: userMessage, timestamp: Date.now() });

  // ── 3. Build ephemeral working history for this turn ─────────
  // This grows with each agentic iteration (tool results injected as user turns)
  // but is NOT persisted — only the final combined narrative is saved.
  let workingHistory = toGeminiHistory(story.dmChatHistory);

  // ── 4. Agentic loop ──────────────────────────────────────────
  const MAX_ITERATIONS = 6;
  const allToolCallsExecuted = [];
  const allNarrativeParts   = [];
  let   sceneAdvance         = null;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Call the DM
    let rawResponse;
    try {
      rawResponse = await geminiChat(workingHistory, systemPrompt, 0.88);
    } catch (err) {
      if (iteration === 0) {
        // First call failed — roll back the player message so history stays clean
        story.dmChatHistory.pop();
        throw err;
      }
      console.warn('[dm-engine] Agentic loop call failed at iteration', iteration, err.message);
      break;
    }

    const toolCalls     = parseDMToolCalls(rawResponse);
    const narrativePart = stripToolCalls(rawResponse).trim();

    if (narrativePart) {
      allNarrativeParts.push(narrativePart);
    }

    // If the DM made no tool calls this turn, it's finished
    if (toolCalls.length === 0) break;

    // Execute all tool calls for this iteration
    const iterationResults = await executeDMTools(toolCalls);
    allToolCallsExecuted.push(...iterationResults);

    // Track the first scene advancement
    if (!sceneAdvance) {
      sceneAdvance = iterationResults.find(r => r.tool === 'advance_scene' && r.result?.newSceneId) || null;
    }

    // Feed results back into working history so the DM can continue
    workingHistory.push({ role: 'model', parts: [{ text: rawResponse }] });
    workingHistory.push({
      role: 'user',
      parts: [{
        text:
          `[TOOL RESULTS]\n${formatToolResultsForRePrompt(iterationResults)}\n[/TOOL RESULTS]\n\n` +
          `Continue. Make additional tool calls if needed (e.g. roll damage after an attack hit, ` +
          `or call add_item with the itemId you just received from create_item). ` +
          `When you have no more tool calls to make, write your complete narrative for the player.`,
      }],
    });

    // Safety: on the last allowed iteration just stop
    if (iteration === MAX_ITERATIONS - 1) break;
  }

  // ── 5. Assemble final response ───────────────────────────────
  const finalCleanResponse = allNarrativeParts.join('\n\n').trim()
    || '*(The dungeon holds its breath...)*';

  // ── 6. Build UI-facing summaries + NPC speeches ──────────────
  const toolSummaries = allToolCallsExecuted
    .map(({ tool, params, result }) => toolResultSummary(tool, params, result))
    .filter(s => s.length > 0);

  const npcSpeeches = allToolCallsExecuted
    .filter(r => r.tool === 'npc_speak' && !r.result?.error)
    .map(r => r.result);

  // ── 7. Persist final DM message + NPC speeches ──────────────
  // Reload story (tools may have mutated character/story records)
  const updatedStory = getStory(storyId) || story;

  updatedStory.dmChatHistory.push({
    role: 'assistant',
    content: finalCleanResponse,
    timestamp: Date.now(),
    toolCalls: allToolCallsExecuted.length > 0
      ? allToolCallsExecuted.map(r => r.params)
      : undefined,
  });

  // NPC speeches are stored as 'npc' entries — displayed in UI but skipped by toGeminiHistory
  for (const speech of npcSpeeches) {
    updatedStory.dmChatHistory.push({
      role: 'npc',
      npcId:    speech.npcId,
      npcName:  speech.npcName,
      portrait: speech.portrait,
      content:  speech.speech,
      timestamp: Date.now(),
    });
  }

  saveStory(updatedStory);

  // ── 8. Async: generate scene image if scene advanced ─────────
  const sceneAdvanced       = Boolean(sceneAdvance);
  const newSceneImagePrompt = sceneAdvance?.result?.imagePrompt || null;
  const newSceneId          = sceneAdvance?.result?.newSceneId  || null;

  if (sceneAdvanced && newSceneImagePrompt && newSceneId) {
    generateSceneImageAsync(storyId, newSceneId, newSceneImagePrompt);
  }

  return {
    dmResponse:        finalCleanResponse,
    cleanResponse:     finalCleanResponse,
    toolCalls:         allToolCallsExecuted.map(r => r.params),
    toolCallsExecuted: allToolCallsExecuted,
    toolSummaries,
    npcSpeeches,
    sceneAdvanced,
    newSceneImagePrompt,
  };
}

/**
 * Use Gemini to extract key visual elements from a scene description
 * and build an optimised Pollinations.ai image prompt.
 * @param {string} sceneDesc
 * @param {string} setting
 * @returns {Promise<string>}
 */
async function optimizeImagePrompt(sceneDesc, setting) {
  if (!sceneDesc && !setting) return 'dark fantasy adventure scene, cinematic';
  try {
    const raw = await geminiGenerate(
      `Convert this DND scene description into a vivid image generation prompt (under 80 words). Focus only on visual elements: environment, lighting, atmosphere, colors, textures, mood. No dialogue, no character names, no story text. Return only the prompt.

Scene: "${(sceneDesc || '').slice(0, 400)}"
Setting: "${setting || 'dark fantasy world'}"`,
      '',
      0.7
    );
    return raw.trim().slice(0, 400);
  } catch {
    // Fallback: compose a basic prompt from the raw inputs
    const base = (sceneDesc || setting || 'fantasy scene').slice(0, 200);
    return base;
  }
}

/**
 * Generate a scene image in the background and save to story.
 */
async function generateSceneImageAsync(storyId, sceneId, rawPrompt) {
  try {
    // First, ask Gemini to optimise the visual prompt
    const story = getStory(storyId);
    const setting = story?.setting || '';
    const visualPrompt = await optimizeImagePrompt(rawPrompt, setting);

    const url = await generateImage(
      visualPrompt + ', fantasy digital art, cinematic lighting, detailed, wide angle, 16:9',
      768, 432
    );
    const updatedStory = getStory(storyId);
    if (!updatedStory) return;
    const scene = updatedStory.scenes.find(s => s.id === sceneId);
    if (scene) {
      scene.imageUrl = url;
      scene.imagePrompt = visualPrompt;
      if (updatedStory.currentSceneIndex === updatedStory.scenes.indexOf(scene)) {
        updatedStory.sceneImageUrl = url;
      }
      saveStory(updatedStory);
    }
  } catch (err) {
    console.warn('[dm-engine] Scene image generation failed:', err.message);
  }
}
