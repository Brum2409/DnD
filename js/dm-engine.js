/**
 * dm-engine.js — Core AI Dungeon Master engine.
 *
 * Exports:
 *   buildDMSystemPrompt(story, characters) → string
 *   parseDMToolCalls(responseText)         → Object[]
 *   sendDMMessage(storyId, userMessage)    → Promise<{...}>
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
 * Build the DM system prompt.
 *
 * PHILOSOPHY — Lean context, rich tools:
 *   The system prompt contains only the quick-reference data the DM needs
 *   for every response (names, IDs, current HP, conditions).
 *   Deeper data (full stats, backstory, inventory, adventure log, scene history,
 *   NPC details) is fetched on-demand via READ tools so the context stays small
 *   even after many sessions.
 *
 * @param {import('./db.js').Story} story
 * @param {import('./db.js').Character[]} characters
 * @returns {string}
 */
export function buildDMSystemPrompt(story, characters) {
  const currentScene    = story.scenes[story.currentSceneIndex] || story.scenes[story.scenes.length - 1];
  const completedCount  = story.scenes.filter(s => s.completedAt).length;

  // ── Compact character quick-reference ─────────────────────
  // Full sheets are available on demand via get_full_character.
  const charQuickRef = characters.map(ch => {
    const condStr = ch.conditions.length ? ` | Cond: ${ch.conditions.join(', ')}` : '';
    const profBonus = getProficiencyBonus(ch.level);
    return `• ${ch.name} | ID: ${ch.id} | ${ch.race} ${ch.class} Lv${ch.level} | HP: ${ch.stats.hp}/${ch.stats.maxHp} | AC: ${ch.stats.ac} | Gold: ${ch.gold}gp | XP: ${ch.xp} | Prof: +${profBonus}${condStr}`;
  }).join('\n');

  // ── Compact NPC quick-reference — split by location ────────
  // Full NPC sheets available via get_npc_details.
  const knownNPCs = getNPCsForStory(story.id);
  const sceneNpcIds = new Set(currentScene?.npcs || []);
  const sceneNPCs   = knownNPCs.filter(npc => sceneNpcIds.has(npc.id));
  const absentNPCs  = knownNPCs.filter(npc => !sceneNpcIds.has(npc.id));

  const npcQuickRef = knownNPCs.length > 0
    ? (sceneNPCs.length > 0
        ? `\n\n== CHARACTERS IN CURRENT SCENE (quick ref — use get_npc_details for full info) ==\n` +
          sceneNPCs.map(npc => {
            const condStr = npc.conditions?.length ? ` | Cond: ${npc.conditions.join(', ')}` : '';
            return `• ${npc.name} | ID: ${npc.id} | ${npc.npcRole || npc.class} | ${npc.race} | HP: ${npc.stats.hp}/${npc.stats.maxHp}${condStr}`;
          }).join('\n')
        : '')
      + (absentNPCs.length > 0
        ? `\n\n== KNOWN CHARACTERS (not in current scene — last seen elsewhere) ==\n` +
          absentNPCs.map(npc => {
            const lastScene = story.scenes.find(s => s.id === npc.lastSceneId);
            return `• ${npc.name} | ID: ${npc.id} | ${npc.npcRole || npc.class} | Last seen: ${lastScene?.title || 'unknown'}`;
          }).join('\n')
        : '')
    : '';

  // ── Tool documentation ─────────────────────────────────────
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
You then continue — make more tool calls or write your final narration.
This repeats until you produce a response with NO tool calls.

USE THIS TO:
• Roll dice → receive the real number → narrate the outcome truthfully
• create_item → get itemId → immediately call add_item in your next turn
• introduce_npc → get npcId → immediately call npc_speak in your next turn
• get_full_character / get_npc_details → read the data → use it in your narration

RULES:
• NEVER invent dice results — always call roll_dice and wait for the real number
• In tool-call turns, write brief setup text OR nothing at all
• Write your full prose narrative ONLY in the final turn (the one with no tool calls)
• Tool-call turns are invisible to the player — only the final narrative is shown
• You MAY make multiple tool calls in a single turn (they all run in parallel order)

EXAMPLE — item pickup:
  Turn 1: create_item("Tarnished Dagger", "weapon", ...)
  [System: itemId="abc123"]
  Turn 2: add_item(characterId, "abc123") + log_event(characterId, "Found a dagger")
  [System: item added, log updated]
  Turn 3: Write full narration of picking up the dagger.

EXAMPLE — combat:
  Turn 1: roll_dice("1d20+4", "attack vs goblin")
  [System: total 17]
  Turn 2: roll_dice("1d8+2", "sword damage") + modify_hp(goblinId, -9, "sword strike")
  [System: damage 9, goblin HP 3/12]
  Turn 3: Write vivid attack narrative.

EXAMPLE — fetching context:
  Turn 1: get_full_character(characterId) — when you need backstory/inventory/stats
  [System: returns full sheet]
  Turn 2: Write narration that references specific details from the sheet.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== MANDATORY TOOL CALLS — NEVER SKIP ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Player picks up / receives an item        → add_item (create_item first if new)
• Player takes damage (any source)          → modify_hp with NEGATIVE delta
• Player heals (potion, spell, rest)        → modify_hp with POSITIVE delta
• Player earns gold                         → modify_gold positive
• Player spends / loses gold                → modify_gold negative
• Player earns XP                           → modify_xp positive
• Any attack roll                           → roll_dice (e.g. "1d20+3")
• Any skill check or saving throw           → roll_dice
• Any damage roll (after a hit)             → roll_dice (e.g. "2d6+2")
• NPC / creature takes damage               → modify_hp on that NPC's ID
• New named NPC appears for the first time  → introduce_npc
• NPC says ANYTHING out loud               → npc_speak (NEVER write NPC speech in narration)
• Party moves to a new location / scene     → advance_scene
• End of a significant encounter            → log_event for each character

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== AVAILABLE TOOLS ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DICE:
- roll_dice: {"tool":"roll_dice","notation":"1d20+4","reason":"attack roll"}
  Notation: NdX, NdX+M, NdX-M  (e.g. "1d20", "2d6+3", "d8-1")
  ALWAYS await the result before narrating.

READ (query game state, no side-effects):
- get_character_stats:     {"tool":"get_character_stats","characterId":"<id>"}
  Quick: HP, AC, gold, conditions, XP.

- get_full_character:      {"tool":"get_full_character","characterId":"<id>"}
  Full sheet: all ability scores, skills, full inventory with item details,
  backstory, last 15 adventure log entries. Use when you need deeper context.

- get_character_inventory: {"tool":"get_character_inventory","characterId":"<id>"}
  Inventory only (faster than full character if that's all you need).

- get_npc_details:         {"tool":"get_npc_details","npcId":"<id>"}  (or "npcName":"<name>")
  Full NPC info: personality, appearance, backstory, HP/AC, conditions.

- get_adventure_log:       {"tool":"get_adventure_log","characterId":"<id>"}
  Complete adventure log for a character.

- get_scene_history:       {"tool":"get_scene_history","storyId":"${story.id}"}
  All past and current scenes with titles and completion status.

WRITE (always narrate the outcome in your final turn):
- modify_hp:        {"tool":"modify_hp","characterId":"<id>","delta":<±number>,"reason":"<why>"}
- modify_gold:      {"tool":"modify_gold","characterId":"<id>","delta":<±number>}
- modify_xp:        {"tool":"modify_xp","characterId":"<id>","delta":<number>}
- add_item:         {"tool":"add_item","characterId":"<id>","itemId":"<item-id>"}
- remove_item:      {"tool":"remove_item","characterId":"<id>","itemId":"<item-id>"}
- add_condition:    {"tool":"add_condition","characterId":"<id>","condition":"Poisoned"}
- remove_condition: {"tool":"remove_condition","characterId":"<id>","condition":"Poisoned"}
- log_event:        {"tool":"log_event","characterId":"<id>","entry":"Brief summary"}
- set_npc_stat:     {"tool":"set_npc_stat","npcId":"<id>","stat":"hp","value":<number>}
  stat options: "hp" (sets absolute HP), "maxHp", "ac",
                "add_condition" (value = condition string),
                "remove_condition" (value = condition string)
- advance_scene:    {"tool":"advance_scene","storyId":"${story.id}","newSceneTitle":"<title>","newSceneDescription":"<vivid desc>"}
- create_item:      {"tool":"create_item","name":"<name>","type":"weapon|armor|potion|misc|quest","description":"<desc>","rarity":"common|uncommon|rare|legendary","stats":{}}
  → Returns itemId. Use it immediately in add_item in your NEXT turn.
  ⚠️ NEVER put create_item and add_item in the same turn — you don't know the itemId yet.
     create_item runs first, then the system gives you the real itemId to use in add_item.

NPC / WORLD CHARACTER:
- introduce_npc:
  {"tool":"introduce_npc","storyId":"${story.id}","name":"<name>","role":"enemy|merchant|ally|neutral|boss|creature","race":"<race>","personality":"<1-2 sentences>","appearance":"<1-2 sentences>","hp":<number>,"ac":<number>}
  → Returns npcId. Use in npc_speak immediately after.

- npc_speak:
  {"tool":"npc_speak","npcId":"<id>","speech":"What they say…"}
  {"tool":"npc_speak","npcName":"<name>","speech":"What they say…"}

META:
- compress_history:
  {"tool":"compress_history","storyId":"${story.id}"}
  Summarises all older messages into a dense adventure note, then keeps the
  most recent 8 messages verbatim so you never lose the live thread of the
  current scene. The full history is always preserved for the player.
  Use proactively when the conversation exceeds ~40 messages.`.trim();

  return `You are a seasoned, immersive Dungeon Master running a DND 5e campaign. You are the voice of the world — its narrator, its NPCs, its fate. You never break character.

== CAMPAIGN ==
Title: ${story.title}
Setting: ${story.setting || 'A classic fantasy world'}
Premise: ${story.premise || 'Heroes seek glory and treasure.'}
Progress: ${completedCount} of ${story.scenes.length} scenes completed

== CURRENT SCENE ==
${currentScene ? `Title: ${currentScene.title}\n${currentScene.description}` : 'The adventure is just beginning.'}

== PARTY QUICK REFERENCE ==
${charQuickRef || 'No characters assigned yet.'}
(Use get_full_character for full stats, backstory, and inventory.)${npcQuickRef}

${toolDocs}

== DUNGEON MASTER RULES ==
1. Stay in character always. You ARE the world, not just describing it.
2. Describe with vivid sensory detail — sights, smells, sounds, textures.
3. React meaningfully to every player action. Choices have real consequences.
4. NEVER invent dice rolls. Call roll_dice and narrate from the real result.
5. Build tension gradually. Not every action needs combat.
6. Every named NPC/creature is a WORLD CHARACTER. Call introduce_npc the first time they appear. Use npc_speak for ALL dialogue — never write NPC lines in narration.
7. ALWAYS use modify_hp for any damage or healing — for both PCs and NPCs.
8. ALWAYS use add_item when a character picks up, receives, or loots any item. Use create_item first if the item is new.
9. ALWAYS use modify_xp when the party completes a meaningful objective, defeats enemies, or achieves something significant.
10. When a scene naturally concludes and a new environment begins, use advance_scene.
11. Keep final narrative to 2–4 paragraphs unless the scene demands more.
12. End each final response with a clear, evocative prompt for what the players can do next.
13. Give each NPC a distinct voice. An old wizard speaks differently from a gruff dwarf mercenary.
14. In intermediate tool-call turns, write nothing or only a brief fragment. Save full prose for the final turn.
15. Use get_full_character or get_npc_details when you need backstory, inventory, or ability scores to make a meaningful narrative decision.
16. Proactively call compress_history when the conversation gets very long (> 40 messages) to keep your context sharp. The 8 most recent messages are always preserved verbatim — compression only removes older messages.

== TONE ==
Dark fantasy with moments of wonder. Build dread before combat. Celebrate victories. Make death feel real and weighty. Reference character backstories when the moment calls for it.`;
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
 * Build a human-readable status line describing pending tool calls,
 * shown to the player BEFORE the tools are executed.
 * @param {Object[]} toolCalls
 * @returns {string}
 */
function buildToolCallStatusMessage(toolCalls) {
  const msgs = toolCalls.map(tc => {
    switch (tc.tool) {
      case 'roll_dice':
        return `🎲 Rolling ${tc.notation}${tc.reason ? ` — ${tc.reason}` : ''}`;
      case 'modify_hp': {
        const ch = getCharacter(tc.characterId);
        const n  = ch?.name || 'someone';
        return tc.delta < 0
          ? `⚔️ Dealing ${Math.abs(tc.delta)} damage to ${n}`
          : `❤️ Healing ${n} for ${tc.delta} HP`;
      }
      case 'modify_xp': {
        const ch = getCharacter(tc.characterId);
        return `⭐ Awarding XP to ${ch?.name || 'the party'}`;
      }
      case 'modify_gold': {
        const ch = getCharacter(tc.characterId);
        return `💰 Updating ${ch?.name || 'character'}'s gold`;
      }
      case 'add_condition': {
        const ch = getCharacter(tc.characterId);
        return `⚠️ Adding ${tc.condition} to ${ch?.name || 'character'}`;
      }
      case 'remove_condition': {
        const ch = getCharacter(tc.characterId);
        return `✅ Removing ${tc.condition} from ${ch?.name || 'character'}`;
      }
      case 'introduce_npc':
        return `🎭 Introducing ${tc.name}`;
      case 'npc_speak': {
        const name = tc.npcName
          || (tc.npcId ? getCharacter(tc.npcId)?.name : null)
          || 'NPC';
        return `💬 ${name} speaks`;
      }
      case 'advance_scene':
        return `🗺️ New scene: ${tc.newSceneTitle}`;
      case 'create_item':
        return `📦 Creating ${tc.name}`;
      case 'add_item': {
        const ch = getCharacter(tc.characterId);
        return `🎒 Adding item to ${ch?.name || 'character'}`;
      }
      case 'remove_item': {
        const ch = getCharacter(tc.characterId);
        return `🗑️ Removing item from ${ch?.name || 'character'}`;
      }
      case 'get_full_character':
      case 'get_character_stats':
      case 'get_character_inventory': {
        const ch = getCharacter(tc.characterId);
        return `📋 Reading ${ch?.name || 'character'} sheet`;
      }
      case 'get_npc_details':
        return `📋 Reading NPC details`;
      case 'get_adventure_log': {
        const ch = getCharacter(tc.characterId);
        return `📜 Reading ${ch?.name || 'character'}'s log`;
      }
      case 'get_scene_history':
        return `🗺️ Reading scene history`;
      case 'log_event': {
        const ch = getCharacter(tc.characterId);
        return `📝 Logging event for ${ch?.name || 'character'}`;
      }
      case 'set_npc_stat':
        return `🎭 Updating NPC stats`;
      case 'compress_history':
        return `📜 Compressing history`;
      default:
        return null;
    }
  }).filter(Boolean);
  return msgs.join(' · ');
}

