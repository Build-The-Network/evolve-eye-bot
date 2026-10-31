'use strict';
/**
 * lib/workout-tracker.js — Workout Tracker streak-lapse announcements (Streak System).
 *
 * READ-ONLY integration with the Network Workout Tracker
 * (the tracker service — same Railway
 * project as trade-tracker). Pulls per-member logging streaks from
 * GET /api/network/streaks?key=<WORKOUT_TRACKER_API_KEY> and publicly
 * announces lapses in #rules: "X has not logged a workout in N days."
 *
 * OPTIONAL feature (mirrors lib/diet-tracker.js 1:1): dormant unless BOTH
 * WORKOUT_TRACKER_URL and WORKOUT_TRACKER_API_KEY are set. The bot boots and
 * runs normally without them.
 *
 * 🔒 LOCKED-SPEC BOUNDARY: this module awards ZERO points and never touches
 * points.json. The point economy lives in index.js message handlers only.
 *
 * Cadence: daily at ANNOUNCE_HOUR_ET:00 ET (scheduler tick). First
 * announcement when a member who has logged before goes LAPSE_THRESHOLD_DAYS
 * without a workout log; re-announced only at +REANNOUNCE_EVERY_DAYS milestones
 * (5, 10, 15, ... days) — never daily spam. Members who resume logging drop
 * out of the announced-state automatically.
 */

const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const NETWORK_ACCENT = 0xe63b1e;
const LAPSE_THRESHOLD_DAYS  = 5;
const REANNOUNCE_EVERY_DAYS = 5;
const ANNOUNCE_HOUR_ET      = 10; // 10:00 ET daily
const FETCH_TIMEOUT_MS      = 15000;

const STATE_FILE = path.join(config.dataDir, 'workout_streak_announcements.json');
// state shape: { lastRunDate: 'YYYY-MM-DD', announced: { [username]: daysSinceAtLastAnnounce } }

function isConfigured() {
  return !!(config.workoutTracker && config.workoutTracker.url && config.workoutTracker.apiKey);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { console.error('[workout-tracker] error loading state:', e); }
  return { lastRunDate: null, announced: {} };
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('[workout-tracker] error saving state:', e); }
}

async function fetchStreaks() {
  const url = `${config.workoutTracker.url}/api/network/streaks?key=${encodeURIComponent(config.workoutTracker.apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`workout-tracker streaks endpoint HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('workout-tracker streaks endpoint returned non-array');
  return data;
}

/**
 * Pure milestone logic (unit-tested in test/workout-tracker.test.js).
 * @param {Array<{username, name, lastLogged, daysSinceLastLog}>} streaks
 * @param {Object} announced — { [username]: daysSinceAtLastAnnounce }
 * @returns {{ lapses: Array, nextAnnounced: Object }}
 *   lapses: members to announce THIS run.
 *   nextAnnounced: full replacement announced-state (recovered members drop out).
 */
function computeAnnouncements(streaks, announced) {
  const lapses = [];
  const nextAnnounced = {};
  for (const s of streaks) {
    const d = s.daysSinceLastLog;
    // never logged (null) → nothing to lapse from; current (< threshold) → drops out
    if (d == null || d < LAPSE_THRESHOLD_DAYS) continue;
    const prev = announced[s.username];
    if (prev == null || d >= prev + REANNOUNCE_EVERY_DAYS) {
      lapses.push(s);
      nextAnnounced[s.username] = d;
    } else {
      nextAnnounced[s.username] = prev; // carry milestone, no repeat announce
    }
  }
  return { lapses, nextAnnounced };
}

/**
 * Scheduler entry point — called every tick; self-gates to once per ET date
 * at ANNOUNCE_HOUR_ET:00. Pass { force: true } (admin API) to bypass the
 * time gate AND the once-per-date guard (state still updates).
 */
async function announceLapses(et, client, opts = {}) {
  const force = !!opts.force;
  if (!isConfigured()) return { ran: false, reason: 'not-configured' };
  if (!force) {
    if (!et || et.hour !== ANNOUNCE_HOUR_ET || et.minute !== 0) return { ran: false, reason: 'not-time' };
  }
  const state = loadState();
  if (!force && et && state.lastRunDate === et.date) return { ran: false, reason: 'already-ran-today' };
  // Mark BEFORE posting (same crash-ordering doctrine as runMidnightTasks):
  // a lost announcement beats a double announcement.
  if (et) { state.lastRunDate = et.date; saveState(state); }

  let streaks;
  try { streaks = await fetchStreaks(); }
  catch (e) { console.error('[workout-tracker] fetch failed (will retry next scheduled run):', e.message); return { ran: false, reason: 'fetch-failed' }; }

  const { lapses, nextAnnounced } = computeAnnouncements(streaks, state.announced || {});
  state.announced = nextAnnounced;
  saveState(state);

  if (!lapses.length) {
    console.log('[workout-tracker] no workout-log lapses to announce.');
    return { ran: true, announced: 0 };
  }

  const channel = client.channels.cache.get(config.channels.accountability);
  if (!channel) {
    console.error('[workout-tracker] accountability channel not found — skipping announcement.');
    return { ran: true, announced: 0, reason: 'no-channel' };
  }

  const lines = lapses
    .sort((a, b) => b.daysSinceLastLog - a.daysSinceLastLog)
    .map(s => `**${s.name || s.username}** has not logged a workout in **${s.daysSinceLastLog} days**.`);

  const embed = new EmbedBuilder()
    .setColor(NETWORK_ACCENT)
    .setTitle('🏋️ WORKOUT LOG — LAPSE REPORT')
    .setDescription(lines.join('\n'))
    .addFields({
      name: '📋 The standard',
      value: 'Log your training in the Workout Tracker — consistency is public here. Streaks reset at the first missed day.',
    })
    .setFooter({ text: 'The Eye is watching. Log your training.' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  console.log(`[workout-tracker] announced ${lapses.length} lapse(s).`);
  return { ran: true, announced: lapses.length };
}

module.exports = {
  isConfigured,
  fetchStreaks,
  computeAnnouncements,
  announceLapses,
  LAPSE_THRESHOLD_DAYS,
  REANNOUNCE_EVERY_DAYS,
  ANNOUNCE_HOUR_ET,
};
