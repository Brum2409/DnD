/**
 * dm-engine.js — Core AI Dungeon Master engine.
 *
 * Exports:
 *   buildDMSystemPrompt(story, characters) → string
 *   parseDMToolCalls(responseText)         → Object[]
 *   sendDMMessage(storyId, userMessage)    → Promise<{...}>
 */

import {
  getStory, saveStory, getCharacter, getAllItems, getItem, getSpell, getNPCsForStory,
} from './db.js';
import { geminiChat, geminiGenerate, toGeminiHistory } from './api-gemini.js';
import { generateImage } from './api-image.js';
import { getModifier, getProficiencyBonus } from './utils.js';
import { getSettings } from './settings.js';
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

    // Spell slot quick-ref for spellcasters
    let slotStr = '';
    if (ch.spellSlots && Object.keys(ch.spellSlots).length > 0) {
      const slots = Object.entries(ch.spellSlots)
        .map(([lvl, s]) => `L${lvl}:${s.total - s.used}/${s.total}${s.pactMagic ? '(P)' : ''}`)
        .join(' ');
      const knownCount = (ch.spells || []).length;
      slotStr = ` | Slots: ${slots} | Spells: ${knownCount}`;
    } else if ((ch.spells || []).length > 0) {
      slotStr = ` | Cantrips: ${ch.spells.length}`;
    }

    const deathSaveStr = ch.deathSaves
      ? ` | DEATH SAVES: ${ch.deathSaves.successes}✓/${ch.deathSaves.failures}✗ — call roll_death_save each round!`
      : '';
    return `• ${ch.name} | ID: ${ch.id} | ${ch.race} ${ch.class} Lv${ch.level} | HP: ${ch.stats.hp}/${ch.stats.maxHp} | AC: ${ch.stats.ac} | Gold: ${ch.gold}gp | XP: ${ch.xp} | Prof: +${profBonus}${slotStr}${condStr}${deathSaveStr}`;
  }).join('\n');

  // ── Compact NPC quick-reference — split by location ────────
  // Full NPC sheets available via get_npc_details.
  const knownNPCs   = getNPCsForStory(story.id);
  const sceneNpcIds = new Set(currentScene?.npcs     || []);
  const deadNpcIds  = new Set(currentScene?.deadNpcs || []);
  const sceneNPCs   = knownNPCs.filter(npc => sceneNpcIds.has(npc.id));
  const fallenNPCs  = [...deadNpcIds].map(id => getCharacter(id)).filter(Boolean);
  // Absent = known to the story but not alive in the current scene and not dead here
  const absentNPCs  = knownNPCs.filter(npc => !sceneNpcIds.has(npc.id) && !deadNpcIds.has(npc.id));

  const npcQuickRef = (knownNPCs.length > 0 || fallenNPCs.length > 0)
    ? (sceneNPCs.length > 0
        ? `\n\n== CHARACTERS IN CURRENT SCENE (quick ref — use get_npc_details for full info) ==\n` +
          sceneNPCs.map(npc => {
            const condStr = npc.conditions?.length ? ` | Cond: ${npc.conditions.join(', ')}` : '';
            return `• ${npc.name} | ID: ${npc.id} | ${npc.npcRole || npc.class} | ${npc.race} | HP: ${npc.stats.hp}/${npc.stats.maxHp}${condStr}`;
          }).join('\n')
        : '')
      + (fallenNPCs.length > 0
        ? `\n\n== FALLEN IN THIS SCENE (dead — body present, can be looted) ==\n` +
          fallenNPCs.map(npc => {
            return `• ☠ ${npc.name} | ID: ${npc.id} | ${npc.npcRole || npc.class} | ${npc.race} | HP: 0/${npc.stats.maxHp} (Dead)`;
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

  // ── Quest quick-reference ──────────────────────────────────
  const activeQuests = (story.quests || []).filter(q => q.status === 'active');
  const questQuickRef = activeQuests.length > 0
    ? `\n\n== ACTIVE QUESTS ==\n` + activeQuests.map(q => {
        const objStr = q.objectives.map((o, i) => `  ${i}. [${o.done ? '✓' : ' '}] ${o.text}`).join('\n');
        return `• "${q.title}" (questId="${q.id}")${q.giver ? ` — given by ${q.giver}` : ''}${q.reward ? ` | Reward: ${q.reward}` : ''}\n${objStr}`;
      }).join('\n')
    : '';

  // ── Combat state quick-reference ───────────────────────────
  let combatQuickRef = '';
  if (story.combat?.active) {
    const combat  = story.combat;
    const orderLines = combat.initiativeOrder.map((e, i) => {
      const char     = getCharacter(e.characterId);
      const hp       = char?.stats?.hp    ?? '?';
      const maxHp    = char?.stats?.maxHp ?? '?';
      const ac       = char?.stats?.ac    ?? '?';
      const condStr  = char?.conditions?.length ? ` | Cond: ${char.conditions.join(', ')}` : '';
      const alive    = e.isAlive ? '' : ' ☠ DEAD/OUT';
      const isCurr   = i === combat.currentTurnIndex;
      // Show full economy for the active combatant; show reaction for everyone
      // (reactions can fire on any turn — OA, Shield, Counterspell, etc.)
      const economy  = isCurr
        ? ` | ACT:${e.hasAction ? '✓' : '✗'} BON:${e.hasBonusAction ? '✓' : '✗'} REA:${e.hasReaction ? '✓' : '✗'}${e.hasExtraAction ? ' +ACT:✓' : ''} MOV:${e.movementRemaining}ft`
        : ` | REA:${e.hasReaction ? '✓' : '✗'}`;
      const marker   = isCurr ? ' ◄ ACTIVE TURN' : '';
      return `  ${i + 1}. Init:${e.initiative} | ${e.name} | ID:${e.characterId} | HP:${hp}/${maxHp} | AC:${ac}${condStr}${economy}${alive}${marker}`;
    }).join('\n');
    combatQuickRef = `\n\n== ⚔ COMBAT ACTIVE — Round ${combat.round} ==\nCurrent Turn: ${combat.initiativeOrder[combat.currentTurnIndex]?.name || '?'} (index ${combat.currentTurnIndex})\nInitiative Order:\n${orderLines}\n\nCOMBAT REMINDERS:\n• Call use_action / use_bonus_action / use_movement BEFORE narrating what the combatant does\n• Call next_turn AFTER the current combatant fully resolves their turn\n• Dead NPCs are already removed by modify_hp — call end_combat when all enemies are down`;
  }

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
• create_spell → get spellId → immediately call give_spell in your next turn
• introduce_npc → get npcId → immediately call npc_speak in your next turn
• get_full_character / get_npc_details / get_spell_slots → read → use in narration

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

EXAMPLE — combat start:
  Turn 1: enter_combat([pcId, goblinId, ...])
  [System: initiative order set, Round 1, goblin acts first]
  Turn 2: get_combat_state() — confirm who is acting
  [System: goblin is active, has Action + Bonus Action]
  Turn 3: roll_dice("1d20+4", "goblin attacks Aria")
  [System: total 14 — hits AC 13]
  Turn 4: roll_dice("1d6+2", "goblin dagger damage") + modify_hp(pcId, -5, "goblin dagger") + use_action(goblinId, "Dagger attack on Aria")
  [System: 5 damage dealt, Aria HP 11/16, action used]
  Turn 5: use_movement(goblinId, 15) + next_turn(goblinId)
  [System: goblin moved 15 ft, turn advanced to Aria]
  Turn 6: Write vivid narrative of the goblin's attack, then prompt the player for Aria's action.

EXAMPLE — combat single attack (mid-combat, PC's turn):
  Turn 1: roll_dice("1d20+5", "Aria attacks goblin")
  [System: total 18 — hits AC 13]
  Turn 2: roll_dice("1d8+3", "longsword damage") + modify_hp(goblinId, -10, "longsword strike") + use_action(pcId, "Longsword attack on goblin")
  [System: 10 damage, goblin HP 0/8 — DEAD]
  Turn 3: next_turn(pcId)
  [System: turn advances, round may increment]
  Turn 4: Write vivid narrative of the killing blow.

EXAMPLE — casting a levelled spell (e.g. Fireball):
  Turn 1: get_spell_slots(characterId) — confirm L3 slot is available
  [System: L3: 2/3 available]
  Turn 2: use_spell_slot(characterId, slotLevel=3, spellName="Fireball") + roll_dice("8d6", "Fireball damage")
  [System: slot used, damage 28]
  Turn 3: Describe the Fireball's explosion and each creature's fate.

EXAMPLE — learning a new spell:
  Turn 1: create_spell("Mage Armor", level=1, school="Abjuration", ...)
  [System: spellId="xyz789"]
  Turn 2: give_spell(characterId, "xyz789")
  [System: learned]
  Turn 3: Narrate the character inscribing the spell into their spellbook.

EXAMPLE — fetching context:
  Turn 1: get_full_character(characterId) — when you need backstory/inventory/stats
  [System: returns full sheet]
  Turn 2: Write narration that references specific details from the sheet.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== MANDATORY TOOL CALLS — NEVER SKIP ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMBAT (mandatory when story.combat is active OR when a fight starts):
• Combat breaks out (any side attacks another)          → enter_combat with ALL participating NPC IDs
• Current combatant uses their Action                   → use_action BEFORE narrating the outcome
• Current combatant uses their Bonus Action             → use_bonus_action BEFORE narrating
• Any combatant uses their Reaction off-turn            → use_reaction on the reacting combatant
• Any combatant moves during their turn                 → use_movement with feet moved
• A Fighter activates Action Surge                      → action_surge to grant extra action
• A combatant permanently leaves the fight alive        → remove_from_combat (NOT for death)
• All enemies are defeated / combat ends any way        → end_combat
• Current combatant finishes ALL their actions & move   → next_turn (MANDATORY — every single turn)
• A PC is at 0 HP and it is their turn in initiative    → roll_death_save at START of their turn
• PC at 0 HP takes damage while unconscious             → automatic death save failure (no roll needed)

GENERAL:
• Player picks up / receives an item        → add_item (create_item first if new)
• Player takes damage (any source)          → modify_hp with NEGATIVE delta
• Player heals (potion, spell, rest)        → modify_hp with POSITIVE delta
• PC drops to 0 HP (needsDeathSaves=true)  → roll_death_save at the START of each of their turns
• PC is unconscious and takes damage        → roll_death_save with result treated as one automatic failure
• NPC gives the party a clear task/mission  → create_quest with specific objectives
• Party completes a quest objective         → update_quest_objective (mark done: true)
• Quest is fully resolved (success/failure) → complete_quest, then award XP/gold
• Player earns gold                         → modify_gold positive
• Player spends / loses gold                → modify_gold negative
• Player earns XP                           → modify_xp positive
• Any attack roll                           → roll_dice (e.g. "1d20+3")
• Any skill check or saving throw           → roll_dice
• Any damage roll (after a hit)             → roll_dice (e.g. "2d6+2")
• NPC / creature takes damage               → modify_hp on that NPC's ID
• New named NPC/enemy appears              → introduce_npc
  — Unique characters (ally/merchant/neutral/boss): introduce ONCE per story.
    If already in CHARACTERS IN CURRENT SCENE or KNOWN CHARACTERS, use their
    existing ID directly — DO NOT call introduce_npc again.
  — Generic enemies/creatures (enemy/creature): call once PER INSTANCE.
    Three goblins = three introduce_npc calls, each gets its own npcId.
• NPC/enemy is killed (HP reaches 0)       → modify_hp automatically moves them to FALLEN.
  Their body stays visible in context for looting. No extra tool call needed — just narrate the death.
• Player loots a fallen enemy               → add_item (create_item first if the loot is new)
• NPC leaves the scene alive (flees, departs, exits) → remove_npc_from_scene
• NPC says ANYTHING out loud               → npc_speak (NEVER write NPC speech in narration)
• Party moves to a new location / scene     → advance_scene
• End of a significant encounter            → log_event for each character
• Character casts a levelled spell          → use_spell_slot (NOT for cantrips)
• Character completes a long rest           → restore_spell_slots (restType="long")
• Character completes a short rest (warlock)→ restore_spell_slots (restType="short")
• Character learns / receives a spell       → give_spell (create_spell first if new)
• Scene visual changes significantly        → refresh_scene_image
  (fire breaks out, dragon arrives, room transforms, weather shifts, etc.)

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
  When a PC drops to 0 HP, the result includes needsDeathSaves=true and the Unconscious condition
  is applied automatically. You MUST call roll_death_save each combat round until they stabilise or die.

- roll_death_save:  {"tool":"roll_death_save","characterId":"<id>"}
  ONLY for player characters at 0 HP. Roll at the START of each of their turns.
  Result outcomes:
    • critical_success (rolled 20): PC regains 1 HP, stands up — combat can continue
    • success (10–19): one success tallied (need 3 total to stabilise)
    • fail (2–9): one failure tallied (3 failures = death)
    • critical_fail (rolled 1): TWO failures tallied
    • stable: reached 3 successes — PC is unconscious but no longer rolling
    • dead: reached 3 failures — PC has died
  ⚠️ Call this ONCE per round per downed PC. Stop calling it when outcome is stable, dead, or critical_success.
  ⚠️ If the downed PC takes ANY damage while unconscious, add one failure instead of rolling.
  ⚠️ If an ally heals the PC (modify_hp with positive delta), death saves clear automatically.

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

MAGIC (spells and spell slots):
- create_spell:
  {"tool":"create_spell","name":"<name>","level":<0-9>,"school":"Evocation|Abjuration|Conjuration|Divination|Enchantment|Illusion|Necromancy|Transmutation","castingTime":"1 action","range":"<range>","components":"V, S","duration":"Instantaneous","concentration":<bool>,"ritual":<bool>,"description":"<effect>","damage":"<e.g. 8d6>","damageType":"fire","savingThrow":"DEX"}
  level 0 = cantrip (no slot cost). level 1–9 = levelled spell.
  → Returns spellId. Use it in give_spell in your NEXT turn.
  ⚠️ NEVER put create_spell and give_spell in the same turn.

- give_spell:       {"tool":"give_spell","characterId":"<id>","spellId":"<spell-id>"}
  Teaches the character a spell. Auto-initialises spell slots based on class/level if needed.

- remove_spell:     {"tool":"remove_spell","characterId":"<id>","spellId":"<spell-id>"}
  Removes a spell from the character's known spells.

- use_spell_slot:   {"tool":"use_spell_slot","characterId":"<id>","slotLevel":<1-9>,"spellName":"<name>"}
  Expends one spell slot. Call this whenever a character casts a levelled spell.
  Cantrips are free — never call use_spell_slot for cantrips (level 0).
  ⚠️ Always check remaining slots via the quick-ref before allowing a cast.
  A character with 0 available slots at the required level CANNOT cast that spell.

- restore_spell_slots: {"tool":"restore_spell_slots","characterId":"<id>","restType":"long|short"}
  long  = all spell slots restored (standard long rest)
  short = only Warlock Pact Magic slots restored (Warlocks recover on short rest)
  Auto-initialises slots from the class/level table if the character has none yet.

- get_spell_slots:  {"tool":"get_spell_slots","characterId":"<id>"}
  Returns all spell slot counts (available/total) and the character's known spells.
  Use before a character casts to confirm they have the slot available.

== MAGIC RULES (DnD 5e) ==
• Full casters (Wizard, Sorcerer, Druid, Cleric, Bard): spell slots L1–L9, recover on long rest.
• Half casters (Paladin, Ranger): spell slots L1–L5, recover on long rest. No slots at level 1.
• Warlocks: Pact Magic — all slots are the SAME level (rises from L1 at Lv1 to L5 at Lv9+).
  Warlocks have only 1–4 slots, but they recover on a SHORT rest (not long).
• Non-casters (Fighter, Barbarian, Rogue, Monk): NO spell slots unless subclass grants them.
• Cantrips (level 0): unlimited, no slot required — never call use_spell_slot for them.
• Upcasting: a spell can be cast using a HIGHER level slot for greater effect.
• Spell save DC: 8 + proficiency + spellcasting modifier (INT for Wizard, WIS for Cleric/Druid, CHA for Sorcerer/Bard/Warlock/Paladin).
• Concentration: only ONE concentration spell at a time. New one breaks the old.

NPC / WORLD CHARACTER:
- introduce_npc:
  {"tool":"introduce_npc","storyId":"${story.id}","name":"<name>","role":"enemy|merchant|ally|neutral|boss|creature","race":"<race>","personality":"<1-2 sentences>","appearance":"<1-2 sentences>","hp":<number>,"ac":<number>}
  → Returns npcId. Use in npc_speak immediately after.
  ⚠️ UNIQUE characters (role=ally/merchant/neutral/boss): ONLY call once per story.
     If the character is already in CHARACTERS IN CURRENT SCENE or KNOWN CHARACTERS,
     skip this tool and use npc_speak with their existing ID directly.
  ✓ GENERIC ENEMIES/CREATURES (role=enemy/creature): You MAY call this multiple times
     to create separate instances — e.g. call it 3 times for 3 Goblins, 2 times for
     2 Zombies. Each call creates a distinct combatant with its own HP/ID.

- remove_npc_from_scene:
  {"tool":"remove_npc_from_scene","storyId":"${story.id}","npcId":"<id>"}
  {"tool":"remove_npc_from_scene","storyId":"${story.id}","npcName":"<name>"}
  Removes an NPC from the current scene when they leave or flee while still alive.
  They remain a known character and can return in a future scene.
  ⚠️ Do NOT call this for NPCs who die — death is handled automatically by modify_hp.

- npc_speak:
  {"tool":"npc_speak","npcId":"<id>","speech":"What they say…"}
  {"tool":"npc_speak","npcName":"<name>","speech":"What they say…"}

SCENE IMAGE:
- refresh_scene_image: {"tool":"refresh_scene_image","storyId":"${story.id}","imageDescription":"<full visual description of scene as it NOW looks>"}
  Clears the current scene image and queues a new generation.
  Use whenever the scene LOOKS meaningfully different from when the image was last generated:
  fire, destroyed environment, new powerful presence, shift in time of day, etc.
  This does NOT advance the scene — use advance_scene when you move to a new location.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== COMBAT SYSTEM (D&D 5e) ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ACTION ECONOMY — Each combatant gets per turn:
  • 1 Action       — Attack, Cast Spell (1 action), Dash, Disengage, Dodge, Help, Hide,
                     Ready an action, Search, Use an Object, Grapple, Shove.
  • 1 Bonus Action — ONLY if a feature/spell explicitly says "as a bonus action":
                     off-hand attack (Two-Weapon Fighting), Misty Step, Cunning Action
                     (Rogue), Wild Shape (Druid), Second Wind (Fighter), Healing Word
                     (Bard), Bardic Inspiration, Shove as bonus (some classes), etc.
                     If NO feature grants a bonus action, the combatant simply has none.
  • 1 Reaction     — Triggered off-turn (Opportunity Attack, Shield spell, Counterspell,
                     Uncanny Dodge, Hellish Rebuke). Resets at start of each new round.
  • Movement       — Up to speed (usually 30ft) per turn; can split before/after action.

SPECIAL ACTION RULES:
  • Extra Attack (Fighter 5+, Ranger 5+, etc.) — multiple attack rolls in ONE Action.
    Call use_action ONCE for the whole Attack action, then roll each attack separately.
  • Action Surge (Fighter) — call action_surge to grant a second full Action once per rest.
  • Two-Weapon Fighting — main weapon as Action, off-hand as Bonus Action (no modifier).
  • Haste (spell) — grants an extra Action limited to: Attack (1 only), Dash, Disengage,
    Hide, or Use Object. Does NOT stack with Extra Attack for the extra action.
  • Readying an Action — player declares a trigger and action; resolve when trigger fires
    (uses that round's action; the reaction is used to execute when the trigger occurs).

COMBAT TOOLS:
- enter_combat:
  {"tool":"enter_combat","storyId":"${story.id}","npcIds":["id1","id2",...]}
  Starts combat. Auto-rolls initiative (1d20+DEX) for every PC in the party + all listed NPCs.
  Call the INSTANT combat breaks out (first attack, surprise, ambush). List every participating NPC ID.
  Optional: "initiativeOverrides":{"charId":20} to set a specific initiative without rolling.

- end_combat:
  {"tool":"end_combat","storyId":"${story.id}"}
  Ends combat and clears all state. Call when: all enemies defeated, party flees successfully,
  or combat resolves any other way (surrender, negotiation mid-fight, etc.).

- next_turn:
  {"tool":"next_turn","storyId":"${story.id}"}
  Advances to the next combatant in initiative order. Resets their Action, Bonus Action,
  and movement. Increments the round counter and restores all Reactions when the order wraps.
  Call AFTER the current combatant has fully resolved everything on their turn.

- use_action:
  {"tool":"use_action","storyId":"${story.id}","characterId":"<id>"}
  Mark the Action as used. Call BEFORE narrating the outcome.
  For Extra Attack: call ONCE for the full Attack action, not per individual attack roll.
  If Action Surge is active (hasExtraAction=true), the extra action is consumed first.

- use_bonus_action:
  {"tool":"use_bonus_action","storyId":"${story.id}","characterId":"<id>"}
  Mark the Bonus Action as used. Only call if the combatant's feature/spell grants one.

- use_reaction:
  {"tool":"use_reaction","storyId":"${story.id}","characterId":"<id>"}
  Mark the Reaction as used. Can be called on ANY combatant's turn (not just your own).
  Reactions restore for all at the start of each new round (handled by next_turn automatically).

- use_movement:
  {"tool":"use_movement","storyId":"${story.id}","characterId":"<id>","feet":30}
  Track feet of movement used. Movement can be split around the Action freely.
  Difficult terrain costs 2ft per 1ft moved — pass the total feet cost.

- action_surge:
  {"tool":"action_surge","storyId":"${story.id}","characterId":"<id>"}
  Grant a Fighter's Action Surge (one extra Action this turn). Verify class eligibility.
  Per 5e: once per short/long rest (twice per turn at Fighter level 17).

- remove_from_combat:
  {"tool":"remove_from_combat","storyId":"${story.id}","characterId":"<id>"}
  Remove a living combatant from the initiative order (permanent retreat, petrification, etc.).
  ⚠️ Do NOT use this for death — modify_hp handles NPC death automatically.

- set_initiative:
  {"tool":"set_initiative","storyId":"${story.id}","characterId":"<id>","initiative":<number>}
  Override a combatant's initiative and re-sort the order (surprise rounds, abilities, etc.).

- get_combat_state:
  {"tool":"get_combat_state","storyId":"${story.id}"}
  Returns full initiative order, action economy, HP, AC, conditions, and round number.
  Use to orient yourself before a complex multi-target turn.

RUNNING COMBAT — THE SEQUENCE:
  Step 1.  DM narrates the trigger (enemy charges, player is surprised, etc.)
  Step 2.  DM calls enter_combat with all participating NPC IDs. System rolls initiative.
  Step 3.  DM announces the initiative order and describes the opening moments.
  Step 4.  For each combatant's turn in order:
      a. Announce who is acting ("It's [Name]'s turn, initiative 14.")
      b. If PC turn: player declares their action(s). DM resolves.
         If NPC turn: DM decides and resolves the NPC's action.
      c. Movement → use_movement (call with feet used)
      d. Action declared → use_action, then roll dice, then apply outcomes
      e. Bonus Action (if applicable) → use_bonus_action
      f. Reaction (if triggered) → use_reaction on the reacting combatant
      g. Write vivid narration for the full turn (save this for the final no-tool turn)
      h. Death saves → if a PC is at 0 HP, call roll_death_save at START of THEIR turn
      i. Turn over → call next_turn
  Step 5.  Monitor for combat end:
      • All enemies HP = 0 / fled → call end_combat
      • All PCs at 0 HP or fled  → call end_combat
      • Any other resolution      → call end_combat
  Step 6.  Post-combat: award XP (modify_xp), loot fallen enemies, log events.

CRITICAL RULES — NEVER VIOLATE:
  ✗ NEVER skip next_turn — every turn ends with it.
  ✗ NEVER call next_turn before the current combatant's turn is fully resolved.
  ✗ NEVER grant a bonus action unless a feature explicitly says "as a bonus action".
  ✗ NEVER carry unused actions to the next turn — they are lost.
  ✗ NEVER narrate action outcomes before calling use_action.
  ✓ Reactions can trigger on ANY combatant's turn, including enemy turns.
  ✓ A downed PC (0 HP) still has a "turn" — call roll_death_save at the start of it.
  ✓ If the current combatant is dead (modify_hp brought them to 0), call next_turn
    immediately without giving them any actions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

QUEST JOURNAL:
- create_quest:
  {"tool":"create_quest","storyId":"${story.id}","title":"<title>","description":"<1-2 sentences>","giver":"<NPC name or empty>","objectives":["Objective 1","Objective 2"],"reward":"<gold/item/other or empty>"}
  Creates a quest in the party's quest journal. Call when an NPC gives the party a task or a clear goal emerges.
  → Returns questId. Keep it for update_quest_objective and complete_quest.

- update_quest_objective:
  {"tool":"update_quest_objective","storyId":"${story.id}","questId":"<id>","objectiveIndex":<0-based>,"done":true}
  Mark an objective as done when the party achieves it.

- complete_quest:
  {"tool":"complete_quest","storyId":"${story.id}","questId":"<id>","status":"completed|failed"}
  Mark the entire quest as completed or failed. Call BEFORE awarding XP/gold for the quest.

- get_quests:
  {"tool":"get_quests","storyId":"${story.id}"}
  Returns all quests (active + completed). Use to review current objectives.

META:
- compress_history:
  {"tool":"compress_history","storyId":"${story.id}"}
  Summarises all older messages into a dense adventure note, then keeps the
  most recent 8 messages verbatim so you never lose the live thread of the
  current scene. The full history is always preserved for the player.
  Use proactively when the conversation exceeds ~40 messages.`.trim();

  const s = getSettings();

  // If the user has set a full override, use it verbatim
  if (s.dm_system_prompt_override?.trim()) {
    return s.dm_system_prompt_override.trim();
  }

  // Response length rule
  const lengthRule = {
    short:    '11. Keep responses SHORT — 1 paragraph maximum. Be punchy and direct.',
    balanced: '11. Keep final narrative to 2–4 paragraphs unless the scene demands more.',
    detailed: '11. Write 3–5 paragraphs with rich sensory detail and character moments.',
    epic:     '11. Write full, immersive prose — no strict length limit. Make every scene feel like a chapter from a novel.',
  }[s.dm_response_length] || '11. Keep final narrative to 2–4 paragraphs unless the scene demands more.';

  // Tone section
  const toneText = {
    gritty:      'Gritty realism. Magic is rare and dangerous. The world is morally grey and consequences are harsh. NPCs are self-interested. Victories are hard-won and sometimes pyrrhic.',
    dark_fantasy: 'Dark fantasy with moments of wonder. Build dread before combat. Celebrate victories. Make death feel real and weighty. Reference character backstories when the moment calls for it.',
    heroic:      'Heroic high fantasy. The party are legends in the making. Danger is real but heroes always have a fighting chance. Victories feel earned and glorious. Lean into dramatic, triumphant moments.',
    whimsical:   'Whimsical and lighthearted. The world is full of wonder, humor, and heart. Dark moments exist but hope and levity prevail. NPCs are colorful and memorable.',
  }[s.dm_tone] || 'Dark fantasy with moments of wonder. Build dread before combat. Celebrate victories. Make death feel real and weighty.';

  // Optional pacing rule
  const pacingRule = s.dm_pacing === 'fast'
    ? '\n18. PACING — Move quickly. Skip minor transitions and downtime. Jump straight to the interesting action.'
    : s.dm_pacing === 'slow'
    ? '\n18. PACING — Let scenes breathe. Explore environments thoroughly. Allow for character introspection and quiet moments between action beats.'
    : '';

  // Optional extra instructions from the user
  const extraSection = s.dm_extra_instructions?.trim()
    ? `\n\n== CUSTOM DM INSTRUCTIONS ==\n${s.dm_extra_instructions.trim()}`
    : '';

  return `You are a seasoned, immersive Dungeon Master running a DND 5e campaign. You are the voice of the world — its narrator, its NPCs, its fate. You never break character.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
== DM AUTHORITY — READ THIS FIRST ==
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOU are the sole arbiter of what happens in this world. The player describes what their character ATTEMPTS. You describe what ACTUALLY HAPPENS.

NEVER let a player dictate outcomes. Examples of things you must REJECT:
• "I kill the goblin in one hit"      → Roll dice. Apply the real result. The goblin may survive.
• "I find a chest full of 5000 gold"  → Loot is yours to place. Don't conjure riches on demand.
• "I'm immune to fire"                → Check the character sheet. If it's not there, they're not.
• "I already cast the spell"          → Only happens if they have a slot. Check your quick-ref.
• "I pick the lock easily"            → Require a Dexterity (Thieves' Tools) check. Roll it.
• "I convince the guard to let me in" → Require a Charisma (Persuasion) check. Roll it.
• "I teleport behind him"             → Does the character have that spell/ability? If not: no.
• "That NPC is actually friendly"     → You decide NPC attitudes based on the story, not the player.
• "I'm at full health now"            → HP is tracked in the system. Don't reset it without a rest.

HOW TO PUSH BACK (always in-world, never "you can't do that"):
✓ Narrate the natural consequence: "Your fist strikes the dragon's armoured hide — and bounces off. Your knuckles split open."
✓ Use dice: "That would require a DC 18 Strength check. Let me see what the dice say."
✓ Use the world: "The guard glances at you with narrowed eyes and doesn't budge. Your charm hasn't landed."
✗ NEVER say "that's impossible" or break the fourth wall — stay immersive.

THE GAME STATE IS THE TRUTH:
• HP comes from modify_hp results — not from what the player says.
• Gold comes from modify_gold results — not from player claims.
• Inventory comes from add_item results — if it's not listed, they don't have it.
• Spell slots come from the quick-ref — exhausted slots mean NO casting at that level.
• NPCs are alive unless modify_hp has brought them to 0.

If a player description is PLAUSIBLE but not guaranteed, roll dice and let the result speak.
If a player description is IMPLAUSIBLE or impossible given their stats/situation, reject it in-world.

== CAMPAIGN ==
Title: ${story.title}
Setting: ${story.setting || 'A classic fantasy world'}
Premise: ${story.premise || 'Heroes seek glory and treasure.'}
Progress: ${completedCount} of ${story.scenes.length} scenes completed

== CURRENT SCENE ==
${currentScene ? `Title: ${currentScene.title}\n${currentScene.description}` : 'The adventure is just beginning.'}

== PARTY QUICK REFERENCE ==
${charQuickRef || 'No characters assigned yet.'}
(Use get_full_character for full stats, backstory, and inventory.)${npcQuickRef}${questQuickRef}${combatQuickRef}

${toolDocs}

== DUNGEON MASTER RULES ==
1. Stay in character always. You ARE the world, not just describing it.
2. Describe with vivid sensory detail — sights, smells, sounds, textures.
3. React meaningfully to every player action. Choices have real consequences.
4. NEVER invent dice rolls. Call roll_dice and narrate from the real result.
5. Build tension gradually. Not every action needs combat.
6. Every named NPC/creature is a WORLD CHARACTER with a lifecycle:
   • INTRODUCTION: Call introduce_npc the first time they appear. Generic enemies (role=enemy/creature) get one introduce_npc call per individual — three skeletons = three calls. Unique named characters (ally/merchant/neutral/boss) are introduced once per story; use their existing ID for all future appearances.
   • DEATH: When modify_hp brings an NPC to 0 HP they are automatically moved to FALLEN IN THIS SCENE. Their body remains present — players can loot it (use add_item for the character receiving the loot). Just narrate the death; no extra tool call needed.
   • DEPARTURE: When a living NPC leaves the scene (flees, exits, is dismissed), call remove_npc_from_scene. They stay known and can return later.
   • DIALOGUE: Use npc_speak for ALL spoken lines — never write NPC dialogue in narration prose.
7. ALWAYS use modify_hp for any damage or healing — for both PCs and NPCs.
8. ALWAYS use add_item when a character picks up, receives, or loots any item. Use create_item first if the item is new.
8b. ALWAYS use use_spell_slot when a character casts a levelled spell. Check the quick-ref for available slots first — if 0 remain, the character CANNOT cast that spell level and must use a different level or choose a cantrip.
8c. ALWAYS use restore_spell_slots at the end of a long rest. For Warlocks ALSO use it after a short rest.
9. ALWAYS use modify_xp when the party completes a meaningful objective, defeats enemies, or achieves something significant.
10. When a scene naturally concludes and a new environment begins, use advance_scene.
10b. When the scene's visual environment changes meaningfully mid-scene, call refresh_scene_image with a full description of what it now looks like.
${lengthRule}
12. End each final response with a clear, evocative prompt for what the players can do next.
13. Give each NPC a distinct voice. An old wizard speaks differently from a gruff dwarf mercenary.
14. In intermediate tool-call turns, write nothing or only a brief fragment. Save full prose for the final turn.
15. Use get_full_character or get_npc_details when you need backstory, inventory, or ability scores to make a meaningful narrative decision.
16. Proactively call compress_history when the conversation gets very long (> 40 messages) to keep your context sharp. The 8 most recent messages are always preserved verbatim — compression only removes older messages.
17. YOU control the world. Player messages are declarations of INTENT, never declarations of OUTCOME. Always use dice for anything uncertain, and always narrate the actual result — even if it contradicts what the player expected.
18. QUESTS: When an NPC gives the party a mission or a clear goal emerges, call create_quest with specific, achievable objectives. Track progress with update_quest_objective as goals are accomplished. Close quests with complete_quest before awarding XP or gold rewards.
19. COMBAT: Use enter_combat the instant a fight starts. Run turns strictly in initiative order using next_turn. Always call use_action / use_bonus_action / use_movement before narrating outcomes. Never grant a bonus action unless a class feature or spell explicitly allows it. End every fight with end_combat, then award XP and log events.${pacingRule}

== TONE ==
${toneText}${extraSection}`;
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
      case 'remove_npc_from_scene': {
        const name = tc.npcName
          || (tc.npcId ? getCharacter(tc.npcId)?.name : null)
          || 'NPC';
        return `🚪 ${name} leaves the scene`;
      }
      case 'npc_speak': {
        const name = tc.npcName
          || (tc.npcId ? getCharacter(tc.npcId)?.name : null)
          || 'NPC';
        return `💬 ${name} speaks`;
      }
      case 'advance_scene':
        return `🗺️ New scene: ${tc.newSceneTitle}`;
      case 'refresh_scene_image':
        return `🖼️ Refreshing scene image`;
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
      case 'create_spell':
        return `✨ Creating spell: ${tc.name}`;
      case 'give_spell': {
        const ch = getCharacter(tc.characterId);
        const sp = getSpell(tc.spellId);
        return `📖 Teaching ${sp?.name || 'a spell'} to ${ch?.name || 'character'}`;
      }
      case 'remove_spell': {
        const ch = getCharacter(tc.characterId);
        return `📖 Removing spell from ${ch?.name || 'character'}`;
      }
      case 'use_spell_slot': {
        const ch = getCharacter(tc.characterId);
        return `✨ ${ch?.name || 'character'} casts${tc.spellName ? ` ${tc.spellName}` : ''} (L${tc.slotLevel} slot)`;
      }
      case 'restore_spell_slots': {
        const ch = getCharacter(tc.characterId);
        return `🌙 Restoring spell slots for ${ch?.name || 'character'}`;
      }
      case 'get_spell_slots': {
        const ch = getCharacter(tc.characterId);
        return `📋 Checking spell slots for ${ch?.name || 'character'}`;
      }
      case 'compress_history':
        return `📜 Compressing history`;
      case 'enter_combat':
        return `⚔️ Entering combat — rolling initiative`;
      case 'end_combat':
        return `🏁 Ending combat`;
      case 'next_turn': {
        const ch = tc.characterId ? getCharacter(tc.characterId) : null;
        return ch ? `⏭️ Ending ${ch.name}'s turn` : `⏭️ Advancing turn`;
      }
      case 'use_action': {
        const ch = getCharacter(tc.characterId);
        return `⚡ ${ch?.name || 'Character'} uses their Action: ${tc.actionDescription || ''}`;
      }
      case 'use_bonus_action': {
        const ch = getCharacter(tc.characterId);
        return `⚡ ${ch?.name || 'Character'} uses Bonus Action: ${tc.actionDescription || ''}`;
      }
      case 'use_reaction': {
        const ch = getCharacter(tc.characterId);
        return `⚡ ${ch?.name || 'Character'} uses Reaction: ${tc.actionDescription || ''}`;
      }
      case 'use_movement': {
        const ch = getCharacter(tc.characterId);
        return `🏃 ${ch?.name || 'Character'} moves ${tc.feetUsed || '?'} ft`;
      }
      case 'action_surge': {
        const ch = getCharacter(tc.characterId);
        return `💥 ${ch?.name || 'Fighter'} uses Action Surge!`;
      }
      case 'remove_from_combat': {
        const ch = getCharacter(tc.characterId);
        return `🚫 Removing ${ch?.name || 'combatant'} from combat`;
      }
      case 'set_initiative': {
        const ch = getCharacter(tc.characterId);
        return `🎲 Setting initiative for ${ch?.name || 'character'}`;
      }
      case 'get_combat_state':
        return `📋 Checking combat state`;
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
  let   sceneImageRefresh     = null;
  let   historyCompressed     = false;

  // Shared context passed to every executeDMTools call so that IDs produced by
  // create_item / introduce_npc in one iteration are available to consumers
  // (add_item / npc_speak) in later iterations without extra Gemini API calls.
  const sessionContext = { lastCreatedItemId: null, lastIntroducedNpcId: null, lastCreatedSpellId: null };

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
    // Track scene image refresh (mid-scene visual update, no scene advance)
    if (!sceneImageRefresh) {
      sceneImageRefresh = iterationResults.find(r => r.tool === 'refresh_scene_image' && r.result?.needsImage) || null;
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

  // Trigger async image regeneration for mid-scene visual refresh
  const sceneImageRefreshed    = Boolean(sceneImageRefresh);
  const refreshSceneId         = sceneImageRefresh?.result?.sceneId  || null;
  const refreshSceneImagePrompt = sceneImageRefresh?.result?.imagePrompt || null;

  if (sceneImageRefreshed && refreshSceneId && refreshSceneImagePrompt) {
    generateSceneImageAsync(storyId, refreshSceneId, refreshSceneImagePrompt);
  }

  return {
    dmResponse:        finalCleanResponse,
    cleanResponse:     finalCleanResponse,
    toolCalls:         allToolCallsExecuted.map(r => r.params),
    toolCallsExecuted: allToolCallsExecuted,
    toolSummaries,
    npcSpeeches,
    sceneAdvanced,
    sceneImageRefreshed,
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
