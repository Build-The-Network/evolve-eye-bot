const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');

const NETWORK_ACCENT = 0xe63b1e;

// ─── Ignored users (test bots, etc.) — never award points, never show on leaderboards ──
const IGNORED_USER_IDS = config.ignoredUserIds;

const LEADERBOARD_CHANNEL_ID   = config.channels.leaderboard;
const ANNOUNCEMENTS_CHANNEL_ID = config.channels.announcements;
const LOG_ACCOUNTABILITY_ID    = config.logChannels.accountability;
const LOG_POINTS_AUDIT_ID      = config.logChannels.pointsAudit;
const POINTS_FILE              = path.join(config.dataDir, 'points.json');
// Pinned, edit-in-place BOARDS in #leaderboard (Phase 6 model).
const DAILY_BOARD_MSG_FILE     = path.join(config.dataDir, 'daily_board_msg.json');
const WEEKLY_BOARD_MSG_FILE    = path.join(config.dataDir, 'weekly_board_msg.json');
// Rolling @everyone recognition pings in #announcements.
// Daily Leader: Mon–Sat (suppressed on the WEEKLY_LEADERBOARD_DAY tick).
// Weekly Winners: every WEEKLY_LEADERBOARD_DAY — rolling so #announcements
// stays clean across consecutive Mondays.
const DAILY_LEADER_MSG_FILE    = path.join(config.dataDir, 'daily_leader_msg.json');
const WEEKLY_WINNERS_MSG_FILE  = path.join(config.dataDir, 'weekly_winners_msg.json');
// Single rolling reminder in #events. All scheduled-event reminders share
// one file — only one reminder ever lives in #events at a time.
const EVENTS_REMINDER_MSG_FILE = path.join(config.dataDir, 'events_reminder_msg.json');
// Per-day per-event-per-offset dedupe sentinel for the data-driven reminder
// loop. Overwritten on each new ET date; bounded growth.
const REMINDER_FIRED_FILE      = path.join(config.dataDir, 'last_event_reminders.json');
// Source of truth for the event schedule (written by /setevents, read by the
// scheduled-reminder loop AND the pinned schedule embeds in #events and
// #world-clock).
const EVENTS_SCHEDULE_FILE     = path.join(config.dataDir, 'events-schedule.json');
// Once-per-ET-date sentinel for runMidnightTasks (production dedupe guard).
const MIDNIGHT_RUN_FILE        = path.join(config.dataDir, 'last_midnight_run.json');

// Weekly leaderboard runs on this America/New_York weekday at 00:00.
// Daily standings + daily-leader announcements are suppressed on the same tick.
// Change here to shift the overlap day; both blocks stay coherent.
const WEEKLY_LEADERBOARD_DAY = 'Monday';

const WARNING_THRESHOLD_WEEKLY = 25;

const LEADERBOARD_BONUS = {
  DAILY_FIRST:   5,
  WEEKLY_FIRST:  15,
  WEEKLY_SECOND: 10,
  WEEKLY_THIRD:  5,
};

function loadPoints() {
  try {
    if (fs.existsSync(POINTS_FILE)) return JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
  } catch (e) { console.error('Error loading points:', e); }
  return {};
}

function savePoints(data) {
  try { fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Error saving points:', e); }
}

function addBonusPoints(userId, amount) {
  if (IGNORED_USER_IDS.includes(userId)) return { allTime: 0, weekly: 0 };
  const data = loadPoints();
  if (!data[userId]) data[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {} };
  data[userId].allTime += amount;
  data[userId].weekly  += amount;
  savePoints(data);
  return data[userId];
}

function loadMsgId(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).msgId || null;
  } catch (e) {}
  return null;
}

function saveMsgId(file, msgId) {
  try { fs.writeFileSync(file, JSON.stringify({ msgId })); }
  catch (e) { console.error('Error saving message ID:', e); }
}

// ─── Midnight tick dedupe guard ─────────────────────────────────────────────
// Models the proven hasReminderFired/markReminderFired pattern used for NY AM
// reminders. Keyed on the ET calendar date so it survives DST shifts and bot
// restarts. Single-entry file (overwrite, no history) — bounded growth.
// Closes two production double-award vectors:
//   1. Bot restart inside the 00:00 ET minute → second process's first tick
//      lands in the same minute and would re-run the midnight tasks.
//   2. Midnight tasks taking >60s → setInterval doesn't await async callbacks,
//      so the next tick fires concurrently before the first run finishes.
function hasMidnightFired(etDate) {
  try {
    if (fs.existsSync(MIDNIGHT_RUN_FILE)) {
      const data = JSON.parse(fs.readFileSync(MIDNIGHT_RUN_FILE, 'utf8'));
      return data && data.date === etDate;
    }
  } catch (_) {}
  return false;
}
function markMidnightFired(etDate) {
  try { fs.writeFileSync(MIDNIGHT_RUN_FILE, JSON.stringify({ date: etDate })); }
  catch (e) { console.error('Error marking midnight fired:', e); }
}

