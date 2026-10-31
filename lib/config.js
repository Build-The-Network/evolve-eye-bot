'use strict';
/**
 * lib/config.js
 * Single source of truth for environment configuration.
 *
 * Reads every Discord ID, token, and tunable from process.env, validates at
 * module-load time, and exports a frozen object. Missing required vars throw
 * a single error listing ALL missing names — no live-ID fallbacks anywhere.
 *
 * Path-only default: DATA_DIR falls back to '/data' (matches Railway volume
 * mount). All other config has NO defaults.
 */

const REQUIRED_VARS = [
  // Credentials
  'TOKEN',
  'EYE_ADMIN_TOKEN',
  // Discord identity
  'CLIENT_ID',
  'GUILD_ID',
  // Member-facing channels
  'WELCOME_CHANNEL_ID',
  'RULES_CHANNEL_ID',
  'EVENTS_CHANNEL_ID',
  'ANNOUNCEMENTS_CHANNEL_ID',
  // WORLD_CLOCK_CHANNEL_ID is optional on EVOLVE (no #world-clock channel; world clock + itinerary no-op when unset)
  'ACCOUNTABILITY_CHANNEL_ID',
  'LEADERBOARD_CHANNEL_ID',
  // VOTE_CHANNEL_ID is optional: voting is archived on EVOLVE — set it (and create #vote) to bring /vote back
  'DAILY_WEEKLY_REVIEW_CHANNEL_ID',
  'TRADE_LOG_CHANNEL_ID',
  'TRAINING_LOG_CHANNEL_ID',
  'DIET_LOG_CHANNEL_ID',
  'WAR_ROOM_ID',
  // Admin / log channels
  'LOG_COMMANDS_ID',
  'LOG_MEMBERS_ID',
  'LOG_INACTIVITY_ID',
  'LOG_ACCOUNTABILITY_ID',
  'LOG_ROLES_ID',
  'LOG_POINTS_AUDIT_ID',
  'LOG_DELETED_MESSAGES_ID',
  // Onboarding roles
  'PENDING_ROLE_ID',
  'AGREED_ROLE_ID',
  'TIMEZONE_SET_ROLE_ID',
  'ACCOUNTABILITY_SET_ROLE_ID',
  // Tier (economy) roles
  'PROSPECT_ROLE_ID',
  'MEMBER_ROLE_ID',
  'VETERAN_ROLE_ID',
  'ELITE_ROLE_ID',
  'TOP_ROLE_ID',
];

