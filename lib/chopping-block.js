'use strict';
/**
 * lib/chopping-block.js
 * The discipline-enforcement layer for EVOLVE.
 *
 * Phase 1 (this file): storage helpers + pinned context embed.
 * Phase 2: weekly evaluation, role sync, embed render/update.
 * Phase 3: coaching DMs (Monday flag + Thursday check-in) and Luccas review DM.
 * Phase 4: removal announcements (ban / kick / voluntary leave).
 *
 * Configuration is INTENTIONALLY OPTIONAL — if either CHOPPING_BLOCK_CHANNEL_ID
 * or ON_THE_BLOCK_ROLE_ID is missing, every public entry point in this module
 * early-exits with a one-time warning. This lets the code deploy ahead of the
 * channel + role being created on each environment without blocking boot.
 */

const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const config = require('./config');

const NETWORK_ACCENT = 0xe63b1e;
const WARNING_COLOR  = 0xFFD700; // gold
const BLOCK_COLOR    = 0xED4245; // red

// ─── Locked spec — do not change without explicit approval ──────────────────
const WEEKLY_THRESHOLD       = 25;         // pts/week below this = sub-threshold strike
const GHOST_DAYS             = 3;          // days of zero activity → ghost strike
const STRIKE_LIFETIME_WEEKS  = 4;          // strike stays active for N evaluations

// Optional env vars — see module docstring above.
const CHOPPING_BLOCK_CHANNEL_ID = config.choppingBlock.channelId;
const ON_THE_BLOCK_ROLE_ID      = config.choppingBlock.roleId;

// Strike history per member: { [memberId]: { strikeHistory: [...], currentStatus, exemptUntil } }
// strikeHistory entries are { week: 'YYYY-Www', reason: 'sub-threshold'|'ghost', points: number }.
// 4-week rolling window is computed from these timestamps; we never store derived counters.
const STRIKES_FILE = path.join(config.dataDir, 'strikes.json');

// Message-ID handles for the pinned posts the module owns in #callouts:
//   { contextMsgId, warningEmbedId, choppingBlockEmbedId }
// Edit-in-place pattern — same model used by the leaderboard pinned boards.
const STATE_FILE = path.join(config.dataDir, 'chopping-block-state.json');

let warnedDisabled = false;
function isConfigured() {
  const ok = !!(CHOPPING_BLOCK_CHANNEL_ID && ON_THE_BLOCK_ROLE_ID);
  if (!ok && !warnedDisabled) {
    console.warn('[chopping-block] CHOPPING_BLOCK_CHANNEL_ID and/or ON_THE_BLOCK_ROLE_ID not set — feature disabled until both are configured.');
    warnedDisabled = true;
  }
  return ok;
}

// ─── Storage helpers ────────────────────────────────────────────────────────
function loadStrikes() {
  try {
    if (fs.existsSync(STRIKES_FILE)) return JSON.parse(fs.readFileSync(STRIKES_FILE, 'utf8'));
  } catch (e) { console.error('[chopping-block] Error loading strikes:', e); }
  return {};
}