// After channel.send().pin(), Discord inserts a system message ("X pinned a
// message to this channel") at the bottom of the channel. We use #leaderboard
// as a clutter-free silent-board surface — clean these system messages up.
// Bot deletes its own system messages without needing Manage Messages.
async function deletePinSystemMessage(channel) {
  try {
    const recent = await channel.messages.fetch({ limit: 5 });
    const cutoff = Date.now() - 15000; // only sweep the just-created one
    for (const m of recent.values()) {
      // Discord MessageType.ChannelPinnedMessage = 6
      if (m.type === 6 && m.createdTimestamp >= cutoff) {
        await m.delete().catch(() => {});
      }
    }
  } catch (_) {}
}

// Delete the message whose ID is stored in `msgFile`, then clear the stored ID
// so subsequent loads return null. Safe to call when the file is missing or
// the referenced message was already deleted — both fetch and delete have
// independent catches. Used by the overlap-night cleanup path.
async function deleteLingeringMessage(channel, msgFile) {
  if (!channel) return false;
  const prevMsgId = loadMsgId(msgFile);
  if (!prevMsgId) return false;
  const prev = await channel.messages.fetch(prevMsgId).catch(() => null);
  if (prev) await prev.delete().catch(() => {});
  try { fs.unlinkSync(msgFile); } catch (_) {}
  return true;
}

// ─── Daily Leader bonus (extracted) ──────────────────────────────────────────
// Determines today's daily-points #1, awards +DAILY_FIRST, updates their role
// tier, and logs to the points-audit channel. Does NOT post to #announcements.
// Returns { id, name, member, updated } on award, or null if no eligible winner.
//
// MUST be called BEFORE resetDailyPoints() — once daily is wiped there's no
// winner to determine.
async function awardDailyLeaderBonus(guild, client, updateMemberRole) {
  try {
    const data = loadPoints();
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, daily: d.daily || 0, weekly: d.weekly || 0, allTime: d.allTime || 0, inactive: d.inactive }))
      .filter(d => d.daily > 0 && !d.inactive && !IGNORED_USER_IDS.includes(d.id))
      .sort((a, b) => b.daily - a.daily || b.weekly - a.weekly || b.allTime - a.allTime);

    if (!sorted.length) return null;

    const top = sorted[0];
    const member = await guild.members.fetch(top.id).catch(() => null);
    if (!member) return null;

    const updated = addBonusPoints(top.id, LEADERBOARD_BONUS.DAILY_FIRST);
    if (updateMemberRole) await updateMemberRole(member, updated.allTime);
    const name = member.nickname || member.user.username;
    console.log(`Daily bonus +${LEADERBOARD_BONUS.DAILY_FIRST} pts awarded to ${name}`);

    // Audit log
    const auditChannel = client.channels.cache.get(LOG_POINTS_AUDIT_ID);
    if (auditChannel) {
      await auditChannel.send({ embeds: [new EmbedBuilder()
        .setTitle('🪙 Points Awarded — Daily Leader Bonus')
        .addFields(
          { name: 'Member',   value: name,                                    inline: true },
          { name: 'Amount',   value: `+${LEADERBOARD_BONUS.DAILY_FIRST} pts`, inline: true },
          { name: 'All-Time', value: `${updated.allTime} pts`,                inline: true },
        )
        .setColor(0x57F287).setTimestamp()
      ]});
    }

    return { id: top.id, name, member, updated };
  } catch (e) {
    console.error('Error awarding daily leader bonus:', e);
    return null;
  }
}