function validate() {
  const missing = REQUIRED_VARS.filter(name => {
    const v = process.env[name];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ` +
      `Set ${missing.length === 1 ? 'it' : 'them'} in the Railway service (or local .env) and restart. ` +
      `See .env.example for the full list.`
    );
  }
}

validate();

const env = process.env;

function parseIgnoredUserIds(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const config = {
  dataDir: env.DATA_DIR && env.DATA_DIR.trim() !== '' ? env.DATA_DIR.trim() : '/data',

  port: env.PORT ? Number(env.PORT) : 3000,

  tokens: {
    bot:    env.TOKEN,
    admin:  env.EYE_ADMIN_TOKEN,
    notion: env.NOTION_TOKEN || null,
  },

  clientId: env.CLIENT_ID,
  guildId:  env.GUILD_ID,

  channels: {
    welcome:            env.WELCOME_CHANNEL_ID,
    rules:              env.RULES_CHANNEL_ID,
    events:             env.EVENTS_CHANNEL_ID,
    announcements:      env.ANNOUNCEMENTS_CHANNEL_ID,
    worldClock:         env.WORLD_CLOCK_CHANNEL_ID,
    accountability:     env.ACCOUNTABILITY_CHANNEL_ID,
    leaderboard:        env.LEADERBOARD_CHANNEL_ID,
    vote:               env.VOTE_CHANNEL_ID,
    dailyWeeklyReview:  env.DAILY_WEEKLY_REVIEW_CHANNEL_ID,
    tradeLog:           env.TRADE_LOG_CHANNEL_ID,
    trainingLog:        env.TRAINING_LOG_CHANNEL_ID,
    dietLog:            env.DIET_LOG_CHANNEL_ID,
    warRoom:            env.WAR_ROOM_ID,
  },

  logChannels: {
    commands:        env.LOG_COMMANDS_ID,
    members:         env.LOG_MEMBERS_ID,
    inactivity:      env.LOG_INACTIVITY_ID,
    accountability:  env.LOG_ACCOUNTABILITY_ID,
    roles:           env.LOG_ROLES_ID,
    pointsAudit:     env.LOG_POINTS_AUDIT_ID,
    deletedMessages: env.LOG_DELETED_MESSAGES_ID,
  },

  roles: {
    pending:            env.PENDING_ROLE_ID,
    agreed:             env.AGREED_ROLE_ID,
    timezoneSet:        env.TIMEZONE_SET_ROLE_ID,
    accountabilitySet:  env.ACCOUNTABILITY_SET_ROLE_ID,
    prospect:           env.PROSPECT_ROLE_ID,
    member:             env.MEMBER_ROLE_ID,
    veteran:            env.VETERAN_ROLE_ID,
    elite:              env.ELITE_ROLE_ID,
    top:                env.TOP_ROLE_ID,
  },

  ignoredUserIds: Object.freeze(parseIgnoredUserIds(env.IGNORED_USER_IDS)),

  // ─── Room mode (Lucca 2026-10-29) ───────────────────────────────────────
  // EVOLVE is the room + Lucca in it. Points, leaderboards, callouts and the
  // habit system are PARKED: built, switched off. ON unless ROOM_MODE=off —
  // set it to bring the whole economy back (and run
  // scripts/strip-to-room.js --restore to un-hide its channels).
  roomMode: env.ROOM_MODE !== 'off',

  // ─── Chopping Block (OPTIONAL) ──────────────────────────────────────────
  // The Chopping Block enforces the weekly point standard. Intentionally
  // optional so the bot boots even when these IDs aren't yet configured on
  // an environment (e.g., first deploy before the channel/role have been
  // created via ./eye-admin.sh config apply). lib/chopping-block.js
  // early-exits via isConfigured() whenever either value is missing.
  choppingBlock: Object.freeze({
    channelId: env.CHOPPING_BLOCK_CHANNEL_ID && env.CHOPPING_BLOCK_CHANNEL_ID.trim() !== ''
      ? env.CHOPPING_BLOCK_CHANNEL_ID.trim() : null,
    roleId:    env.ON_THE_BLOCK_ROLE_ID && env.ON_THE_BLOCK_ROLE_ID.trim() !== ''
      ? env.ON_THE_BLOCK_ROLE_ID.trim() : null,
  }),

  // ─── Diet Tracker (OPTIONAL) ────────────────────────────────────────────
  // Read-only streaks integration with the Network Diet Tracker
  // (lib/diet-tracker.js). Intentionally optional so the bot boots without
  // it; the module early-exits via isConfigured() when either is missing.
  dietTracker: Object.freeze({
    url: env.DIET_TRACKER_URL && env.DIET_TRACKER_URL.trim() !== ''
      ? env.DIET_TRACKER_URL.trim().replace(/\/+$/, '') : null,
    apiKey: env.DIET_TRACKER_API_KEY && env.DIET_TRACKER_API_KEY.trim() !== ''
      ? env.DIET_TRACKER_API_KEY.trim() : null,
  }),

  // ─── Workout Tracker (OPTIONAL) ─────────────────────────────────────────
  // Read-only streaks integration with the Network Workout Tracker
  // (lib/workout-tracker.js — mirrors dietTracker 1:1). Intentionally
  // optional so the bot boots without it; the module early-exits via
  // isConfigured() when either is missing.
  workoutTracker: Object.freeze({
    url: env.WORKOUT_TRACKER_URL && env.WORKOUT_TRACKER_URL.trim() !== ''
      ? env.WORKOUT_TRACKER_URL.trim().replace(/\/+$/, '') : null,
    apiKey: env.WORKOUT_TRACKER_API_KEY && env.WORKOUT_TRACKER_API_KEY.trim() !== ''
      ? env.WORKOUT_TRACKER_API_KEY.trim() : null,
  }),

  // ─── Tracker Issues intake (OPTIONAL) ───────────────────────────────────
  // #tracker-bugs → Notion "Tracker Issues" DB → Jarvis triage loop
  // (lib/tracker-issues.js). Dormant unless NOTION_TOKEN +
  // TRACKER_BUGS_CHANNEL_ID + TRACKER_ISSUES_DB_ID are all set.
  trackerIssues: Object.freeze({
    channelId: env.TRACKER_BUGS_CHANNEL_ID && env.TRACKER_BUGS_CHANNEL_ID.trim() !== ''
      ? env.TRACKER_BUGS_CHANNEL_ID.trim() : null,
    issuesDbId: env.TRACKER_ISSUES_DB_ID && env.TRACKER_ISSUES_DB_ID.trim() !== ''
      ? env.TRACKER_ISSUES_DB_ID.trim() : null,
    cmdQueueDbId: env.JARVIS_CMDQ_DB_ID && env.JARVIS_CMDQ_DB_ID.trim() !== ''
      ? env.JARVIS_CMDQ_DB_ID.trim() : null,
    // the network tester bot may file reports (staging/prod E2E)
    testUserId: env.TEST_BOT_USER_ID && env.TEST_BOT_USER_ID.trim() !== ''
      ? env.TEST_BOT_USER_ID.trim() : null,
  }),
};

Object.freeze(config.tokens);
Object.freeze(config.channels);
Object.freeze(config.logChannels);
Object.freeze(config.roles);

module.exports = Object.freeze(config);