/**
 * Send a player message to the AI DM and return its response + any tool effects.
 *
 * Uses an AGENTIC LOOP: after the DM makes tool calls the engine executes them,
 * feeds the results back, and lets the DM continue — rolling dice, chaining item
 * creation, fetching character data, etc. — before finally producing its narrative.
 *
 * @param {string} storyId
 * @param {string} userMessage
 * @param {Function|null} onProgress  - optional callback(event) for live UI updates.
 *   event = { type: 'status', message: string }   — DM is about to do something
 *   event = { type: 'tool_result', summary: string } — a tool finished executing
 * @returns {Promise<{
 *   dmResponse: string,
 *   cleanResponse: string,
 *   toolCalls: Object[],
 *   toolCallsExecuted: Array<{tool:string, params:Object, result:any}>,
 *   toolSummaries: string[],
 *   npcSpeeches: Array<{npcId:string, npcName:string, npcRole:string, portrait:string, speech:string}>,
 *   sceneAdvanced: boolean,
 *   newSceneImagePrompt: string|null,
 *   historyCompressed: boolean,
 * }>}
 */
export async function sendDMMessage(storyId, userMessage, onProgress = null) {
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
  // Grows with each agentic iteration but is NOT persisted — only the final
  // combined narrative is saved. The working history is built from the
  // persisted dmChatHistory so compression is respected.
  let workingHistory = toGeminiHistory(story.dmChatHistory);

  // ── 4. Agentic loop ──────────────────────────────────────────
  const MAX_ITERATIONS      = 8;
  const allToolCallsExecuted = [];
  const allNarrativeParts    = [];
  let   sceneAdvance          = null;
  let   historyCompressed     = false;

  // Shared context passed to every executeDMTools call so that IDs produced by
  // create_item / introduce_npc in one iteration are available to consumers
  // (add_item / npc_speak) in later iterations without extra Gemini API calls.
  const sessionContext = { lastCreatedItemId: null, lastIntroducedNpcId: null };

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

    // If no tool calls this turn, the DM is done
    if (toolCalls.length === 0) break;

    // Notify UI of what the DM is about to do
    if (onProgress) {
      const statusMsg = buildToolCallStatusMessage(toolCalls);
      if (statusMsg) onProgress({ type: 'status', message: statusMsg });
    }

    // Execute all tool calls for this iteration
    const iterationResults = await executeDMTools(toolCalls, sessionContext);
    allToolCallsExecuted.push(...iterationResults);

    // Emit each tool result summary live so the UI can show badges immediately
    if (onProgress) {
      for (const r of iterationResults) {
        const summary = toolResultSummary(r.tool, r.params, r.result);
        if (summary) onProgress({ type: 'tool_result', summary });
      }
    }

    // Track first scene advancement
    if (!sceneAdvance) {
      sceneAdvance = iterationResults.find(r => r.tool === 'advance_scene' && r.result?.newSceneId) || null;
    }

    // Track history compression — if it happened, rebuild working history
    // from the now-compressed story so the DM's next turn uses the summary
    const compressionResult = iterationResults.find(r => r.tool === 'compress_history' && !r.result?.error);
    if (compressionResult) {
      historyCompressed = true;
      // The tool has already updated the story in db; reload it
      const compressedStory = getStory(storyId);
      if (compressedStory) {
        // Rebuild working history from the compressed version
        // (includes the summary user message but not the original flood)
        workingHistory = toGeminiHistory(compressedStory.dmChatHistory);
        // Also append the current tool result for context
        workingHistory.push({
          role: 'model',
          parts: [{ text: rawResponse }],
        });
        workingHistory.push({
          role: 'user',
          parts: [{
            text:
              `[TOOL RESULTS]\n${formatToolResultsForRePrompt(iterationResults)}\n[/TOOL RESULTS]\n\n` +
              `History compressed. Your context is now fresh. Continue with any remaining tool calls, ` +
              `or write your final narrative for the player.`,
          }],
        });
      }
      if (iteration === MAX_ITERATIONS - 1) break;
      continue;
    }

    // Feed results back so the DM can continue
    workingHistory.push({ role: 'model', parts: [{ text: rawResponse }] });
    workingHistory.push({
      role: 'user',
      parts: [{
        text:
          `[TOOL RESULTS]\n${formatToolResultsForRePrompt(iterationResults)}\n[/TOOL RESULTS]\n\n` +
          `Continue. Make additional tool calls if needed (e.g. roll damage after a hit, ` +
          `call add_item with the itemId from create_item, call npc_speak with the npcId from introduce_npc). ` +
          `When you have no more tool calls, write your complete narrative for the player.`,
      }],
    });

    if (iteration === MAX_ITERATIONS - 1) break;
  }

  // ── 5. Assemble final response ───────────────────────────────
  const finalCleanResponse = allNarrativeParts.join('\n\n').trim()
    || '*(The dungeon holds its breath...)*';

  // ── 6. Build UI summaries + NPC speeches ─────────────────────
  const toolSummaries = allToolCallsExecuted
    .map(({ tool, params, result }) => toolResultSummary(tool, params, result))
    .filter(s => s.length > 0);

  const npcSpeeches = allToolCallsExecuted
    .filter(r => r.tool === 'npc_speak' && !r.result?.error)
    .map(r => r.result);

  // ── 7. Persist final DM message + NPC speeches ───────────────
  // Reload story (tools may have mutated character/story records, or compressed history)
  const updatedStory = getStory(storyId) || story;

  updatedStory.dmChatHistory.push({
    role:         'assistant',
    content:      finalCleanResponse,
    timestamp:    Date.now(),
    toolCalls:    allToolCallsExecuted.length > 0
      ? allToolCallsExecuted.map(r => r.params)
      : undefined,
    toolSummaries: toolSummaries.length > 0 ? toolSummaries : undefined,
  });

  // NPC speeches stored as 'npc' entries (skipped by toGeminiHistory, shown in UI)
  for (const speech of npcSpeeches) {
    updatedStory.dmChatHistory.push({
      role:      'npc',
      npcId:     speech.npcId,
      npcName:   speech.npcName,
      portrait:  speech.portrait,
      content:   speech.speech,
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
    historyCompressed,
  };
}

// ── Image generation helpers ──────────────────────────────────

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
    return (sceneDesc || setting || 'fantasy scene').slice(0, 200);
  }
}

async function generateSceneImageAsync(storyId, sceneId, rawPrompt) {
  try {
    const story       = getStory(storyId);
    const setting     = story?.setting || '';
    const visualPrompt = await optimizeImagePrompt(rawPrompt, setting);

    const url = await generateImage(
      visualPrompt + ', fantasy digital art, cinematic lighting, detailed, wide angle, 16:9',
      768, 432
    );
    const updatedStory = getStory(storyId);
    if (!updatedStory) return;
    const scene = updatedStory.scenes.find(s => s.id === sceneId);
    if (scene) {
      scene.imageUrl    = url;
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