// ─── Daily standings BOARD (silent, pinned, edit-in-place in #leaderboard) ──
// Mirrors postAllTimeLeaderboard's edit-first / fallback-post-and-pin shape.
// ALWAYS renders — placeholder when no daily entries (never blank or stale).
// No @everyone, no #announcements.
async function postDailyBoard(guild, client) {
  try {
    const channel = client.channels.cache.get(LEADERBOARD_CHANNEL_ID);
    if (!channel) return;

    const data   = loadPoints();
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, daily: d.daily || 0, weekly: d.weekly || 0, allTime: d.allTime || 0, inactive: d.inactive }))
      .filter(d => d.daily > 0 && !d.inactive && !IGNORED_USER_IDS.includes(d.id))
      .sort((a, b) => b.daily - a.daily || b.weekly - a.weekly || b.allTime - a.allTime)
      .slice(0, 15);

    const medals = ['🥇','🥈','🥉'];
    let description;
    if (!sorted.length) {
      description = '*No daily points yet today. Get in the logs.*';
    } else {
      const lines = await Promise.all(sorted.map(async (entry, i) => {
        const member = await guild.members.fetch(entry.id).catch(() => null);
        const name   = member?.nickname || member?.user?.username || 'Unknown';
        const medal  = medals[i] || `${i + 1}.`;
        return `${medal} **${name}** — ${entry.daily} pts today`;
      }));
      description = lines.join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 Daily Standings — ${formatETToday()}`)
      .setDescription(description)
      .setColor(NETWORK_ACCENT)
      .setFooter({ text: 'Updates live. Daily points reset at midnight ET. Weekly resets Monday.' })
      .setTimestamp();

    // Edit-in-place first; fall back to post-fresh-and-pin (handles fresh
    // volume, manually-deleted board, or missing stored ID).
    const savedMsgId = loadMsgId(DAILY_BOARD_MSG_FILE);
    if (savedMsgId) {
      const existing = await channel.messages.fetch(savedMsgId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }
    const msg = await channel.send({ embeds: [embed] });
    await msg.pin().catch(() => {});
    await deletePinSystemMessage(channel);
    saveMsgId(DAILY_BOARD_MSG_FILE, msg.id);
  } catch (e) { console.error('Error updating daily board:', e); }
}

// ─── Daily Leader recognition ping (rolling @everyone in #announcements) ────
// Suppressed on the WEEKLY_LEADERBOARD_DAY tick (runMidnightTasks skips it
// + deletes any lingering prior ping). The +5 award lives in
// awardDailyLeaderBonus and fires regardless.
async function postDailyLeaderPing(client, winner) {
  try {
    const channel = client.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);
    if (!channel || !winner) return;

    const prevLeaderId = loadMsgId(DAILY_LEADER_MSG_FILE);
    if (prevLeaderId) {
      const prev = await channel.messages.fetch(prevLeaderId).catch(() => null);
      if (prev) await prev.delete().catch(() => {});
    }
    const leaderMsg = await channel.send({
      content: '@everyone',
      embeds: [new EmbedBuilder()
        .setTitle(`🥇 Daily Leader — ${winner.name}`)
        .setDescription(
          `**${winner.name}** topped today\'s leaderboard.\n\n` +
          `*+${LEADERBOARD_BONUS.DAILY_FIRST} bonus points awarded. All-time: **${winner.updated.allTime} pts***`
        )
        .setColor(NETWORK_ACCENT)
        .setThumbnail(winner.member.user.displayAvatarURL())
        .setTimestamp()
      ]
    });
    saveMsgId(DAILY_LEADER_MSG_FILE, leaderMsg.id);
  } catch (e) { console.error('Error posting daily leader ping:', e); }
}