function saveStrikes(data) {
  try { fs.writeFileSync(STRIKES_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[chopping-block] Error saving strikes:', e); }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { console.error('[chopping-block] Error loading state:', e); }
  return {};
}

function saveState(data) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[chopping-block] Error saving state:', e); }
}

// ─── Pinned "what is this" context embed ────────────────────────────────────
function buildContextEmbed() {
  return new EmbedBuilder()
    .setTitle('🚨 CALLOUTS')
    .setDescription(
      'This channel calls out the men falling behind on their habits.\n\n' +
      'EVOLVE is not a chat group. It is a brotherhood of men who committed to a way of operating — build your habits daily: train, eat right, journal your trades, review your day, and engage with the men beside you.\n\n' +
      'When a member falls below that standard, **they land here.**'
    )
    .addFields(
      {
        name: '🪤 HOW YOU LAND HERE',
        value:
          'Every **Monday at 00:00 ET**, the previous week is reviewed. You land here if either of these was true:\n' +
          '• Below **25 weekly points**\n' +
          '• **No engagement** in the server for **3+ consecutive days**\n​',
      },
      {
        name: '📋 THE STRIKE SYSTEM',
        value:
          '**1st strike** → **The Warning List**. Coaching DM sent.\n' +
          '**2nd strike** (within 4 weeks) → **The Callout List**. Called out publicly until you\'re back above the line.\n​',
      },
      {
        name: '🛡️ HOW TO GET CLEAR',
        value:
          'Hit **25+ weekly points**. Show up. Live your habits and post the proof. Engage with the men beside you.\n\n' +
          'That\'s it. There\'s no negotiating with the standard.',
      },
    )
    .setColor(NETWORK_ACCENT)
    .setFooter({ text: 'The Eye is watching. Earned not given.' });
}

// Post (or edit-in-place if already exists) the pinned context embed.
// Idempotent — safe to call on every boot.
async function syncContextEmbed(client) {
  if (!isConfigured()) return;
  try {
    const channel = client.channels.cache.get(CHOPPING_BLOCK_CHANNEL_ID);
    if (!channel) {
      console.warn('[chopping-block] Channel not found in cache:', CHOPPING_BLOCK_CHANNEL_ID);
      return;
    }
    const embed = buildContextEmbed();
    const state = loadState();

    if (state.contextMsgId) {
      const existing = await channel.messages.fetch(state.contextMsgId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }

    const msg = await channel.send({ embeds: [embed] });
    await msg.pin().catch(() => {});
    state.contextMsgId = msg.id;
    saveState(state);
    console.log('[chopping-block] Posted + pinned context embed:', msg.id);
  } catch (e) {
    console.error('[chopping-block] Error syncing context embed:', e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2 — Detection + weekly evaluation
// ════════════════════════════════════════════════════════════════════════════

// ─── ET date helpers (ISO YYYY-MM-DD strings, anchored to America/New_York) ─
function todayETISO() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function mondayOfWeek(etDateISO) {
  // Anchor Monday for the week containing etDateISO. UTC noon avoids DST edge.
  const [y, m, d] = etDateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const back = (dt.getUTCDay() + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

function addDays(etDateISO, days) {
  const [y, m, d] = etDateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function nextMondayStrictlyAfter(etDateISO) {
  const [y, m, d] = etDateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  do { dt.setUTCDate(dt.getUTCDate() + 1); } while (dt.getUTCDay() !== 1);
  return dt.toISOString().slice(0, 10);
}

// "Week of June 1" style label for embed titles.
function formatWeekOf(mondayISO) {
  const [y, m, d] = mondayISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return 'Week of ' + new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric',
  }).format(dt);
}

// ─── Strike accessors ───────────────────────────────────────────────────────
function getMember(strikesData, userId) {
  if (!strikesData[userId]) {
    strikesData[userId] = { strikes: [], currentStatus: 'clear', exemptUntil: null };
  }
  return strikesData[userId];
}

// Count strikes still inside the 4-week sliding window relative to evalWeekStart.
// A strike incurred for week W is active during evals at W, W+1, W+2, W+3.
function activeStrikeCount(memberStrikes, evalWeekStartISO) {
  const cutoff = addDays(evalWeekStartISO, -(STRIKE_LIFETIME_WEEKS - 1) * 7);
  return memberStrikes.strikes.filter(s => s.weekStart >= cutoff).length;
}

// Onboarding-complete hook. Called from index.js step 5 of onboarding when
// onboardingState flips to COMPLETE. Sets exemptUntil to the next Monday
// strictly after today so the member skips the next eval and is evaluated
// for the first time on the eval AFTER that. Idempotent.
function markExemptFromOnboardingComplete(userId) {
  if (!isConfigured()) return; // No-op when feature is dormant
  if (!userId) return;
  try {
    const data = loadStrikes();
    const mem = getMember(data, userId);
    mem.exemptUntil = nextMondayStrictlyAfter(todayETISO());
    saveStrikes(data);
    console.log(`[chopping-block] markExempt: ${userId} → exemptUntil=${mem.exemptUntil}`);
  } catch (e) { console.error('[chopping-block] markExempt error:', e); }
}

// ─── Embed builders ─────────────────────────────────────────────────────────
function describeReason(entry) {
  if (entry.reason === 'sub-threshold') return `**${entry.weekly} pts** this week`;
  if (entry.reason === 'ghost') {
    if (!entry.lastSeenTs) return '**ghost** — never engaged';
    const days = Math.floor((Date.now() - entry.lastSeenTs) / 86400000);
    return `**ghost** — last seen ${days} day${days === 1 ? '' : 's'} ago`;
  }
  // carry-over: cleared this week but still inside a prior strike's lifetime
  return `${entry.weekly} pts this week (carrying a prior strike)`;
}

function buildWarningEmbed(list, evalWeekStartISO) {
  const desc = list.length
    ? list.map(e => `• **${e.name}** — ${describeReason(e)}`).join('\n')
    : '*✅ Nobody on the warning list this week.*';
  return new EmbedBuilder()
    .setTitle(`⚠️ THE WARNING LIST — ${formatWeekOf(evalWeekStartISO)}`)
    .setDescription(
      '**1st strike.** Hit **25+ weekly points** next week and you\'re cleared.\n\n' + desc
    )
    .setColor(WARNING_COLOR)
    .setFooter({ text: 'Updates every Monday 00:00 ET' });
}

function buildChoppingBlockEmbed(list, evalWeekStartISO) {
  const desc = list.length
    ? list.map(e => `• **${e.name}** — ${describeReason(e)} *(${e.activeCount} strikes in window)*`).join('\n')
    : '*✅ Nobody on the Callout List this week.*';
  return new EmbedBuilder()
    .setTitle(`🚨 THE CALLOUT LIST — ${formatWeekOf(evalWeekStartISO)}`)
    .setDescription(
      '**2+ strikes in the past 4 weeks.** Falling behind on their habits.\n\n' + desc
    )
    .setColor(BLOCK_COLOR)
    .setFooter({ text: 'Updates every Monday 00:00 ET' });
}

// Edit-in-place (or fresh-post-and-pin) for one of the rolling list embeds.
async function upsertPinnedEmbed(channel, state, key, embed) {
  if (state[key]) {
    const existing = await channel.messages.fetch(state[key]).catch(() => null);
    if (existing) { await existing.edit({ embeds: [embed] }); return; }
  }
  const msg = await channel.send({ embeds: [embed] });
  await msg.pin().catch(() => {});
  state[key] = msg.id;
}

async function syncListEmbeds(client, warningList, choppingList, evalWeekStartISO) {
  const channel = client.channels.cache.get(CHOPPING_BLOCK_CHANNEL_ID);
  if (!channel) return;
  const state = loadState();
  await upsertPinnedEmbed(channel, state, 'warningMsgId',  buildWarningEmbed(warningList, evalWeekStartISO));
  await upsertPinnedEmbed(channel, state, 'choppingMsgId', buildChoppingBlockEmbed(choppingList, evalWeekStartISO));
  saveState(state);
}

// ─── Role syncer (add/remove @Called Out) ─────────────────────────────────
async function syncOnTheBlockRole(guild, flaggedIds) {
  const role = await guild.roles.fetch(ON_THE_BLOCK_ROLE_ID).catch(() => null);
  if (!role) {
    console.warn('[chopping-block] @Called Out role not found:', ON_THE_BLOCK_ROLE_ID);
    return;
  }
  // Remove from anyone no longer flagged
  for (const [id, member] of role.members) {
    if (!flaggedIds.has(id)) {
      await member.roles.remove(role).catch(e =>
        console.error(`[chopping-block] role-remove fail (${id}):`, e.message));
    }
  }
  // Add to anyone newly flagged
  for (const id of flaggedIds) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member && !member.roles.cache.has(role.id)) {
      await member.roles.add(role).catch(e =>
        console.error(`[chopping-block] role-add fail (${id}):`, e.message));
    }
  }
}

// ─── Main entry — called on the Monday 00:00 ET tick ───────────────────────
// Reads weekly points BEFORE the reset wipes them; logs strikes for the
// just-completed week; updates @Called Out role + pinned list embeds.
async function evaluateAndApply(et, guild, client, accessors) {
  if (!isConfigured()) return { evaluated: false, reason: 'not-configured' };
  if (!accessors) return { evaluated: false, reason: 'no-accessors' };

  const {
    loadPoints, loadLastSeen,
    IGNORED_USER_IDS = [], ALL_TIER_ROLE_IDS = [],
    INACTIVITY_THRESHOLD_DAYS = GHOST_DAYS,
  } = accessors;

  // The Monday tick fires at the start of a new week — so the week we're
  // closing out has Monday anchor = today - 7 days. Strike entries are
  // labeled with that anchor so active-window math is on real calendar weeks.
  const todayMondayISO = mondayOfWeek(et.date);
  const evalWeekStart  = addDays(todayMondayISO, -7);

  console.log(`[chopping-block] evaluateAndApply: evalWeekStart=${evalWeekStart} (tick ${et.weekday} ${et.date})`);

  const points     = loadPoints ? loadPoints() : {};
  const lastSeen   = loadLastSeen ? loadLastSeen() : {};
  const strikesData= loadStrikes();
  const now        = Date.now();
  const ghostMs    = INACTIVITY_THRESHOLD_DAYS * 86400000;

  // Use the existing guild member cache. The Monday tick's earlier steps
  // (postWeeklyBoard / awardWeeklyTop3Bonuses) call guild.members.fetch()
  // and warm the cache; doing another full GUILD_MEMBERS_REQUEST here trips
  // the gateway rate limit. Fall back to a one-shot fetch only if the cache
  // is empty (cold boot edge case).
  let members = guild.members.cache;
  if (members.size === 0) {
    try { await guild.members.fetch(); members = guild.members.cache; }
    catch (e) { console.warn('[chopping-block] members.fetch fallback failed:', e.message); }
  }

  const warningList  = [];
  const choppingList = [];
  const flaggedIds   = new Set();

  for (const [memberId, member] of members) {
    if (member.user.bot) continue;
    if (IGNORED_USER_IDS.includes(memberId)) continue;
    // Must have completed onboarding (holds a tier role)
    const hasTier = ALL_TIER_ROLE_IDS.some(rid => rid && member.roles.cache.has(rid));
    if (!hasTier) continue;

    const memStrikes = getMember(strikesData, memberId);

    // Onboarding-grace exemption — skip until the second Monday after completion
    if (memStrikes.exemptUntil && memStrikes.exemptUntil > evalWeekStart) {
      console.log(`[chopping-block] ${memberId} exempt until ${memStrikes.exemptUntil} — skipping`);
      continue;
    }

    const weekly = (points[memberId]?.weekly) || 0;
    const isSubThreshold = weekly < WEEKLY_THRESHOLD;

    const lastSeenTs = lastSeen[memberId] || 0;
    const isGhost    = lastSeenTs === 0 || (now - lastSeenTs) >= ghostMs;

    const reason = isSubThreshold ? 'sub-threshold' : (isGhost ? 'ghost' : null);

    // Log a new strike for this week — idempotent (one entry per week per member).
    if (reason) {
      const dupe = memStrikes.strikes.find(s => s.weekStart === evalWeekStart);
      if (!dupe) memStrikes.strikes.push({ weekStart: evalWeekStart, reason, points: weekly });
    }

    const active = activeStrikeCount(memStrikes, evalWeekStart);
    const newStatus = active === 0 ? 'clear' : (active === 1 ? 'warning' : 'chopping-block');
    memStrikes.currentStatus = newStatus;

    if (newStatus === 'warning' || newStatus === 'chopping-block') {
      const displayName = points[memberId]?.realName || member.nickname || member.user.username;
      const entry = {
        id: memberId, name: displayName,
        weekly, reason: reason || 'carry-over',
        activeCount: active, lastSeenTs, member,
      };
      flaggedIds.add(memberId);
      (newStatus === 'warning' ? warningList : choppingList).push(entry);
    }
  }

  saveStrikes(strikesData);
  await syncOnTheBlockRole(guild, flaggedIds);
  await syncListEmbeds(client, warningList, choppingList, evalWeekStart);
  await dispatchFlagDMs(warningList, choppingList);
  await sendAdminDigest(guild, warningList, choppingList, evalWeekStart);

  console.log(`[chopping-block] evaluated: warning=${warningList.length}, choppingBlock=${choppingList.length}`);
  return {
    evaluated: true,
    evalWeekStart,
    warning: warningList.length,
    choppingBlock: choppingList.length,
    warningIds:  warningList.map(e => e.id),
    choppingIds: choppingList.map(e => e.id),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 3 — DMs (coaching tone, real consequence)
// ════════════════════════════════════════════════════════════════════════════

// Per-channel coaching prompts shown in every flag DM.
function dailyActionsBlock() {
  return (
    '**Daily actions that move you forward:**\n' +
    '• Post in `#trade-journal` — every trade you take\n' +
    '• Post in `#training` — your sessions\n' +
    '• Post in `#nutrition` — what you ate\n' +
    '• Post in `#trading-review` — show your work'
  );
}

function reasonLine(entry) {
  if (entry.reason === 'sub-threshold') return `You logged **${entry.weekly} pts** this week. The standard is **${WEEKLY_THRESHOLD}**.`;
  if (entry.reason === 'ghost') {
    if (!entry.lastSeenTs) return 'You **didn\'t engage in the server** this week.';
    const days = Math.floor((Date.now() - entry.lastSeenTs) / 86400000);
    return `You **didn't engage in the server for ${days} day${days === 1 ? '' : 's'}**.`;
  }
  // carry-over: still inside a prior strike's 4-week lifetime
  return `You logged **${entry.weekly} pts** this week. A prior strike is still active.`;
}

function buildWarningFlagDM(entry) {
  return new EmbedBuilder()
    .setTitle('🪤 YOU\'RE ON THE WARNING LIST')
    .setDescription(
      `${entry.name},\n\n` +
      reasonLine(entry) + '\n\n' +
      'You\'re now on the Warning List in `#callouts`.\n\n' +
      '**One more sub-25 week within the next 4 weeks** lands you on **The Callout List** — called out publicly until you\'re back above the line.\n\n' +
      dailyActionsBlock() + '\n\n' +
      'Hit **25+ pts next week** and you\'re cleared. The path is the same. Walk it.'
    )
    .setColor(WARNING_COLOR)
    .setFooter({ text: 'The Eye is watching. Earned not given.' });
}

function buildChoppingBlockFlagDM(entry) {
  return new EmbedBuilder()
    .setTitle('🚨 YOU\'RE ON THE CALLOUT LIST')
    .setDescription(
      `${entry.name},\n\n` +
      reasonLine(entry) + '\n\n' +
      `You now have **${entry.activeCount} active strikes** in the past 4 weeks.\n` +
      'You\'re on The Callout List in `#callouts` — **Called out publicly until you\'re back above the line.**\n\n' +
      'You can still get clear:\n\n' +
      dailyActionsBlock() + '\n\n' +
      'Hit **25+ pts next week**. Show up. Engage with the men beside you.\n\n' +
      'The standard doesn\'t move. You do.'
    )
    .setColor(BLOCK_COLOR)
    .setFooter({ text: 'The Eye is watching. Earned not given.' });
}

async function safeDM(member, embed, kind) {
  try {
    await member.send({ embeds: [embed] });
    console.log(`[chopping-block] ${kind} DM → ${member.user.tag} (${member.id})`);
  } catch (e) {
    console.error(`[chopping-block] ${kind} DM failed for ${member.id}: ${e.message}`);
  }
}

async function dispatchFlagDMs(warningList, choppingList) {
  for (const entry of warningList) {
    if (entry.member) await safeDM(entry.member, buildWarningFlagDM(entry), 'warning-flag');
  }
  for (const entry of choppingList) {
    if (entry.member) await safeDM(entry.member, buildChoppingBlockFlagDM(entry), 'chopping-block-flag');
  }
}

// ─── Admin digest (Monday DM to the guild owner) ────────────────────────────
function buildAdminDigest(warningList, choppingList, evalWeekStartISO) {
  const lines = [];
  if (choppingList.length) {
    lines.push('**🚨 CALLOUT LIST — manual review required:**');
    for (const e of choppingList) {
      const r = e.reason === 'ghost' ? 'ghost' : `${e.weekly} pts`;
      lines.push(`• **${e.name}** — ${r}, ${e.activeCount} strikes in window`);
    }
  } else {
    lines.push('*✅ Nobody on the Callout List this week.*');
  }
  lines.push('');
  if (warningList.length) {
    lines.push('**⚠️ WARNING LIST — 1st strike, no action required:**');
    for (const e of warningList) {
      const r = e.reason === 'ghost' ? 'ghost' : `${e.weekly} pts`;
      lines.push(`• **${e.name}** — ${r}`);
    }
  } else {
    lines.push('*✅ Nobody on the Warning List this week.*');
  }
  if (choppingList.length) {
    lines.push('');
    lines.push('**Suggested actions (per member):**');
    lines.push('• Give another week — take no action; they auto-re-evaluate next Monday.');
    lines.push('• Manual clear — `/adjustpoints` to clear strikes, or edit `/data/strikes.json`.');
    lines.push('• Remove from EVOLVE — kick or ban via Discord. The bot announces removals in `#callouts`.');
  }
  return new EmbedBuilder()
    .setTitle(`🚨 Callout Review — ${formatWeekOf(evalWeekStartISO)}`)
    .setDescription(lines.join('\n'))
    .setColor(BLOCK_COLOR)
    .setFooter({ text: 'Weekly review — Monday 00:00 ET' });
}

async function sendAdminDigest(guild, warningList, choppingList, evalWeekStartISO) {
  try {
    const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
    if (!owner) {
      console.warn('[chopping-block] guild owner not fetchable — skipping admin digest');
      return;
    }
    await safeDM(owner, buildAdminDigest(warningList, choppingList, evalWeekStartISO), 'admin-digest');
  } catch (e) {
    console.error('[chopping-block] admin digest error:', e);
  }
}

// ─── Thursday mid-week check-in ─────────────────────────────────────────────
// Runs every Thursday 12:00 ET. DMs any eligible member currently sub-25 with
// a coaching nudge — different copy from the Monday flag DM. Does NOT change
// any state (no strike logged, no role applied). Stand-alone behavior.
function buildThursdayCheckinDM(name, weekly) {
  const gap = Math.max(0, WEEKLY_THRESHOLD - weekly);
  return new EmbedBuilder()
    .setTitle('⏰ MID-WEEK CHECK-IN')
    .setDescription(
      `${name},\n\n` +
      `You're at **${weekly} pts** this week. The standard is **${WEEKLY_THRESHOLD}** — **${gap} pts** to go.\n\n` +
      'You\'ve got the rest of the week to close the gap. Each daily action moves you forward:\n\n' +
      dailyActionsBlock() + '\n\n' +
      'Don\'t let Sunday catch you behind. Lock in.'
    )
    .setColor(WARNING_COLOR)
    .setFooter({ text: 'The Eye is watching. Earned not given.' });
}

async function dispatchThursdayCheckin(et, guild, client, accessors) {
  if (!isConfigured()) return { dispatched: false, reason: 'not-configured' };
  if (!accessors) return { dispatched: false, reason: 'no-accessors' };
  const {
    loadPoints, IGNORED_USER_IDS = [], ALL_TIER_ROLE_IDS = [],
  } = accessors;

  const points = loadPoints ? loadPoints() : {};
  const strikesData = loadStrikes();
  let members = guild.members.cache;
  if (members.size === 0) {
    try { await guild.members.fetch(); members = guild.members.cache; } catch (_) {}
  }

  let count = 0;
  for (const [memberId, member] of members) {
    if (member.user.bot) continue;
    if (IGNORED_USER_IDS.includes(memberId)) continue;
    if (!ALL_TIER_ROLE_IDS.some(rid => rid && member.roles.cache.has(rid))) continue;

    // Same exemption rule as the Monday eval — first-week-post-onboarding skip.
    const memStrikes = getMember(strikesData, memberId);
    const evalWeekStart = mondayOfWeek(et.date);
    if (memStrikes.exemptUntil && memStrikes.exemptUntil > evalWeekStart) continue;

    const weekly = (points[memberId]?.weekly) || 0;
    if (weekly >= WEEKLY_THRESHOLD) continue;

    const displayName = points[memberId]?.realName || member.nickname || member.user.username;
    await safeDM(member, buildThursdayCheckinDM(displayName, weekly), 'thursday-checkin');
    count++;
  }
  console.log(`[chopping-block] Thursday check-in dispatched: ${count} member(s)`);
  return { dispatched: true, count };
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 4 — Removal announcements (ban / kick / voluntary leave)
// ════════════════════════════════════════════════════════════════════════════
//
// Three announcement variants share #callouts as the audit channel:
//   🪓 BANNED PERMANENTLY        — guildBanAdd, @everyone ping
//   ⚖️ REMOVED FROM EVOLVE  — kick (guildMemberRemove + audit log), @everyone ping
//   👋 HE WALKED AWAY            — voluntary leave (default), no ping
//
// Dedupe: Discord fires guildBanAdd before guildMemberRemove on a ban. The ban
// handler announces and stamps an in-memory recent-ban set; the remove handler
// checks the set and skips if present. As belt-and-suspenders, the remove
// handler waits 1.5s before checking and does an audit-log lookup for kicks.

const RECENT_BAN_TTL_MS = 10000;
const _recentBans = new Set();
function _markRecentBan(userId) {
  _recentBans.add(userId);
  setTimeout(() => _recentBans.delete(userId), RECENT_BAN_TTL_MS).unref();
}

// Exposed so the index.js guildMemberRemove handler can dedupe member-log
// entries against the guildBanAdd handler (Discord fires both on a ban).
function wasRecentBan(userId) { return _recentBans.has(userId); }

// Resolve the most human-friendly display label for a user.
// Priority: current per-server nickname → onboarding-time realName → username.
// EVOLVE's onboarding flow sets the server nickname to the member's real
// first+last name, so the nickname is the canonical "name we know each other
// by" — prefer it over anything stored elsewhere.
function _displayLabel(userId, user, nickname, accessors) {
  const username = user?.username || user?.tag || 'unknown';
  let primary = nickname || null;
  if (!primary && accessors?.loadPoints) {
    try { primary = (accessors.loadPoints()[userId] || {}).realName || null; }
    catch (_) {}
  }
  return primary ? `**${primary}** (\`@${username}\`)` : `**\`@${username}\`**`;
}

function buildBanEmbed(label, user) {
  return new EmbedBuilder()
    .setTitle('🪓 BANNED PERMANENTLY')
    .setDescription(
      label + '\n\n' +
      'EVOLVE is for men on the path.\n' +
      '**He chose not to walk it.**'
    )
    .setColor(BLOCK_COLOR)
    .setThumbnail(user?.displayAvatarURL?.() || null)
    .setTimestamp()
    .setFooter({ text: 'The standard is non-negotiable.' });
}

function buildKickEmbed(label, user) {
  return new EmbedBuilder()
    .setTitle('⚖️ REMOVED FROM EVOLVE')
    .setDescription(
      label + '\n\n' +
      'The standard doesn\'t move.\n' +
      '**He didn\'t meet it.**'
    )
    .setColor(BLOCK_COLOR)
    .setThumbnail(user?.displayAvatarURL?.() || null)
    .setTimestamp()
    .setFooter({ text: 'Earned not given.' });
}

function buildVoluntaryLeaveEmbed(label, user) {
  return new EmbedBuilder()
    .setTitle('👋 HE WALKED AWAY')
    .setDescription(
      label + '\n\n' +
      'Weak men crumble. Strong men stay the course.\n' +
      '**He chose to leave.**\n\n' +
      'EVOLVE keeps moving.'
    )
    .setColor(0x7f8c8d) // muted grey — same as @Called Out role
    .setThumbnail(user?.displayAvatarURL?.() || null)
    .setTimestamp();
}

// Fires the BANNED PERMANENTLY announcement. Called from the guildBanAdd
// event handler with the full GuildBan object — so we can read the soon-
// to-be-evicted member's server nickname from the guild cache before it's
// dropped. Also stamps the recent-ban set so the matching guildMemberRemove
// skips re-announcing.
async function announceBan(client, ban, accessors = {}) {
  if (!isConfigured()) return;
  const user = ban?.user;
  if (!user) return;
  if (user.bot) { _markRecentBan(user.id); return; }
  const ignored = accessors.IGNORED_USER_IDS || [];
  if (ignored.includes(user.id)) {
    console.log(`[chopping-block] ban announce skipped (ignored user): ${user.id}`);
    _markRecentBan(user.id); // still dedupe so remove handler also skips
    return;
  }
  _markRecentBan(user.id);
  try {
    const channel = client.channels.cache.get(CHOPPING_BLOCK_CHANNEL_ID);
    if (!channel) return;
    // Pull the soon-to-be-evicted member from the guild cache so we can use
    // their per-server nickname. Cache is still populated at the moment
    // guildBanAdd fires (guildMemberRemove fires a moment later).
    const cachedMember = ban.guild?.members.cache.get(user.id);
    const label = _displayLabel(user.id, user, cachedMember?.nickname, accessors);
    await channel.send({
      content: '@everyone',
      embeds: [buildBanEmbed(label, user)],
      allowedMentions: { parse: ['everyone'] },
    });
    console.log(`[chopping-block] announced BAN of ${user.id} (${user.username || user.tag})`);
  } catch (e) {
    console.error('[chopping-block] announceBan error:', e);
  }
}

// Handles guildMemberRemove. Distinguishes kick vs voluntary leave via audit
// log; deduplicates against announceBan via the recent-ban set.
async function handleMemberRemove(member, client, accessors = {}) {
  if (!isConfigured()) return;
  if (!member) return;
  if (member.user?.bot) return;
  const ignored = accessors.IGNORED_USER_IDS || [];
  if (ignored.includes(member.id)) {
    console.log(`[chopping-block] removal announce skipped (ignored user): ${member.id}`);
    return;
  }

  // Wait briefly for the audit log to settle AND give guildBanAdd a chance to
  // fire if this removal is from a ban.
  await new Promise(r => setTimeout(r, 1500));
  if (_recentBans.has(member.id)) return; // ban handler already announced

  let kind = 'voluntary';
  try {
    const logs = await member.guild.fetchAuditLogs({
      type: AuditLogEvent.MemberKick,
      limit: 5,
    });
    const recentKick = logs.entries.find(e =>
      e.targetId === member.id && (Date.now() - e.createdTimestamp) < 10000
    );
    if (recentKick) kind = 'kick';
  } catch (e) {
    console.warn('[chopping-block] audit-log fetch failed, treating as voluntary leave:', e.message);
  }

  try {
    const channel = client.channels.cache.get(CHOPPING_BLOCK_CHANNEL_ID);
    if (!channel) return;
    const label = _displayLabel(member.id, member.user, member.nickname, accessors);
    if (kind === 'kick') {
      await channel.send({
        content: '@everyone',
        embeds: [buildKickEmbed(label, member.user)],
        allowedMentions: { parse: ['everyone'] },
      });
      console.log(`[chopping-block] announced KICK of ${member.id}`);
    } else {
      await channel.send({ embeds: [buildVoluntaryLeaveEmbed(label, member.user)] });
      console.log(`[chopping-block] announced VOLUNTARY LEAVE of ${member.id}`);
    }
  } catch (e) {
    console.error('[chopping-block] handleMemberRemove send error:', e);
  }
}

module.exports = {
  // Phase 1
  isConfigured,
  syncContextEmbed,
  loadStrikes,
  saveStrikes,
  loadState,
  saveState,
  STRIKES_FILE,
  STATE_FILE,
  CHOPPING_BLOCK_CHANNEL_ID,
  ON_THE_BLOCK_ROLE_ID,
  // Phase 2
  evaluateAndApply,
  markExemptFromOnboardingComplete,
  // Phase 3
  dispatchThursdayCheckin,
  // Phase 4
  announceBan,
  handleMemberRemove,
  wasRecentBan,
  // Phase 5 backfill helper — render the two list embeds with empty
  // placeholder data so a freshly-deployed environment shows all three
  // pinned messages in #callouts before the first Monday eval.
  // No state mutation, no DMs.
  ensureListEmbeds: async (client) => {
    if (!isConfigured()) return { rendered: false, reason: 'not-configured' };
    const evalWeekStart = addDays(mondayOfWeek(todayETISO()), -7);
    await syncListEmbeds(client, [], [], evalWeekStart);
    return { rendered: true, evalWeekStart };
  },
  // Helpers (exported for unit-style verification + future phases)
  mondayOfWeek,
  addDays,
  nextMondayStrictlyAfter,
  todayETISO,
  activeStrikeCount,
  WEEKLY_THRESHOLD,
  GHOST_DAYS,
  STRIKE_LIFETIME_WEEKS,
};