// ─── Weekly Final-Standings BOARD (silent, pinned, edit-in-place) ───────────
// Mirrors postAllTimeLeaderboard's edit-first / fallback-post-and-pin pattern.
// ALWAYS renders — placeholder when nobody has earned weekly points yet.
//
// Filter: d.weekly > 0 (matches Daily board's d.daily > 0 semantics). After
// Monday's resetWeeklyPoints, everyone is at weekly=0 → board flips to
// placeholder until the first scoring post of the new week. No ⚠️ at-risk
// warnings on the public board — those surface in #callouts (the
// Chopping Block module owns sub-threshold + ghost flagging end to end).
async function postWeeklyBoard(guild, client) {
  try {
    const channel = client.channels.cache.get(LEADERBOARD_CHANNEL_ID);
    if (!channel) return;

    const data   = loadPoints();
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, weekly: d.weekly || 0, allTime: d.allTime || 0, inactive: d.inactive }))
      .filter(d => d.weekly > 0 && !d.inactive && !IGNORED_USER_IDS.includes(d.id))
      .sort((a, b) => b.weekly - a.weekly);

    const medals = ['🥇','🥈','🥉'];
    let description;
    if (!sorted.length) {
      description = '*No points yet this week. Get to work.*';
    } else {
      const lines = await Promise.all(sorted.slice(0, 15).map(async (entry, i) => {
        const member = await guild.members.fetch(entry.id).catch(() => null);
        const name   = member?.nickname || member?.user?.username || 'Unknown';
        const medal  = medals[i] || `${i + 1}.`;
        return `${medal} **${name}** — ${entry.weekly} pts this week`;
      }));
      description = lines.join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Weekly Standings — ${formatETWeekOf()}`)
      .setDescription(description)
      .setColor(NETWORK_ACCENT)
      .setFooter({ text: 'Updates live. Resets Monday midnight ET.' })
      .setTimestamp();

    const savedMsgId = loadMsgId(WEEKLY_BOARD_MSG_FILE);
    if (savedMsgId) {
      const existing = await channel.messages.fetch(savedMsgId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }
    const msg = await channel.send({ embeds: [embed] });
    await msg.pin().catch(() => {});
    await deletePinSystemMessage(channel);
    saveMsgId(WEEKLY_BOARD_MSG_FILE, msg.id);
  } catch (e) { console.error('Error updating weekly board:', e); }
}

// ─── Weekly top-3 bonus awards (extracted) ───────────────────────────────────
// Awards WEEKLY_FIRST/SECOND/THIRD + logs to points-audit. Posts nothing to
// #announcements. Returns { winnerLines, resolvedTop3, sortedAll } so the
// caller can post the Winners ping and run the warning-DM pass.
async function awardWeeklyTop3Bonuses(guild, client, updateMemberRole) {
  const data   = loadPoints();
  const sorted = Object.entries(data)
    .map(([id, d]) => ({ id, weekly: d.weekly || 0, allTime: d.allTime || 0 }))
    .filter(d => d.allTime > 0 && !d.inactive && !IGNORED_USER_IDS.includes(d.id))
    .sort((a, b) => b.weekly - a.weekly);

  if (!sorted.length) return { winnerLines: [], resolvedTop3: [], sortedAll: [] };

  const top3 = await Promise.all(sorted.slice(0, 3).map(async (entry) => {
    const member = await guild.members.fetch(entry.id).catch(() => null);
    const name   = member?.nickname || member?.user?.username || 'Unknown';
    return { ...entry, name, member };
  }));

  const bonuses = [
    { pts: LEADERBOARD_BONUS.WEEKLY_FIRST,  label: '🥇 1st' },
    { pts: LEADERBOARD_BONUS.WEEKLY_SECOND, label: '🥈 2nd' },
    { pts: LEADERBOARD_BONUS.WEEKLY_THIRD,  label: '🥉 3rd' },
  ];

  const winnerLines = [];
  for (let i = 0; i < top3.length; i++) {
    const entry = top3[i];
    if (!entry.member) continue;
    const updated = addBonusPoints(entry.id, bonuses[i].pts);
    if (updateMemberRole) await updateMemberRole(entry.member, updated.allTime);
    console.log(`Weekly bonus ${bonuses[i].label} +${bonuses[i].pts} pts awarded to ${entry.name}`);

    const auditChannel = client.channels.cache.get(LOG_POINTS_AUDIT_ID);
    if (auditChannel) {
      await auditChannel.send({ embeds: [new EmbedBuilder()
        .setTitle(`🪙 Points Awarded — Weekly ${bonuses[i].label} Bonus`)
        .addFields(
          { name: 'Member',   value: entry.name,                inline: true },
          { name: 'Amount',   value: `+${bonuses[i].pts} pts`,  inline: true },
          { name: 'All-Time', value: `${updated.allTime} pts`,  inline: true },
        )
        .setColor(0xFFD700).setTimestamp()
      ]});
    }

    winnerLines.push(`${bonuses[i].label} **${entry.name}** — ${entry.weekly} pts (+${bonuses[i].pts} bonus)`);
  }

  return { winnerLines, resolvedTop3: top3, sortedAll: sorted };
}

// ─── Weekly Winners recognition ping (rolling @everyone, #announcements) ────
// Each WEEKLY_LEADERBOARD_DAY (Monday 00:00 ET) tick deletes the previous
// week's Winners post before posting the new one, keeping #announcements
// clean across consecutive Mondays.
async function postWeeklyWinnersPing(client, winnerLines) {
  if (!winnerLines || !winnerLines.length) return;
  const announcementsChannel = client.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);
  if (!announcementsChannel) return;
  try {
    const prevWinnersId = loadMsgId(WEEKLY_WINNERS_MSG_FILE);
    if (prevWinnersId) {
      const prev = await announcementsChannel.messages.fetch(prevWinnersId).catch(() => null);
      if (prev) await prev.delete().catch(() => {});
    }
    const msg = await announcementsChannel.send({
      content: '@everyone',
      embeds: [new EmbedBuilder()
        .setTitle('🏆 Weekly Leaderboard Winners')
        .setDescription(
          `This week\'s top performers:\n\n${winnerLines.join('\n')}\n\n` +
          `*Bonus points awarded. Keep grinding next week.*`
        )
        .setColor(NETWORK_ACCENT)
        .setTimestamp()
      ]
    });
    saveMsgId(WEEKLY_WINNERS_MSG_FILE, msg.id);
  } catch (e) { console.error('Error posting weekly winners ping:', e); }
}


// ─── Reminder-fire dedupe (per-day per-key) ─────────────────────────────────
// Module-scope so both the natural scheduler tick AND the staging test
// endpoint can reach it. File overwrites on each new ET date — bounded.
function loadReminders() {
  try {
    if (fs.existsSync(REMINDER_FIRED_FILE)) return JSON.parse(fs.readFileSync(REMINDER_FIRED_FILE, 'utf8'));
  } catch (_) {}
  return {};
}
function hasReminderFired(etDate, key) {
  const data = loadReminders();
  return !!(data[etDate] && data[etDate][key]);
}
function markReminderFired(etDate, key) {
  // Keep only today's date — prevents unbounded growth across years.
  const data = { [etDate]: { ...(loadReminders()[etDate] || {}), [key]: true } };
  try { fs.writeFileSync(REMINDER_FIRED_FILE, JSON.stringify(data)); } catch (_) {}
}

// ─── Event schedule parsers (free-text → structured) ───────────────────────
// time field examples accepted:
//   "11:30 AM", "11:30 AM ET", "11:30 AM - 12:30 PM ET", "9:00am", "9:00 PM CT"
// Returns { hour, minute } in 24h (start time if a range), or null if
// unparseable / TBD / empty.
function parseEventTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  // Take the part before any " - " or " – " (en-dash) — start of a range.
  const startStr = timeStr.split(/\s*[-–]\s*/)[0].trim();
  // Strip a trailing timezone abbreviation. Two patterns to handle both cases
  // without eating the AM/PM token itself:
  //   "11:30 AM ET"  → strip "ET" only when preceded by AM/PM
  //   "13:30 ET"     → strip lone trailing TZ when there's no AM/PM at all
  // The bug we're avoiding: a naive `\s+[A-Z]{2,5}$` on "2:15 PM" (after a
  // range split that already removed the TZ) would strip "PM" thinking it's
  // a TZ, and the time would be interpreted as 2:15 AM.
  let cleaned = startStr.replace(/(\b(?:AM|PM)\b)\s+[A-Z]{2,5}$/i, '$1').trim();
  if (!/\b(?:AM|PM)\b/i.test(cleaned)) {
    cleaned = cleaned.replace(/\s+[A-Z]{2,5}$/, '').trim();
  }
  const m = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const period = m[3] ? m[3].toUpperCase() : null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  if (period === 'AM') { if (hour === 12) hour = 0; }
  else if (period === 'PM') { if (hour !== 12) hour += 12; }
  // No period given → accept as 24h (e.g. "13:30")
  return { hour, minute };
}

// days field examples accepted:
//   "Mon-Fri", "Mon/Wed/Fri", "Mon, Wed, Fri", "Daily", "Every day",
//   "Weekdays", "Weekends", "Mondays", "Mon", "Sun"
// Returns a Set of full weekday names ('Sunday', 'Monday', …), or null if
// the string is unparseable / empty.
const DAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_TO_IDX = {
  sun:0, sunday:0, suns:0, sundays:0,
  mon:1, monday:1, mons:1, mondays:1,
  tue:2, tues:2, tuesday:2, tuesdays:2,
  wed:3, weds:3, wednesday:3, wednesdays:3,
  thu:4, thur:4, thurs:4, thursday:4, thursdays:4,
  fri:5, friday:5, fris:5, fridays:5,
  sat:6, saturday:6, sats:6, saturdays:6,
};
function parseEventDays(daysStr) {
  if (!daysStr || typeof daysStr !== 'string') return null;
  const s = daysStr.trim().toLowerCase();
  if (!s) return null;
  if (s === 'daily' || s === 'every day' || s === 'everyday' || s === 'all days') {
    return new Set(DAY_FULL);
  }
  if (s === 'weekdays' || s === 'weekday') {
    return new Set(['Monday','Tuesday','Wednesday','Thursday','Friday']);
  }
  if (s === 'weekends' || s === 'weekend') {
    return new Set(['Saturday','Sunday']);
  }
  // Range form like "Mon-Fri" or "Tue–Thu"
  const rangeMatch = s.match(/^([a-z]+)\s*[-–]\s*([a-z]+)$/);
  if (rangeMatch) {
    const a = DAY_TO_IDX[rangeMatch[1]];
    const b = DAY_TO_IDX[rangeMatch[2]];
    if (a !== undefined && b !== undefined) {
      const out = new Set();
      let i = a;
      // Walk forward (wrap through Saturday if needed, max 7 steps)
      for (let n = 0; n < 7; n++) { out.add(DAY_FULL[i]); if (i === b) break; i = (i + 1) % 7; }
      return out;
    }
  }
  // List form: "Mon/Wed/Fri" or "Mon, Wed, Fri" or "Mon Wed Fri"
  const tokens = s.split(/[\s,/]+/).filter(Boolean);
  const out = new Set();
  for (const t of tokens) {
    const idx = DAY_TO_IDX[t];
    if (idx === undefined) return null; // any unknown token → reject
    out.add(DAY_FULL[idx]);
  }
  return out.size ? out : null;
}

// Load the scheduled events from /data/events-schedule.json. Returns array
// of { name, time, days, reminders? } or [] on missing/malformed file.
function loadScheduledEvents() {
  try {
    if (!fs.existsSync(EVENTS_SCHEDULE_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(EVENTS_SCHEDULE_FILE, 'utf8'));
    return Array.isArray(data?.events) ? data.events : [];
  } catch (e) {
    console.error('[reminder] Error loading events schedule:', e.message);
    return [];
  }
}

// Default reminder offsets (minutes before event start) for any event in
// events-schedule.json that doesn't specify its own. Per-event override:
// add a "reminders": [30, 5] field to the event in events-schedule.json.
const DEFAULT_REMINDER_OFFSETS = [30, 5];

// Compute the list of reminder fires that should happen at this ET tick.
// Returns array of { eventName, kind: '<N>-min', offset: N }.
function getReminderHitsForTick(et) {
  const hits = [];
  const events = loadScheduledEvents();
  if (!events.length) return hits;
  const nowMinutes = et.hour * 60 + et.minute;
  for (const ev of events) {
    if (!ev || !ev.name) continue;
    const days = parseEventDays(ev.days);
    if (!days || !days.has(et.weekday)) continue;
    const t = parseEventTime(ev.time);
    if (!t) continue;
    const offsets = Array.isArray(ev.reminders) && ev.reminders.length
      ? ev.reminders.filter(n => Number.isFinite(n) && n > 0 && n < 24 * 60)
      : DEFAULT_REMINDER_OFFSETS;
    const startMinutes = t.hour * 60 + t.minute;
    for (const offset of offsets) {
      // Wrap into [0, 1440) so events shortly after midnight work even when
      // their reminder offset crosses midnight.
      const remMinutes = (startMinutes - offset + 24 * 60) % (24 * 60);
      if (remMinutes === nowMinutes) {
        hits.push({ eventName: ev.name, kind: `${offset}-min`, offset });
      }
    }
  }
  return hits;
}

// ─── Rolling event reminder in #events ──────────────────────────────────────
// Same single-chain rolling delete-then-post pattern as Daily Leader / Weekly
// Winners pings. Per-event name + per-offset content. Exactly ONE reminder
// lives in #events at any moment, regardless of which event or offset.
async function fireEventsReminder(eventsChannel, kind, eventName, warRoomId) {
  if (!eventsChannel || !eventName) return;
  // kind is e.g. '30-min' or '5-min'. Use a human-readable phrase in the post.
  const m = String(kind).match(/^(\d+)-min$/);
  const minutes = m ? parseInt(m[1], 10) : null;
  if (minutes === null) { console.error('[reminder] unknown kind:', kind); return; }
  const isShortNotice = minutes <= 10;
  const content = isShortNotice
    ? `🎙️ @everyone — **${eventName}** starts in ${minutes} minutes. Get in war room.`
    : `🎙️ @everyone — **${eventName}** starts in ${minutes} minutes.\n\nWar room: <#${warRoomId}>\n\nCameras on. Audio on. See you in there.`;
  try {
    const prevId = loadMsgId(EVENTS_REMINDER_MSG_FILE);
    if (prevId) {
      const prev = await eventsChannel.messages.fetch(prevId).catch(() => null);
      if (prev) await prev.delete().catch(() => {});
    }
    const msg = await eventsChannel.send(content);
    saveMsgId(EVENTS_REMINDER_MSG_FILE, msg.id);
    console.log(`[reminder] "${eventName}" ${kind} sent (rolling)`);
  } catch (e) {
    console.error(`[reminder] "${eventName}" ${kind} send failed:`, e.message);
  }
}

// ─── Scheduled reminders orchestrator (data-driven from /setevents) ────────
// Called every minute by the scheduler tick AND by the staging test endpoint.
// Reads events-schedule.json, computes which fires apply NOW, and fires them
// with per-day per-event-per-offset dedupe.
async function runScheduledReminders(et, eventsChannel, warRoomId) {
  if (!eventsChannel) return;
  const hits = getReminderHitsForTick(et);
  for (const hit of hits) {
    const key = `event:${hit.eventName}:${hit.kind}`;
    if (hasReminderFired(et.date, key)) continue;
    markReminderFired(et.date, key);
    await fireEventsReminder(eventsChannel, hit.kind, hit.eventName, warRoomId);
  }
}

// ─── One-time sweep of obsolete pre-Phase-6 #announcements rolling posts ───
// On every boot, calls deleteLingeringMessage for the obsolete daily_msg.json
// and weekly_msg.json paths. deleteLingeringMessage's first action is
// loadMsgId(file) — if the file is missing or the stored ID is gone the call
// no-ops. So after the first successful run (which deletes the lingering post
// AND unlinks the file), every subsequent boot self-guards via file absence.
// No separate sentinel needed.
async function sweepObsoleteAnnouncementsFiles(client) {
  try {
    const channel = client.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);
    if (!channel) return;
    const obsoleteFiles = [
      path.join(config.dataDir, 'daily_msg.json'),  // pre-Phase-6 rolling daily standings
      path.join(config.dataDir, 'weekly_msg.json'), // pre-Phase-6 rolling weekly Final Standings
    ];
    let removed = 0;
    for (const f of obsoleteFiles) {
      if (await deleteLingeringMessage(channel, f)) {
        removed++;
        console.log(`[sweep] Removed lingering pre-Phase-6 #announcements post tracked by ${path.basename(f)}`);
      }
    }
    if (removed === 0) console.log('[sweep] No pre-Phase-6 #announcements rolling-post files to clean up.');
  } catch (e) { console.error('Error in obsolete-announcements sweep:', e); }
}

// ─── ET timezone helper ───────────────────────────────────────────────────────
/**
 * Return the current date/time in America/New_York (ET).
 * Handles EST (UTC-5 winter) and EDT (UTC-4 summer) automatically via IANA.
 * Returns { hour (0–23), minute (0–59), weekday ('Sunday'…), date ('YYYY-MM-DD') }
 */
function getETNow() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    weekday: 'long',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value ?? '0';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // midnight edge-case guard
  return {
    hour,
    minute:  parseInt(get('minute'), 10),
    weekday: get('weekday'), // 'Sunday', 'Monday', …
    date:    `${get('year')}-${get('month')}-${get('day')}`, // 'YYYY-MM-DD'
  };
}

// ─── Display helpers for board titles ──────────────────────────────────────
// Returns the current ET date as "Sunday, June 1". Used in the Daily board
// title so the embed always shows what day the board reflects.
function formatETToday() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date()); // → "Sunday, June 1"
}

// Returns "Week of <Month> <day>" where <day> is the most recent Monday in ET.
// If today is Monday, returns today's Monday. Otherwise rewinds to the prior
// Monday. DST-safe — uses getETNow()'s already-correct ET date as the anchor.
function formatETWeekOf() {
  const et = getETNow();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayIdx = days.indexOf(et.weekday);
  // Distance back to the most recent Monday (Monday→0, Tue→1, …, Sun→6).
  const back = (todayIdx + 6) % 7;
  // Parse the ET date string and subtract `back` days. UTC noon avoids any
  // DST edge case at the day boundary.
  const [y, m, d] = et.date.split('-').map(n => parseInt(n, 10));
  const mondayUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  mondayUTC.setUTCDate(mondayUTC.getUTCDate() - back);
  return 'Week of ' + new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric',
  }).format(mondayUTC); // → "Week of June 1"
}

// ─── Midnight tasks (extracted, callable with arbitrary `et` for test sim) ──
// Runs the 00:00 ET daily + weekly logic. Caller passes a current-or-simulated
// et = { weekday, hour, minute, date }. Same hooks shape startScheduler uses.
// On the weekly-leaderboard day, the daily-standings ANNOUNCEMENTS are
// suppressed but the +5 Daily Leader award still fires (via
// awardDailyLeaderBonus, BEFORE resetDailyPoints), and any lingering daily +
// daily-leader messages are deleted to keep #announcements clean.
async function runMidnightTasks(et, guild, client, hooks) {
  const {
    resetDailyPoints, resetWeeklyPoints, updateMemberRole, postAllTimeLeaderboard,
    choppingBlockEvaluate, // optional — Phase 2 chopping-block eval (no-op if unset)
  } = hooks;
  const announcementsCh = client.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);

  // ── Production dedupe guard ──────────────────────────────────────────────
  // Only midnight ticks (hour=0, minute=0) carry award + reset side effects;
  // restrict the guard scope to that window. If today's ET date has already
  // been processed, skip the entire midnight body (both daily + weekly
  // branches) — prevents the two production double-award vectors documented
  // on hasMidnightFired.
  //
  // CRITICAL ordering: mark BEFORE awarding. The award is the thing we must
  // never repeat — so we mark fired up-front. If the bot crashes between the
  // mark and the post, we lose that day's announcement (acceptable). If we
  // marked AFTER awarding, a crash mid-task could leave the file unmarked
  // and the next tick would re-award. Awarding-twice > losing-one-post.
  if (et.hour === 0 && et.minute === 0) {
    if (hasMidnightFired(et.date)) {
      console.log(`Midnight tasks already ran for ET date ${et.date} — skipping (dedupe guard).`);
      return;
    }
    markMidnightFired(et.date);
  }

  // ── Daily branch: every day at 00:00 ET ──────────────────────────────────
  if (et.hour === 0 && et.minute === 0) {
    // Always refresh the silent daily board with the just-completed day's
    // state BEFORE resetDailyPoints wipes it. The board freezes today's
    // result for ~24h; the next post-affecting event will edit it again
    // (real-time wiring), but that next edit will show the new (post-reset)
    // day. So this is the canonical "yesterday final" snapshot.
    await postDailyBoard(guild, client);

    // CRITICAL invariant: award MUST happen before resetDailyPoints — the
    // winner is determined from today's daily counts. Same as 2701d0e.
    const winner = await awardDailyLeaderBonus(guild, client, updateMemberRole);

    if (et.weekday !== WEEKLY_LEADERBOARD_DAY) {
      // Mon–Sat: post the Daily Leader recognition ping (rolling @everyone).
      if (winner) await postDailyLeaderPing(client, winner);
    } else {
      // Overlap day: ping is suppressed (per 2701d0e). The +5 award above
      // still happened. Clean up the prior day's lingering leader ping so
      // #announcements doesn't show a stale "🥇 Daily Leader" alongside the
      // weekly winners that fire below.
      console.log(`Overlap day (${WEEKLY_LEADERBOARD_DAY}): Daily Leader ping suppressed; +5 already awarded.`);
      try { await deleteLingeringMessage(announcementsCh, DAILY_LEADER_MSG_FILE); }
      catch (e) { console.error('Error deleting lingering daily-leader ping:', e); }
    }

    // Always reset daily — Monday must start at daily=0 across the board.
    resetDailyPoints();

    // After the reset, the daily board still shows the just-finished day's
    // state. Refresh it so the new day starts with the placeholder, not
    // yesterday's standings (matches "never stale" board contract).
    await postDailyBoard(guild, client);

    // All-time board refresh after the daily reset (any tier movements from
    // the bonus award + role updates above are now reflected).
    if (postAllTimeLeaderboard) await postAllTimeLeaderboard(guild, client).catch(() => {});
  }

  // ── Weekly branch: WEEKLY_LEADERBOARD_DAY at 00:00 ET ────────────────────
  if (et.weekday === WEEKLY_LEADERBOARD_DAY && et.hour === 0 && et.minute === 0) {
    console.log(`Posting weekly leaderboard (${WEEKLY_LEADERBOARD_DAY} midnight ET)...`);

    // Silent board refresh BEFORE awarding bonuses + reset — the board shows
    // the just-completed week's standings (the canonical "final" view).
    await postWeeklyBoard(guild, client);

    // Top-3 bonus awards (silent) → recognition ping (@everyone, #announcements)
    const { winnerLines, sortedAll } = await awardWeeklyTop3Bonuses(guild, client, updateMemberRole);
    if (winnerLines.length) await postWeeklyWinnersPing(client, winnerLines);

    // ── Chopping Block evaluation ──────────────────────────────────────────
    // Runs BEFORE resetWeeklyPoints so weekly counts are still readable.
    // No-op when the hook isn't wired (e.g. chopping-block dormant).
    if (typeof choppingBlockEvaluate === 'function') {
      try { await choppingBlockEvaluate(et, guild, client); }
      catch (e) { console.error('[chopping-block] evaluate error:', e); }
    }

    // Weekly reset + all-time refresh
    resetWeeklyPoints();
    if (postAllTimeLeaderboard) await postAllTimeLeaderboard(guild, client).catch(() => {});

    // After weekly reset the weekly board is now empty → refresh once more
    // so the pinned board shows the placeholder instead of last week's data
    // until the new week starts accumulating.
    await postWeeklyBoard(guild, client);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
function startScheduler(guild, client, hooks) {
  const {
    pointsEnabled = true,         // false in room mode: no standings, bonuses, resets or callouts
    resetDailyPoints, resetWeeklyPoints, updateMemberRole,
    postAllTimeLeaderboard, EVENTS_CHANNEL_ID,
    choppingBlockEvaluate,        // Monday-tick eval (optional, Phase 2)
    choppingBlockThursdayCheckin, // Thursday 12:00 ET check-in (optional, Phase 3)
    dietTrackerAnnounce,          // daily 10:00 ET diet-lapse report (optional; lib/diet-tracker.js self-gates)
    workoutTrackerAnnounce,       // daily 10:00 ET workout-lapse report (optional; lib/workout-tracker.js self-gates)
  } = hooks;

  console.log('Scheduler started (ET timezone — America/New_York, DST-aware).');

  setInterval(async () => {
    const et = getETNow();
    console.log(`Scheduler tick ET: ${et.weekday} ${et.hour}:${et.minute.toString().padStart(2, '0')} [${et.date}]`);

    // ── Midnight daily + weekly tasks (overlap-aware) ────────────────────────
    if (pointsEnabled) await runMidnightTasks(et, guild, client, {
      resetDailyPoints, resetWeeklyPoints, updateMemberRole, postAllTimeLeaderboard,
      choppingBlockEvaluate,
    });

    // ── Chopping Block: Thursday mid-week check-in (12:00 ET) ────────────────
    // Stand-alone behavior — does not mutate state. DMs anyone currently
    // sub-25 with a coaching nudge. No-op if hook unset (feature dormant).
    if (pointsEnabled && et.weekday === 'Thursday' && et.hour === 12 && et.minute === 0
        && typeof choppingBlockThursdayCheckin === 'function') {
      try { await choppingBlockThursdayCheckin(et, guild, client); }
      catch (e) { console.error('[chopping-block] Thursday check-in error:', e); }
    }

    // ── Diet Tracker lapse report (daily 10:00 ET; module self-gates) ────────
    // Announcement-only — awards no points (point economy is 🔒 locked and
    // lives in index.js). No-op when hook unset or env not configured.
    if (typeof dietTrackerAnnounce === 'function') {
      try { await dietTrackerAnnounce(et, client); }
      catch (e) { console.error('[diet-tracker] announce error:', e); }
    }

    // ── Workout Tracker lapse report (daily 10:00 ET; module self-gates) ─────
    // Announcement-only — awards no points (point economy is 🔒 locked and
    // lives in index.js). No-op when hook unset or env not configured.
    if (typeof workoutTrackerAnnounce === 'function') {
      try { await workoutTrackerAnnounce(et, client); }
      catch (e) { console.error('[workout-tracker] announce error:', e); }
    }

    // ── Scheduled-event reminders (data-driven from /setevents) ──────────────
    // Reads events-schedule.json each tick. For each event whose `days`
    // matches today's ET weekday, fires a reminder at the configured offset
    // (default [30, 5] minutes before start; per-event override via the
    // optional `reminders` field on the event). Single rolling chain in
    // #events — only one reminder visible at any time.
    if (EVENTS_CHANNEL_ID) {
      const eventsChannel = client.channels.cache.get(EVENTS_CHANNEL_ID);
      if (eventsChannel) {
        await runScheduledReminders(et, eventsChannel, config.channels.warRoom);
      }
    }

  }, 60000);
}

module.exports = {
  startScheduler,
  // Pinned, edit-in-place boards in #leaderboard (Phase 6)
  postDailyBoard,
  postWeeklyBoard,
  // Recognition / award split functions
  awardDailyLeaderBonus,
  postDailyLeaderPing,
  awardWeeklyTop3Bonuses,
  postWeeklyWinnersPing,
  // Orchestrator + constants
  runMidnightTasks,
  runScheduledReminders,
  sweepObsoleteAnnouncementsFiles,
  deletePinSystemMessage,
  fireEventsReminder,
  WEEKLY_LEADERBOARD_DAY,
};
