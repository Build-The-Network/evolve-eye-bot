const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AuditLogEvent,
} = require('discord.js');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const config  = require('./lib/config');
const {
  startScheduler,
  postDailyBoard,
  postWeeklyBoard,
  awardWeeklyTop3Bonuses,
  postWeeklyWinnersPing,
  runMidnightTasks,
  runScheduledReminders,
  sweepObsoleteAnnouncementsFiles,
  deletePinSystemMessage,
  fireEventsReminder,
} = require('./accountability');
const { createAdminRouter } = require('./lib/admin-api');
const { cancelWarRoom } = require('./lib/war-room-cancel');
const choppingBlock = require('./lib/chopping-block');
const dietTracker = require('./lib/diet-tracker');
const workoutTracker = require('./lib/workout-tracker');
const trackerIssues = require('./lib/tracker-issues');

// Closures that run the Callout List module against the live data snapshot.
// They capture loadPoints/loadLastSeen + tier-role list so chopping-block.js
// stays decoupled from index.js internals. Used by the Monday scheduler tick,
// the Thursday mid-week check-in, and the staging simulate-midnight-tick.
function runChoppingBlockEval(et, guildArg, clientArg) {
  return choppingBlock.evaluateAndApply(et, guildArg, clientArg, {
    loadPoints, loadLastSeen,
    IGNORED_USER_IDS, ALL_TIER_ROLE_IDS,
    INACTIVITY_THRESHOLD_DAYS,
  });
}
function runChoppingBlockThursdayCheckin(et, guildArg, clientArg) {
  return choppingBlock.dispatchThursdayCheckin(et, guildArg, clientArg, {
    loadPoints,
    IGNORED_USER_IDS, ALL_TIER_ROLE_IDS,
  });
}

// ─── Files ────────────────────────────────────────────────────────────────────
const TIMEZONE_FILE    = path.join(config.dataDir, 'timezones.json');
const POINTS_FILE      = path.join(config.dataDir, 'points.json');
const EVENTS_FILE      = path.join(config.dataDir, 'events-schedule.json');
const WARROOM_MSG_FILE = path.join(config.dataDir, 'warroom_msg.json');

// ─── IDs ──────────────────────────────────────────────────────────────────────
const TOKEN                    = config.tokens.bot;
const CLIENT_ID                = config.clientId;
const GUILD_ID                 = config.guildId;
const WELCOME_CHANNEL_ID       = config.channels.welcome;
const RULES_CHANNEL_ID         = config.channels.rules;
const EVENTS_CHANNEL_ID        = config.channels.events;
const ANNOUNCEMENTS_CHANNEL_ID = config.channels.announcements;
const WORLD_CLOCK_CHANNEL_ID   = config.channels.worldClock;
const ACCOUNTABILITY_CHANNEL_ID= config.channels.accountability;
const LEADERBOARD_CHANNEL_ID   = config.channels.leaderboard;
const VOTE_CHANNEL_ID          = config.channels.vote;

// Room mode (Lucca 2026-10-29): points, leaderboards, callouts and the habit
// system are parked. Member-facing copy comes from lib/room-copy.js.
const ROOM_MODE = config.roomMode;
const roomCopy  = require('./lib/room-copy');
const PARKED_COMMANDS = ['points', 'leaderboard', 'standings', 'setupaccountability',
  'setupworldclock', 'worldclock', 'setupdailyitinerary', 'timezone', 'myschedule', 'setevents']; // no world clock, no daily war room

// Paid access (Lucca 2026-10-29): Whop grants this role on purchase and kicks on cancel.
// Unset = no gate (anyone with the invite can onboard).
const PAID_ROLE_ID = process.env.PAID_ROLE_ID || null;
const JOIN_URL     = process.env.JOIN_URL || null;

// Accountability log channels
const DAILY_WEEKLY_REVIEW_CHANNEL_ID = config.channels.dailyWeeklyReview;
const TRADE_LOG_CHANNEL_ID     = config.channels.tradeLog;
const TRAINING_LOG_CHANNEL_ID  = config.channels.trainingLog;
const DIET_LOG_CHANNEL_ID      = config.channels.dietLog;
const WAR_ROOM_ID              = config.channels.warRoom;

// ─── Admin log channels ───────────────────────────────────────────────────────
const LOG_COMMANDS_ID          = config.logChannels.commands;
const LOG_MEMBERS_ID           = config.logChannels.members;
const LOG_INACTIVITY_ID        = config.logChannels.inactivity;
const LOG_ACCOUNTABILITY_ID    = config.logChannels.accountability;
const LOG_ROLES_ID             = config.logChannels.roles;
const LOG_POINTS_AUDIT_ID      = config.logChannels.pointsAudit;
const LOG_DELETED_MESSAGES_ID  = config.logChannels.deletedMessages;
const INACTIVITY_THRESHOLD_DAYS = 3;

// ─── Brand color ──────────────────────────────────────────────────────────────
const NETWORK_ACCENT = 0xe63b1e; // Used on all member-facing embeds

// ─── Ignored users (test bots) — never award points, never appear on leaderboards ──
const IGNORED_USER_IDS = config.ignoredUserIds;

// ─── Roles ────────────────────────────────────────────────────────────────────
const PENDING_ROLE_ID          = config.roles.pending;
const AGREED_ROLE_ID           = config.roles.agreed;
const TIMEZONE_SET_ROLE_ID     = config.roles.timezoneSet;
const ACCOUNTABILITY_SET_ROLE_ID = config.roles.accountabilitySet;

// Economy roles
const PROSPECT_ROLE_ID         = config.roles.prospect;
const MEMBER_ROLE_ID           = config.roles.member;
const VETERAN_ROLE_ID          = config.roles.veteran;
const ELITE_ROLE_ID            = config.roles.elite;
const TOP_ROLE_ID              = config.roles.top;

// ─── Economy config ───────────────────────────────────────────────────────────
const ROLE_TIERS = [
  { name: 'Prospect', minPoints: 0,   roleId: PROSPECT_ROLE_ID },
  { name: 'Member',   minPoints: 75,  roleId: MEMBER_ROLE_ID   },
  { name: 'Veteran',  minPoints: 150, roleId: VETERAN_ROLE_ID  },
  { name: 'Elite',    minPoints: 300, roleId: ELITE_ROLE_ID    },
  { name: 'Proven',   minPoints: 600, roleId: TOP_ROLE_ID      },
];

// Flat list of tier role IDs used as the "completed onboarding" gate for the
// Chopping Block eval. Mid-onboarding members hold no tier role and are
// skipped by evaluateAndApply.
const ALL_TIER_ROLE_IDS = ROLE_TIERS.map(t => t.roleId).filter(Boolean);

const POINTS = {
  DAILY_WEEKLY_REVIEW: 5,  // +5 weekday OR weekend (1/day weekdays, 1 total per Sat+Sun weekend)
  TRADE_LOG:           2,
  WORKOUT:             3,
  DIET:                2,
  VOTE_CAST:           3,
  NOMINATION_WIN:      10,
};

// ─── Timezones ────────────────────────────────────────────────────────────────
const TIMEZONES = [
  { label: 'UTC-12 — Baker Island',         value: 'Etc/GMT+12'              },
  { label: 'UTC-11 — Samoa',                value: 'Pacific/Pago_Pago'       },
  { label: 'UTC-10 — Hawaii (HST)',         value: 'Pacific/Honolulu'        },
  { label: 'UTC-9 — Alaska (AKST)',         value: 'America/Anchorage'       },
  { label: 'UTC-8 — Los Angeles (PST)',     value: 'America/Los_Angeles'     },
  { label: 'UTC-7 — Denver (MST)',          value: 'America/Denver'          },
  { label: 'UTC-7 — Phoenix (MST)',         value: 'America/Phoenix'         },
  { label: 'UTC-6 — Chicago (CST)',         value: 'America/Chicago'         },
  { label: 'UTC-6 — Mexico City',           value: 'America/Mexico_City'     },
  { label: 'UTC-5 — New York (EST)',        value: 'America/New_York'        },
  { label: 'UTC-5 — Toronto (EST)',         value: 'America/Toronto'         },
  { label: 'UTC-5 — Bogota (COT)',          value: 'America/Bogota'          },
  { label: 'UTC-4 — Santiago (CLT)',        value: 'America/Santiago'        },
  { label: 'UTC-4 — Caracas (VET)',         value: 'America/Caracas'         },
  { label: 'UTC-3 — São Paulo (BRT)',       value: 'America/Sao_Paulo'       },
  { label: 'UTC-3 — Buenos Aires (ART)',    value: 'America/Argentina/Buenos_Aires' },
  { label: 'UTC-1 — Azores',               value: 'Atlantic/Azores'         },
  { label: 'UTC+0 — London (GMT)',          value: 'Europe/London'           },
  { label: 'UTC+0 — Lisbon (WET)',          value: 'Europe/Lisbon'           },
  { label: 'UTC+1 — Paris (CET)',           value: 'Europe/Paris'            },
  { label: 'UTC+1 — Frankfurt (CET)',       value: 'Europe/Berlin'           },
  { label: 'UTC+1 — Amsterdam (CET)',       value: 'Europe/Amsterdam'        },
  { label: 'UTC+1 — Madrid (CET)',          value: 'Europe/Madrid'           },
  { label: 'UTC+1 — Lagos (WAT)',           value: 'Africa/Lagos'            },
  { label: 'UTC+2 — Cairo (EET)',           value: 'Africa/Cairo'            },
  { label: 'UTC+2 — Johannesburg (SAST)',   value: 'Africa/Johannesburg'     },
  { label: 'UTC+2 — Helsinki (EET)',        value: 'Europe/Helsinki'         },
  { label: 'UTC+3 — Moscow (MSK)',          value: 'Europe/Moscow'           },
  { label: 'UTC+3 — Nairobi (EAT)',         value: 'Africa/Nairobi'          },
  { label: 'UTC+3 — Riyadh (AST)',          value: 'Asia/Riyadh'             },
  { label: 'UTC+3:30 — Tehran (IRST)',      value: 'Asia/Tehran'             },
  { label: 'UTC+4 — Dubai (GST)',           value: 'Asia/Dubai'              },
  { label: 'UTC+4:30 — Kabul (AFT)',        value: 'Asia/Kabul'              },
  { label: 'UTC+5 — Karachi (PKT)',         value: 'Asia/Karachi'            },
  { label: 'UTC+5:30 — Mumbai (IST)',       value: 'Asia/Kolkata'            },
  { label: 'UTC+5:45 — Kathmandu (NPT)',    value: 'Asia/Kathmandu'          },
  { label: 'UTC+6 — Dhaka (BST)',           value: 'Asia/Dhaka'              },
  { label: 'UTC+6:30 — Yangon (MMT)',       value: 'Asia/Rangoon'            },
  { label: 'UTC+7 — Bangkok (ICT)',         value: 'Asia/Bangkok'            },
  { label: 'UTC+7 — Jakarta (WIB)',         value: 'Asia/Jakarta'            },
  { label: 'UTC+8 — Singapore (SGT)',       value: 'Asia/Singapore'          },
  { label: 'UTC+8 — Hong Kong (HKT)',       value: 'Asia/Hong_Kong'          },
  { label: 'UTC+8 — Shanghai (CST)',        value: 'Asia/Shanghai'           },
  { label: 'UTC+8 — Perth (AWST)',          value: 'Australia/Perth'         },
  { label: 'UTC+8 — Kuala Lumpur (MYT)',    value: 'Asia/Kuala_Lumpur'       },
  { label: 'UTC+9 — Tokyo (JST)',           value: 'Asia/Tokyo'              },
  { label: 'UTC+9 — Seoul (KST)',           value: 'Asia/Seoul'              },
  { label: 'UTC+9:30 — Adelaide (ACST)',    value: 'Australia/Adelaide'      },
  { label: 'UTC+10 — Sydney (AEDT)',        value: 'Australia/Sydney'        },
  { label: 'UTC+10 — Brisbane (AEST)',      value: 'Australia/Brisbane'      },
  { label: 'UTC+10 — Melbourne (AEDT)',     value: 'Australia/Melbourne'     },
  { label: 'UTC+10 — Hobart (AEDT)',        value: 'Australia/Hobart'        },
  { label: 'UTC+11 — Solomon Islands',      value: 'Pacific/Guadalcanal'     },
  { label: 'UTC+12 — Auckland (NZST)',      value: 'Pacific/Auckland'        },
  { label: 'UTC+12 — Fiji (FJT)',           value: 'Pacific/Fiji'            },
  { label: 'UTC+13 — Tonga (TOT)',          value: 'Pacific/Tongatapu'       },
];

// ─── In-memory stores ─────────────────────────────────────────────────────────
const memberTimezones = new Map();
const userEphemerals  = new Map(); // userId → priorInteraction (for ephemeral cleanup)

// Room-mode onboarding: the standard, one card at a time. Next stays locked for
// STANDARD_READ_MS on each card (Lucca 2026-10-30: 8 seconds), then the last card's
// I Agree hands off to the existing onb_step1_agree step.
const STANDARD_READ_MS = 8000;

function standardCardPayload(i, locked) {
  const last = i === roomCopy.STANDARD.length - 1;
  return {
    embeds: [roomCopy.standardCard(i)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(last ? 'onb_step1_agree' : `onb_std_next:${i + 1}`)
        .setLabel(last ? 'I Agree' : 'Next')
        .setStyle(last ? ButtonStyle.Danger : ButtonStyle.Primary)
        .setDisabled(locked)
    )],
  };
}

function logOnboardingStep(member, label, step) {
  return adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
    .setTitle(`📋 Onboarding — ${label}`)
    .addFields(
      { name: 'Member', value: member.nickname || member.user.username, inline: true },
      { name: 'Step',   value: step,                                    inline: true },
    )
    .setColor(0xFFD700).setTimestamp()
  );
}

function unlockStandardCard(interaction, i) {
  setTimeout(() => {
    interaction.editReply(standardCardPayload(i, false)).catch(() => {}); // member dismissed the card
  }, STANDARD_READ_MS);
}

// ─── Timezone select helper (Discord limits 25 options per menu) ──────────────
function buildTimezoneComponents(page = 0) {
  const pageSize = 23; // reserve slots for prev/next navigation
  const totalPages = Math.ceil(TIMEZONES.length / pageSize);
  const start = page * pageSize;
  const slice = TIMEZONES.slice(start, start + pageSize);

  const options = slice.map(tz =>
    new StringSelectMenuOptionBuilder().setLabel(tz.label).setValue(tz.value)
  );

  if (page > 0) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(`◀ Previous page (page ${page}/${totalPages})`)
        .setValue(`__page_${page - 1}`)
    );
  }

  if (page < totalPages - 1) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(`▶ More timezones (page ${page + 2}/${totalPages})`)
        .setValue(`__page_${page + 1}`)
    );
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`timezone_onboarding_p${page}`)
      .setPlaceholder(`Select your timezone (page ${page + 1}/${totalPages})`)
      .addOptions(options)
  );
}

// Separate builder for /timezone command — no onboarding flow triggered
function buildTimezoneUpdateComponents(page = 0) {
  const pageSize = 23;
  const totalPages = Math.ceil(TIMEZONES.length / pageSize);
  const start = page * pageSize;
  const slice = TIMEZONES.slice(start, start + pageSize);

  const options = slice.map(tz =>
    new StringSelectMenuOptionBuilder().setLabel(tz.label).setValue(tz.value)
  );

  if (page > 0) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(`◀ Previous page (page ${page}/${totalPages})`)
        .setValue(`__page_${page - 1}`)
    );
  }

  if (page < totalPages - 1) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(`▶ More timezones (page ${page + 2}/${totalPages})`)
        .setValue(`__page_${page + 1}`)
    );
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`timezone_update_p${page}`)
      .setPlaceholder(`Select your timezone (page ${page + 1}/${totalPages})`)
      .addOptions(options)
  );
}

// ─── Points helpers ───────────────────────────────────────────────────────────
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

function getUserPoints(userId) {
  const data = loadPoints();
  return data[userId] || { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: null };
}

function addPoints(userId, amount) {
  if (IGNORED_USER_IDS.includes(userId)) return { allTime: 0, weekly: 0, daily: 0, lastPost: {} };
  const data = loadPoints();
  if (!data[userId]) data[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: null };
  data[userId].allTime += amount;
  data[userId].weekly  += amount;
  data[userId].daily   += amount;
  savePoints(data);
  return data[userId];
}

function resetDailyPoints() {
  const data = loadPoints();
  Object.keys(data).forEach(id => { data[id].daily = 0; });
  savePoints(data);
  console.log('Daily points reset.');
}

function resetWeeklyPoints() {
  const data = loadPoints();
  Object.keys(data).forEach(id => { data[id].weekly = 0; });
  savePoints(data);
  console.log('Weekly points reset.');
}

// ─── Nickname validation ──────────────────────────────────────────────────────
function isValidFullName(nickname) {
  if (!nickname) return false;

  const cleaned = nickname.trim().replace(/\s+/g, " ");
  const parts = cleaned.split(" ");

  return parts.length >= 2 &&
         parts[0].length >= 2 &&
         parts[1].length >= 2;
}

// ─── Timezone helpers ─────────────────────────────────────────────────────────
function loadTimezones() {
  try {
    if (fs.existsSync(TIMEZONE_FILE)) {
      const data = JSON.parse(fs.readFileSync(TIMEZONE_FILE, 'utf8'));
      let purged = false;
      Object.entries(data).forEach(([key, timezone]) => {
        // Only keep entries keyed by Discord user ID (17-19 digit numbers)
        if (/^\d{17,19}$/.test(key)) {
          memberTimezones.set(key, timezone);
        } else {
          purged = true;
          console.log(`Purging stale timezone entry: ${key}`);
        }
      });
      if (purged) saveTimezones(); // Save cleaned version
      console.log(`Loaded ${memberTimezones.size} timezones.`);
    }
  } catch (e) { console.error('Error loading timezones:', e); }
}

function saveTimezones() {
  try { fs.writeFileSync(TIMEZONE_FILE, JSON.stringify(Object.fromEntries(memberTimezones), null, 2)); }
  catch (e) { console.error('Error saving timezones:', e); }
}

// ─── Last-seen tracker (for inactivity log) ───────────────────────────────────
const LAST_SEEN_FILE = path.join(config.dataDir, 'last_seen.json');

function loadLastSeen() {
  try {
    if (fs.existsSync(LAST_SEEN_FILE)) return JSON.parse(fs.readFileSync(LAST_SEEN_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveLastSeen(data) {
  try { fs.writeFileSync(LAST_SEEN_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Error saving last seen:', e); }
}

function updateLastSeen(userId) {
  const data = loadLastSeen();
  data[userId] = Date.now();
  saveLastSeen(data);
}

// ─── Admin log helper ─────────────────────────────────────────────────────────
async function adminLog(channelId, embed) {
  try {
    const channel = client.channels.cache.get(channelId);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Error posting admin log:', e); }
}

// ─── Active votes store ───────────────────────────────────────────────────────
// Map of messageId -> vote state
const activeVotes = new Map();

// ─── Role tier updater ────────────────────────────────────────────────────────
async function updateMemberRole(member, totalPoints, options = {}) {
  const { skipAnnouncement = false } = options;
  const tier = [...ROLE_TIERS].reverse().find(t => totalPoints >= t.minPoints && t.roleId);
  if (!tier) return;

  // Find current tier BEFORE making any changes
  const currentTier = [...ROLE_TIERS].reverse().find(t => t.roleId && member.roles.cache.has(t.roleId));
  const tierIndex        = ROLE_TIERS.findIndex(t => t.name === tier.name);
  const currentTierIndex = currentTier ? ROLE_TIERS.findIndex(t => t.name === currentTier.name) : -1;

  // Skip if tier hasn't changed
  if (currentTier && currentTier.name === tier.name) return;

  // Remove all tier roles then add the correct one
  for (const t of ROLE_TIERS) {
    if (t.roleId && member.roles.cache.has(t.roleId)) {
      await member.roles.remove(t.roleId).catch(() => {});
    }
  }
  await member.roles.add(tier.roleId).catch(console.error);

  const name = member.nickname || member.user.username;

  // Always log to admin role log
  await adminLog(LOG_ROLES_ID, new EmbedBuilder()
    .setTitle('🔄 Role Tier Change')
    .addFields(
      { name: 'Member',    value: name,                                    inline: true },
      { name: 'From',      value: currentTier?.name || 'None',             inline: true },
      { name: 'To',        value: tier.name,                               inline: true },
      { name: 'Total XP',  value: `${totalPoints} pts`,                    inline: true },
      { name: 'Trigger',   value: 'Role system — points threshold reached', inline: true },
    )
    .setColor(0x5865F2)
    .setTimestamp()
  );

  // Only announce if this is a PROMOTION (moving up in tier index) and not suppressed
  if (skipAnnouncement || tier.name === 'Prospect' || tierIndex <= currentTierIndex) return;

  const announcementsChannel = member.guild.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);
  if (!announcementsChannel) return;

  const tierColors = {
    'Prospect': 0x7a9fc2,
    'Member':   0xff4242,
    'Veteran':  0x77ff89,
    'Elite':    0xff22e9,
    'Proven':   0xf7ff1e,
  };

  const tierMessages = {
    'Prospect': 'Welcome to EVOLVE. The work starts now.',
    'Member':   'Member circle unlocked. Find your circle in #member-circle.',
    'Veteran':  'Veteran circle unlocked. You moved up to #veteran-circle with the men who kept their habits.',
    'Elite':    'Elite circle unlocked. Welcome to #elite-circle. You are in rare company.',
    'Proven':   'The highest circle. #proven-circle holds the most dialed-in men in EVOLVE. Proven by the work, not the words.',
  };

  const tierEmojis = {
    'Prospect': '🔵',
    'Member':   '🔴',
    'Veteran':  '🟢',
    'Elite':    '🟣',
    'Proven':   '🟡',
  };

  const embed = new EmbedBuilder()
    .setTitle(`${tierEmojis[tier.name] || '⚪'} ${name} just reached ${tier.name}`)
    .setDescription(`*${tierMessages[tier.name] || 'Keep grinding.'}*`)
    .addFields(
      { name: 'Points Earned', value: `${totalPoints} pts`, inline: true },
      { name: 'Tier',          value: tier.name,            inline: true },
    )
    .setColor(tierColors[tier.name] || 0x5865F2)
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  await announcementsChannel.send({ content: '@everyone', embeds: [embed] });
}

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildModeration, // required for the guildBanAdd event
  ],
  // Partials let messageUpdate fire for messages posted before the last
  // bot restart — needed so edits made outside the live cache still
  // trigger re-evaluation of the points channels.
  partials: [Partials.Message, Partials.Channel],
});

// ─── Habit system (EVOLVE) ────────────────────────────────────────────────────
// Members build + schedule their own habits and /checkin through the day.
// Check-in = +1, proof shared = +1. Replaces per-channel post scoring.
const habits = require('./lib/habits')({
  client,
  dataDir:          config.dataDir,
  getTimezone:      (userId) => memberTimezones.get(userId),
  addPoints,
  updateMemberRole,
  isIgnored:        (userId) => IGNORED_USER_IDS.includes(userId),
  channels: {
    training:      TRAINING_LOG_CHANNEL_ID,
    nutrition:     DIET_LOG_CHANNEL_ID,
    tradingReview: DAILY_WEEKLY_REVIEW_CHANNEL_ID,
    tradeJournal:  TRADE_LOG_CHANNEL_ID,
    habits:        process.env.HABITS_CHANNEL_ID, // the #habits panel + live week board (optional)
    lab:           process.env.SCHEDULE_LAB_CHANNEL_ID, // #schedule-lab: calendar builder button (optional)
  },
  accent:           NETWORK_ACCENT,
  auditLog:         (embed) => adminLog(LOG_POINTS_AUDIT_ID, embed),
  // Schedule builder links: https://<public domain>/schedule?t=<HMAC-signed, 24h>
  publicUrl:        process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_DOMAIN,
  linkSecret:       config.tokens.admin,
});

// ─── Events schedule helpers ──────────────────────────────────────────────────
function loadEventsSchedule() {
  try {
    if (fs.existsSync(EVENTS_FILE)) return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  } catch (e) { console.error('Error loading events schedule:', e); }
  return null;
}

function saveEventsSchedule(data) {
  try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Error saving events schedule:', e); }
}

function buildEventsScheduleValue(schedule) {
  if (!schedule || !schedule.events || schedule.events.length === 0) {
    return '*No events scheduled. Use /setevents to configure.*';
  }
  return schedule.events.map(ev =>
    `**${ev.name}**\n🕘 ${ev.time} (${ev.days})`
  ).join('\n\n');
}

function buildEventsEmbed() {
  if (ROOM_MODE) return roomCopy.events(); // war rooms only when scheduled
  const schedule = loadEventsSchedule();
  return new EmbedBuilder()
    .setTitle('📅 #EVENTS — DAILY SCHEDULE')
    .setDescription('*Your daily war room schedule and community events. Show up.*')
    .addFields(
      {
        name: '🎙️ Daily War Room Sessions',
        value: buildEventsScheduleValue(schedule),
      },
      {
        name: '📋 War Room Rules',
        value: 'Cameras required. Audio required. No lurking.\nShow up half-in, don\'t bother.',
      },
      {
        name: '📆 Community Events',
        value:
          'Scheduled events appear automatically below this embed.\n' +
          '@everyone gets pinged when an event is scheduled.\n' +
          'Reminders fire 24h, 1h, and at start time.',
      }
    )
    .setColor(0xe63b1e)
    .setFooter({ text: 'Show up daily. The men climbing the leaderboard are in here often.' });
}

// ─── War room schedule helpers ────────────────────────────────────────────────

function loadWarRoomMsgId() {
  try {
    if (fs.existsSync(WARROOM_MSG_FILE)) return JSON.parse(fs.readFileSync(WARROOM_MSG_FILE, 'utf8')).msgId || null;
  } catch (e) {}
  return null;
}

function saveWarRoomMsgId(msgId) {
  try { fs.writeFileSync(WARROOM_MSG_FILE, JSON.stringify({ msgId })); }
  catch (e) { console.error('Error saving war room msg ID:', e); }
}

/**
 * Returns the UTC offset (minutes) for `tz` at the current moment. Handles DST automatically.
 * Uses Intl.DateTimeFormat.formatToParts — more reliable than toLocaleString across Node builds.
 */
function getTimezoneOffsetMinutes(tz) {
  const date = new Date();
  const toMs = (timeZone) => {
    const parts = Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    const h = get('hour');
    return Date.UTC(get('year'), get('month') - 1, get('day'), h === 24 ? 0 : h, get('minute'), get('second'));
  };
  return (toMs(tz) - toMs('UTC')) / 60000;
}

/**
 * Convert an ET time string (e.g. "9:30 AM", "9:30 AM - 11:30 AM", or "11:30 AM ET") to targetTz.
 * Source timezone is America/New_York (handles EST/EDT DST automatically).
 * Strips trailing TZ abbreviations from each part before converting.
 * Returns the converted time string, appending (+1d) or (prev day) on day boundary crossings.
 */
function convertETTime(timeStr, targetTz) {
  const SOURCE_TZ = 'America/New_York';
  if (!timeStr) return 'TBD';
  const parts = timeStr.split('-').map(s => s.trim());

  const srcOffset = getTimezoneOffsetMinutes(SOURCE_TZ);
  const tgtOffset = getTimezoneOffsetMinutes(targetTz);
  const diffMin   = tgtOffset - srcOffset;

  function convertSingle(t) {
    // Strip a TZ abbreviation that appears AFTER AM/PM (e.g. "11:00 AM ET", "9:30 PM EDT")
    // but do NOT strip AM/PM itself (the original bug: /\s+[A-Z]{2,4}$/ matched " PM")
    const cleaned = t.replace(/(\b(?:AM|PM)\b)\s+[A-Z]{2,4}$/i, '$1').trim();
    const m = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return t;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    const period = m[3].toUpperCase();
    if (period === 'AM') { if (h === 12) h = 0; }
    else                 { if (h !== 12) h += 12; }
    let total = h * 60 + min + diffMin;
    const dayDiff = Math.floor(total / 1440);
    total = ((total % 1440) + 1440) % 1440;
    const nh = Math.floor(total / 60);
    const nm = total % 60;
    const np = nh >= 12 ? 'PM' : 'AM';
    const dh = nh % 12 || 12;
    let result = `${dh}:${nm.toString().padStart(2, '0')} ${np}`;
    if (dayDiff > 0) result += ' (+1d)';
    else if (dayDiff < 0) result += ' (prev day)';
    return result;
  }

  return parts.map(convertSingle).join(' – ');
}

/**
 * Get the display timezone abbreviation for a WAR_ROOM_DISPLAY_TZS entry.
 * Uses the static `abbr` field if present (e.g. IST, SGT, JST), otherwise
 * queries Intl.DateTimeFormat with en-GB locale (returns BST, GMT, CET, CEST, AEST, AEDT, EDT, CDT, etc.)
 */
function getDisplayAbbr(tzEntry) {
  if (tzEntry.abbr) return tzEntry.abbr;
  try {
    const parts = Intl.DateTimeFormat('en-GB', {
      timeZone: tzEntry.tz,
      timeZoneName: 'short',
    }).formatToParts(new Date());
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart ? tzPart.value : '';
  } catch { return ''; }
}

const WAR_ROOM_DISPLAY_TZS = [
  { flag: '🇺🇸', label: 'New York (Eastern)',      tz: 'America/New_York'    },
  { flag: '🇺🇸', label: 'Chicago (Central)',       tz: 'America/Chicago'     },
  { flag: '🇺🇸', label: 'Denver (Mountain)',       tz: 'America/Denver'      },
  { flag: '🇺🇸', label: 'Los Angeles (Pacific)',   tz: 'America/Los_Angeles' },
  { flag: '🇬🇧', label: 'London',                  tz: 'Europe/London'       },
  { flag: '🇪🇺', label: 'Berlin/Paris',            tz: 'Europe/Berlin'       },
  { flag: '🇮🇳', label: 'Mumbai',                  tz: 'Asia/Kolkata',        abbr: 'IST' },
  { flag: '🇸🇬', label: 'Singapore',              tz: 'Asia/Singapore',      abbr: 'SGT' },
  { flag: '🇯🇵', label: 'Tokyo',                   tz: 'Asia/Tokyo',          abbr: 'JST' },
  { flag: '🇦🇺', label: 'Sydney',                  tz: 'Australia/Sydney'    },
];

function renderDailyItinerary() {
  return new EmbedBuilder()
    .setTitle('🕒 WHAT\'S ON YOUR SCHEDULE TODAY?')
    .setDescription(
      "*Every war room session and standings drop runs on Eastern Time.*\n" +
      "*Run `/myschedule` to see today's schedule converted to your local timezone.*"
    )
    .setColor(NETWORK_ACCENT)
    .setFooter({ text: 'The Eye is watching.' });
}

async function updateDailyItineraryEmbed(guild) {
  try {
    const channel = guild.channels.cache.get(WORLD_CLOCK_CHANNEL_ID);
    if (!channel) return;
    const embed = renderDailyItinerary();
    const savedMsgId = loadWarRoomMsgId();
    if (savedMsgId) {
      const existing = await channel.messages.fetch(savedMsgId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }
    const msg = await channel.send({ embeds: [embed] });
    await msg.pin().catch(() => {});
    saveWarRoomMsgId(msg.id);
  } catch (e) { console.error('Error updating daily itinerary embed:', e); }
}

// ─── Slash commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setuprules')
    .setDescription('Post the permanent rules embed in #rules')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupaccountability')
    .setDescription('Post the permanent accountability embed in #rules')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupwelcome')
    .setDescription('Post the permanent welcome embed in #welcome')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupannouncements')
    .setDescription('Post the permanent announcements info embed in #announcements')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupevents')
    .setDescription('Post the permanent events schedule embed in #events')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setevents')
    .setDescription('Admin: update the war room schedule via a modal form')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupworldclock')
    .setDescription('Post the timezone info embed above the live clock in #world-clock')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post a formatted announcement in #announcements')
    .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('standings')
    .setDescription('Manually post current standings in #leaderboard')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('timezone')
    .setDescription('Update your timezone')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('worldclock')
    .setDescription('Update the world clock now')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Check your points')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the all-time leaderboard')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('adjustpoints')
    .setDescription('Admin: manually adjust a member\'s points')
    .addUserOption(o => o.setName('user').setDescription('Member to adjust').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Points to add (use negative to subtract)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for adjustment').setRequired(false))
    .addStringOption(o => o.setName('scope')
      .setDescription('Which totals to modify — default: alltime only (safe for account migration)')
      .setRequired(false)
      .addChoices(
        { name: 'All-time only (default)', value: 'alltime' },
        { name: 'All (all-time + weekly + daily)', value: 'all' }
      ))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('backuppoints')
    .setDescription('Admin: post points backup to accountability log')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('checkinactivity')
    .setDescription('Admin: show all members and their last active time')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('clearlogs')
    .setDescription('Admin: delete all messages in this log channel')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupproven')
    .setDescription('Post the Proven command reference embed in this channel')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupvoting')
    .setDescription('Post the voting guide embed in #vote')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Create a community vote in #vote')
    .addStringOption(o => o.setName('type')
      .setDescription('Type of vote')
      .setRequired(true)
      .addChoices(
        { name: 'Yes / No', value: 'yesno' },
        { name: 'Multiple Choice', value: 'multiple' },
        { name: 'Nomination', value: 'nomination' },
      ))
    .addStringOption(o => o.setName('question').setDescription('The vote question').setRequired(true))
    .addStringOption(o => o.setName('duration')
      .setDescription('How long the vote runs')
      .setRequired(true)
      .addChoices(
        { name: '1 hour',  value: '1'  },
        { name: '6 hours', value: '6'  },
        { name: '12 hours', value: '12' },
        { name: '24 hours', value: '24' },
        { name: '48 hours', value: '48' },
        { name: '72 hours', value: '72' },
      ))
    .addStringOption(o => o.setName('option1').setDescription('Choice 1 (multiple choice only)').setRequired(false))
    .addStringOption(o => o.setName('option2').setDescription('Choice 2 (multiple choice only)').setRequired(false))
    .addStringOption(o => o.setName('option3').setDescription('Choice 3 (multiple choice only)').setRequired(false))
    .addStringOption(o => o.setName('option4').setDescription('Choice 4 (multiple choice only)').setRequired(false))
    .addUserOption(o => o.setName('nominee1').setDescription('Nominee 1 (nomination only)').setRequired(false))
    .addUserOption(o => o.setName('nominee2').setDescription('Nominee 2 (nomination only)').setRequired(false))
    .addUserOption(o => o.setName('nominee3').setDescription('Nominee 3 (nomination only)').setRequired(false))
    .addUserOption(o => o.setName('nominee4').setDescription('Nominee 4 (nomination only)').setRequired(false))
    .addUserOption(o => o.setName('nominee5').setDescription('Nominee 5 (nomination only)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setuponboarding')
    .setDescription('Post or refresh the Begin Onboarding entry-point embed in #rules')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('resetonboarding')
    .setDescription('Admin: reset a member\'s onboarding state to Pending')
    .addUserOption(o => o.setName('user').setDescription('Member to reset').setRequired(true))
    .addBooleanOption(o => o.setName('confirm').setDescription('Skip confirmation prompt and reset immediately').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setupdailyitinerary')
    .setDescription('Admin: post or refresh the Daily Itinerary embed in #world-clock')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('myschedule')
    .setDescription('See the war room schedule converted to your timezone')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('cancelwarroom')
    .setDescription('Admin: cancel today\'s War Room event and announce it in #events')
    .toJSON(),
];
if (!ROOM_MODE) commands.push(...habits.commands);

const rest = new REST({ version: '10' }).setToken(TOKEN);
const eventReminders = new Map();
const eventStartTimes = new Map(); // eventId → the start time its reminders are armed for

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`Bot is online as ${client.user.tag}`);

  try {
    const eventsChannel = client.channels.cache.get(EVENTS_CHANNEL_ID);
    const eventsGuild = client.guilds.cache.get(GUILD_ID);
    if (eventsChannel && eventsGuild) {
      const upcoming = await eventsGuild.scheduledEvents.fetch();
      upcoming.forEach(ev => armEventReminders(ev, eventsChannel));
      console.log(`Event reminders armed for ${upcoming.size} upcoming event(s).`);
    }
  } catch (e) { console.error('Error re-arming event reminders:', e); }

  try {
    const registered = commands
      .filter(c => VOTE_CHANNEL_ID || !['vote', 'setupvoting'].includes(c.name)) // voting archived unless #vote is configured
      .filter(c => !ROOM_MODE || !PARKED_COMMANDS.includes(c.name));
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: registered });
    console.log('Slash commands registered.');
  } catch (e) { console.error('Error registering commands:', e); }

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild && !ROOM_MODE) habits.startBoard(guild);
  if (guild) startScheduler(guild, client, {
    pointsEnabled: !ROOM_MODE, // room mode: no standings, bonuses, resets or callouts
    resetDailyPoints,
    resetWeeklyPoints,
    updateMemberRole,
    postAllTimeLeaderboard,
    EVENTS_CHANNEL_ID,
    choppingBlockEvaluate:        runChoppingBlockEval,
    choppingBlockThursdayCheckin: runChoppingBlockThursdayCheckin,
    dietTrackerAnnounce:          (et, clientArg) => dietTracker.announceLapses(et, clientArg),
    workoutTrackerAnnounce:       (et, clientArg) => workoutTracker.announceLapses(et, clientArg),
  });

  // One-time cleanup of any lingering pre-Phase-6 standings posts in
  // #announcements + unlink the obsolete daily_msg.json / weekly_msg.json.
  // Idempotent — no-op when files are already gone.
  if (guild) sweepObsoleteAnnouncementsFiles(client).catch(e =>
    console.error('Error in obsolete-announcements sweep:', e)
  );

  loadTimezones();

  // ── Wipe IGNORED_USER_IDS entries from points.json (one-time migration on each deploy) ──
  {
    const pts = loadPoints();
    let wiped = false;
    for (const id of IGNORED_USER_IDS) {
      if (pts[id]) {
        delete pts[id];
        wiped = true;
        console.log(`[IGNORED_USER_IDS] Wiped ${id} from points.json`);
      }
    }
    if (wiped) savePoints(pts);
  }

  await updateWorldClock();
  setInterval(updateWorldClock, 5 * 60 * 1000);
  setInterval(() => console.log('Bot heartbeat — still running'), 30 * 60 * 1000);

  // Pinned "what is this" context embed in #callouts.
  // No-op until CHOPPING_BLOCK_CHANNEL_ID + ON_THE_BLOCK_ROLE_ID are configured.
  if (!ROOM_MODE) choppingBlock.syncContextEmbed(client).catch(e =>
    console.error('Error syncing chopping-block context embed:', e)
  );

  // #tracker-bugs status poller (Valid/Fixing/Fixed/Rejected replies).
  // No-op until NOTION_TOKEN + TRACKER_BUGS_CHANNEL_ID + TRACKER_ISSUES_DB_ID set.
  trackerIssues.startPolling(client);

  // Weekly backup — every Sunday at 4:05 AM UTC (~11:05 PM ET Saturday)
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCDay() === 0 && now.getUTCHours() === 4 && now.getUTCMinutes() === 5) {
      const guild = client.guilds.cache.get(GUILD_ID);
      if (guild) await backupPoints(guild, client);
    }
  }, 60000);

  // Inactivity check — runs every hour, reports members inactive 3+ days
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 12 && now.getUTCMinutes() === 0) {
      const guild = client.guilds.cache.get(GUILD_ID);
      if (guild) await checkInactivity(guild);
    }
  }, 60000);
});

// ─── World clock ──────────────────────────────────────────────────────────────
async function updateWorldClock() {
  try {
    const channel = client.channels.cache.get(WORLD_CLOCK_CHANNEL_ID);
    if (!channel) return;

    const guild = client.guilds.cache.get(GUILD_ID);
    const now = new Date();
    let clockText = '';

    // Group timezones by value for efficiency
    const tzMap = new Map();
    for (const [userId, timezone] of memberTimezones) {
      if (!tzMap.has(timezone)) tzMap.set(timezone, []);
      tzMap.get(timezone).push(userId);
    }

    // Load points data once so we can prefer realName for all members
    const pointsDataForClock = loadPoints();

    for (const tz of TIMEZONES) {
      const userIds = tzMap.get(tz.value) || [];
      if (!userIds.length) continue;

      const names = [];
      for (const userId of userIds) {
        // Prefer realName from points.json (set during onboarding Step 2)
        const realName = pointsDataForClock[userId]?.realName;
        if (realName) {
          names.push(realName);
          continue;
        }
        let guildMember = guild?.members.cache.get(userId);
        if (!guildMember) guildMember = await guild?.members.fetch(userId).catch(() => null);
        const name = guildMember?.nickname || guildMember?.user?.username || null;
        if (name) names.push(name);
      }

      if (names.length > 0) {
        const time = now.toLocaleTimeString('en-US', { timeZone: tz.value, hour: '2-digit', minute: '2-digit', hour12: true });
        const date = now.toLocaleDateString('en-US', { timeZone: tz.value, weekday: 'short', month: 'short', day: 'numeric' });
        clockText += `🕐 **${tz.label.split('—')[1].trim()}**\n⏰ ${time} — ${date}\n👤 ${names.join(', ')}\n\n`;
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('🌍 EVOLVE — World Clock')
      .setDescription(clockText || 'No members have registered their timezone yet.')
      .setColor(NETWORK_ACCENT)
      .addFields({ name: '\u200b', value: '*Updates every 5 minutes.*' })
      .setFooter({ text: 'Last updated' })
      .setTimestamp();

    const messages = await channel.messages.fetch({ limit: 10, force: true });
    const botMessage = messages.find(m => m.author.bot && m.embeds[0]?.title === '🌍 EVOLVE — World Clock');

    if (botMessage) await botMessage.edit({ embeds: [embed] });
    else await channel.send({ embeds: [embed] });

  } catch (e) { console.error('Error updating world clock:', e); }
}

// ─── New member joins ─────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return; // bots (e.g. Whop Bot) never onboard
  try {
    await member.roles.add(PENDING_ROLE_ID);

    // Log join
    await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
      .setTitle('👋 Member Joined')
      .addFields(
        { name: 'User',        value: `${member.user.tag}`,                    inline: true },
        { name: 'ID',          value: member.id,                               inline: true },
        { name: 'Account Age', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setColor(0x57F287)
      .setTimestamp()
    );

    // ── Bug 1 fix: rejoin path only restores role if onboarding was COMPLETE ──
    const data = loadPoints();
    const memberData = data[member.id];
    const wasComplete = memberData && (
      memberData.onboardingState === 'COMPLETE' ||
      !('onboardingState' in memberData) // legacy entries without field → treat as complete
    );

    if (memberData?.inactive && wasComplete) {
      // Fully completed onboarding before leaving — restore role + points silently
      memberData.inactive = false;
      savePoints(data);
      const restoredPts = memberData.allTime;
      console.log(`Restored points for rejoining member ${member.user.username} (${restoredPts} pts)`);
      await updateMemberRole(member, restoredPts, { skipAnnouncement: true }).catch(e =>
        console.error('Error restoring role on rejoin:', e)
      );
      postAllTimeLeaderboard(member.guild, client).catch(() => {});
      postWeeklyBoard(member.guild, client).catch(() => {});
      postDailyBoard(member.guild, client).catch(() => {});
      await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
        .setTitle('🔄 Points + Role Restored — Member Rejoined')
        .addFields(
          { name: 'Member',   value: member.user.tag,            inline: true },
          { name: 'Points',   value: `${restoredPts} pts`,       inline: true },
        )
        .setColor(0x5865F2).setTimestamp()
      );
    } else if (memberData?.inactive) {
      // Rejoining with incomplete onboarding — reset to PENDING, route through fresh
      memberData.inactive = false;
      memberData.onboardingState = 'PENDING';
      savePoints(data);
      console.log(`Rejoin: ${member.user.username} had incomplete onboarding — routing through fresh`);
      await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
        .setTitle('🔄 Member Rejoined — Routing to Onboarding (incomplete)')
        .addFields(
          { name: 'Member', value: member.user.tag, inline: true },
        )
        .setColor(0xFFA500).setTimestamp()
      );
    } else if (!memberData) {
      // Brand new member — initialize points entry (skip ignored users e.g. test bots)
      if (!IGNORED_USER_IDS.includes(member.id)) {
        data[member.id] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: 'PENDING' };
        savePoints(data);
      }
    }

  } catch (e) { console.error('Error handling new member:', e); }
});

// ─── Member-log helpers — audit-log lookup for kick / ban actor + reason ────
async function fetchAuditEntry(guild, type, targetId) {
  // Allow ~1.5s for Discord's audit log to settle. Returns null on failure.
  await new Promise(r => setTimeout(r, 1500));
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    return logs.entries.find(e =>
      e.targetId === targetId && (Date.now() - e.createdTimestamp) < 10000
    ) || null;
  } catch (e) {
    console.warn('[member-log] audit fetch failed:', e.message);
    return null;
  }
}

async function logMemberBan(ban) {
  const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  const actor  = entry?.executor?.tag || 'unknown';
  const reason = entry?.reason || ban.reason || '(none provided)';
  await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
    .setTitle('🪓 Member Banned')
    .addFields(
      { name: 'User',      value: `${ban.user.tag}`, inline: true },
      { name: 'ID',        value: ban.user.id,       inline: true },
      { name: 'Banned by', value: actor,             inline: true },
      { name: 'Reason',    value: reason,            inline: false },
    )
    .setThumbnail(ban.user.displayAvatarURL?.() || null)
    .setColor(0xC92A2A)
    .setTimestamp()
  );
}

async function logMemberKick(member, kickEntry) {
  const actor  = kickEntry?.executor?.tag || 'unknown';
  const reason = kickEntry?.reason || '(none provided)';
  const roles  = member.roles.cache
    .filter(r => r.id !== member.guild.id)
    .map(r => r.name).join(', ') || 'None';
  await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
    .setTitle('⚖️ Member Kicked')
    .addFields(
      { name: 'User',      value: `${member.user.tag}`, inline: true },
      { name: 'ID',        value: member.id,            inline: true },
      { name: 'Kicked by', value: actor,                inline: true },
      { name: 'Reason',    value: reason,               inline: false },
      { name: 'Roles',     value: roles,                inline: false },
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setColor(0xE67E22)
    .setTimestamp()
  );
}

// ─── Member banned — fire chopping-block ban announcement + member-log ───────
client.on('guildBanAdd', async (ban) => {
  choppingBlock.announceBan(client, ban, {
    loadPoints, IGNORED_USER_IDS,
  }).catch(e => console.error('[chopping-block] announceBan error:', e));
  logMemberBan(ban).catch(e => console.error('[member-log] logMemberBan error:', e));
});

// ─── Member leaves — flag as inactive, hide from leaderboard, remove from world clock ──
client.on('guildMemberRemove', async (member) => {
  // Chopping Block removal announcement (kick vs voluntary leave routed via
  // audit log; ban-driven removes are deduped against the guildBanAdd
  // handler above). Non-blocking — runs in parallel with the inactive-flag
  // bookkeeping below.
  choppingBlock.handleMemberRemove(member, client, {
    loadPoints, IGNORED_USER_IDS,
  }).catch(e => console.error('[chopping-block] handleMemberRemove error:', e));

  try {
    // Flag as inactive instead of deleting — preserves points for rejoin
    const data = loadPoints();
    if (data[member.id]) {
      data[member.id].inactive = true;
      savePoints(data);
      console.log(`Flagged ${member.user.username} as inactive on leave.`);
      postAllTimeLeaderboard(member.guild, client).catch(() => {});
      postWeeklyBoard(member.guild, client).catch(() => {});
      postDailyBoard(member.guild, client).catch(() => {});
    }

    // Remove from world clock
    if (memberTimezones.has(member.id)) {
      memberTimezones.delete(member.id);
      saveTimezones();
      updateWorldClock().catch(() => {});
      console.log(`Removed ${member.user.username} from world clock on leave.`);
    }

    // Member-log routing — ban / kick / voluntary
    // Skip entirely if the guildBanAdd handler already logged this removal.
    if (choppingBlock.wasRecentBan(member.id)) {
      // Belt-and-suspenders: wait briefly in case guildBanAdd hasn't stamped
      // yet, then re-check. (handleMemberRemove uses the same 1.5s window.)
      return;
    }
    const kickEntry = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id);
    if (choppingBlock.wasRecentBan(member.id)) return; // ban stamped during the wait
    if (kickEntry) {
      await logMemberKick(member, kickEntry);
    } else {
      const roles = member.roles.cache
        .filter(r => r.id !== member.guild.id)
        .map(r => r.name).join(', ') || 'None';
      await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
        .setTitle('🚪 Member Left')
        .addFields(
          { name: 'User',   value: `${member.user.tag}`, inline: true },
          { name: 'ID',     value: member.id,            inline: true },
          { name: 'Roles',  value: roles,                inline: false },
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setColor(0xED4245)
        .setTimestamp()
      );
    }
  } catch (e) { console.error('Error handling member leave:', e); }
});

// ─── Event announcements ──────────────────────────────────────────────────────
client.on('guildScheduledEventCreate', async (event) => {
  try {
    if (event.guildId !== GUILD_ID) return; 
    const channel = client.channels.cache.get(EVENTS_CHANNEL_ID);
    if (!channel) return;

    const startTime = Math.floor(event.scheduledStartTimestamp / 1000);

    // Fetch creator's server nickname
    let creatorName = 'Unknown';
    if (event.creatorId) {
      const creatorMember = await event.guild.members.fetch(event.creatorId).catch(() => null);
      creatorName = creatorMember?.nickname || creatorMember?.user?.username || 'Unknown';
    }

    const embed = new EmbedBuilder()
      .setTitle(`📅 New Event: ${event.name}`)
      .setDescription(event.description || 'No description provided.')
      .addFields(
        { name: 'When',       value: `<t:${startTime}:F>`, inline: true },
        { name: 'Where',      value: 'war room',            inline: true },
        { name: 'Created By', value: creatorName,           inline: true },
      )
      .setColor(NETWORK_ACCENT)
      .setFooter({ text: ROOM_MODE ? 'Click Interested on the event above.' : 'Click the event in the server to RSVP.' });

    await channel.send({ content: ROOM_MODE ? `@everyone\n${event.url}` : '@everyone', embeds: [embed] });

    armEventReminders(event, channel);

  } catch (e) { console.error('Error announcing event:', e); }
});

// Timers live in memory, so the ready handler re-arms them for every upcoming event
// after a restart. setTimeout can't hold more than ~24.8 days, so anything further out
// is left for a later restart to pick up.
function armEventReminders(event, channel) {
  const startTime = Math.floor(event.scheduledStartTimestamp / 1000);
  eventStartTimes.set(event.id, event.scheduledStartTimestamp);
  const arm = (suffix, at, embed) => {
    const delay = at - Date.now();
    if (delay <= 0 || delay > 2147483647 || eventReminders.has(`${event.id}${suffix}`)) return;
    eventReminders.set(`${event.id}${suffix}`, setTimeout(async () => {
      await channel.send({ content: '@everyone', embeds: [embed.setColor(NETWORK_ACCENT)] }).catch(e => console.error('Error sending event reminder:', e));
    }, delay));
  };

  arm('_24', event.scheduledStartTimestamp - 24 * 60 * 60 * 1000,
    new EmbedBuilder().setTitle(`⏰ 24 Hour Reminder: ${event.name}`).setDescription(`Tomorrow. <t:${startTime}:F>. Be there.`));
  arm('_1', event.scheduledStartTimestamp - 60 * 60 * 1000,
    new EmbedBuilder().setTitle(`🔥 1 Hour Reminder: ${event.name}`).setDescription(`One hour. <t:${startTime}:t>. Get ready.`));
  // @everyone ping at event start time
  arm('_start', event.scheduledStartTimestamp,
    new EmbedBuilder().setTitle(`🚨 Starting Now: ${event.name}`).setDescription(`It's time. Get in the war room.`));
}

function clearEventReminders(eventId) {
  ['_24', '_1', '_start'].forEach(suffix => {
    const t = eventReminders.get(`${eventId}${suffix}`);
    if (t) { clearTimeout(t); eventReminders.delete(`${eventId}${suffix}`); }
  });
  eventStartTimes.delete(eventId);
}

client.on('guildScheduledEventDelete', (event) => {
  clearEventReminders(event.id);
});

// New time = @everyone notice + reminders moved. Cancelled or finished = reminders dropped.
client.on('guildScheduledEventUpdate', async (_old, event) => {
  try {
    if (event.guildId !== GUILD_ID) return;
    if (event.isCanceled() || event.isCompleted()) return clearEventReminders(event.id);
    if (eventStartTimes.get(event.id) === event.scheduledStartTimestamp) return;

    const channel = client.channels.cache.get(EVENTS_CHANNEL_ID);
    if (!channel) return;
    clearEventReminders(event.id);
    armEventReminders(event, channel);

    const startTime = Math.floor(event.scheduledStartTimestamp / 1000);
    await channel.send({
      content: `@everyone\n${event.url}`,
      embeds: [new EmbedBuilder()
        .setTitle(`🔁 Time Changed: ${event.name}`)
        .setDescription(`New time: <t:${startTime}:F>.`)
        .setColor(NETWORK_ACCENT)],
    });
  } catch (e) { console.error('Error handling event update:', e); }
});

// ─── Message create — points tracking + welcome ───────────────────────────────
// ── Diminishing returns helper ───────────────────────────────────────────────
function calculateDiminishingPoints(postsSoFarToday) {
  if (postsSoFarToday < 3) return 2;   // posts 1-3: +2 each
  if (postsSoFarToday < 6) return 1;   // posts 4-6: +1 each
  return 0;                              // posts 7+: 0 pts (still logged with ✅)
}

// ── Point-awarding channel helpers ────────────────────────────────────────────
// Each helper runs for both fresh posts (isEdit=false) and edits of previously-
// rejected posts within 24h (isEdit=true, see messageUpdate handler below). On
// isEdit=true, validation-failure warnings and "already logged" / "at cap"
// replies are suppressed — the ✅ reaction is the only user-facing signal.
// A per-message `msg_${id}` marker on the award path guarantees a single
// message can never be awarded twice no matter how many times it is edited.

async function processDailyWeeklyReview(message, { isEdit = false } = {}) {
  const userId = message.author.id;
  const member = message.member;
  if (!member) return;

  if (!message.attachments.size) {
    if (!isEdit) message.reply('⚠️ Your post needs a **screenshot/photo**. **Delete and repost** with the image attached **to receive points** — Discord does not support adding attachments via edit.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  if (!message.content.trim()) {
    if (!isEdit) message.reply('⚠️ Your post needs **written reasoning** too. **Edit this same post** to add your review notes and points will land automatically.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  const hasImage = message.attachments.some(a => a.contentType?.startsWith('image/'));
  if (!hasImage) {
    if (!isEdit) message.reply('⚠️ Your attachment must be an **image** (screenshot, photo). Other file types do not count.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }

  if (IGNORED_USER_IDS.includes(userId)) { await message.react('✅').catch(() => {}); return; }

  const msgKey = `msg_${message.id}`;
  const preCheck = getUserPoints(userId);
  if (preCheck.lastPost[msgKey] != null) return;

  const now  = new Date();
  const day  = now.getUTCDay();
  const isWeekend = day === 0 || day === 6;

  // ET date — use America/New_York (handles EST/EDT DST automatically)
  const etFmt  = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const etParts = etFmt.formatToParts(now);
  const etGet   = type => etParts.find(p => p.type === type)?.value ?? '0';
  const etDate  = `${etGet('year')}-${etGet('month')}-${etGet('day')}`;

  // Weekend tracking: both Sat (day=6) and Sun (day=0) share the Saturday key.
  let trackKey;
  if (isWeekend) {
    let satDate;
    if (day === 6) {
      satDate = etDate;
    } else {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yParts    = etFmt.formatToParts(yesterday);
      const yGet      = type => yParts.find(p => p.type === type)?.value ?? '0';
      satDate = `${yGet('year')}-${yGet('month')}-${yGet('day')}`;
    }
    trackKey = `review_weekend_${satDate}`;
  } else {
    trackKey = `review_${etDate}`;
  }

  if (preCheck.lastPost[trackKey]) {
    if (!isEdit) {
      await message.react('✅').catch(() => {});
      message.reply(isWeekend
        ? '✅ Already logged this weekend\'s review. Points already awarded.'
        : '✅ Already logged today\'s review. Points already awarded.'
      ).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
    }
    return;
  }

  const pts     = POINTS.DAILY_WEEKLY_REVIEW; // +5 always
  const updated = addPoints(userId, pts);
  const allData = loadPoints();
  allData[userId].lastPost[trackKey] = true;
  allData[userId].lastPost[msgKey]   = pts;
  savePoints(allData);

  await updateMemberRole(member, updated.allTime);
  await message.react('✅').catch(() => {});
  message.reply(`+${pts} points logged. All-time: **${updated.allTime} pts**`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
  postAllTimeLeaderboard(message.guild, client).catch(() => {});
  postWeeklyBoard(message.guild, client).catch(() => {});
  postDailyBoard(message.guild, client).catch(() => {});

  const name = member.nickname || member.user.username;
  await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
    .setTitle('🪙 Points Awarded — Trade Review')
    .addFields(
      { name: 'Member',    value: name,                    inline: true },
      { name: 'Amount',    value: `+${pts} pts`,           inline: true },
      { name: 'Type',      value: isWeekend ? 'Weekly review' : 'Daily review', inline: true },
      { name: 'All-Time',  value: `${updated.allTime} pts`, inline: true },
    )
    .setColor(0x57F287)
    .setTimestamp()
  );
}

async function processTradeLog(message, { isEdit = false } = {}) {
  const userId = message.author.id;
  const member = message.member;
  if (!member) return;

  if (!message.attachments.size) {
    if (!isEdit) message.reply('⚠️ Your post needs a **chart screenshot**. **Delete and repost** with the image attached **to receive points** — Discord does not support adding attachments via edit.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  if (!message.content.trim()) {
    if (!isEdit) message.reply('⚠️ Your post needs **trade details** too. **Edit this same post** to add: Entry, Stop, Exit, Result (+R / -R / BE), and rationale — points will land automatically.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  const hasImage = message.attachments.some(a => a.contentType?.startsWith('image/'));
  if (!hasImage) {
    if (!isEdit) message.reply('⚠️ Your attachment must be a **chart screenshot**. Other file types do not count.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }

  if (IGNORED_USER_IDS.includes(userId)) { await message.react('✅').catch(() => {}); return; }

  const msgKey = `msg_${message.id}`;
  const preCheck = getUserPoints(userId);
  if (preCheck.lastPost[msgKey] != null) return;

  const ctDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().split('T')[0];
  const countKey = `tradelog_count_${ctDate}`;
  const currentCount = preCheck.lastPost[countKey] || 0;
  const pts = calculateDiminishingPoints(currentCount);

  await message.react('✅').catch(() => {});

  if (pts > 0) {
    const updated = addPoints(userId, pts);
    const freshData = loadPoints();
    if (!freshData[userId]) freshData[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: null };
    freshData[userId].lastPost[countKey] = currentCount + 1;
    freshData[userId].lastPost[msgKey] = pts;
    savePoints(freshData);

    await updateMemberRole(member, updated.allTime);
    message.reply(`+${pts} point${pts !== 1 ? 's' : ''} logged. All-time: **${updated.allTime} pts**`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
    postAllTimeLeaderboard(message.guild, client).catch(() => {});
    postWeeklyBoard(message.guild, client).catch(() => {});
    postDailyBoard(message.guild, client).catch(() => {});

    const name = member.nickname || member.user.username;
    await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
      .setTitle('🪙 Points Awarded — Trade Log')
      .addFields(
        { name: 'Member',    value: name,                      inline: true },
        { name: 'Amount',    value: `+${pts} pts`,             inline: true },
        { name: 'Post #',    value: `${currentCount + 1}/day`, inline: true },
        { name: 'All-Time',  value: `${updated.allTime} pts`,  inline: true },
      )
      .setColor(0x57F287)
      .setTimestamp()
    );
  } else {
    const allData = loadPoints();
    if (!allData[userId]) allData[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: null };
    allData[userId].lastPost[countKey] = currentCount + 1;
    allData[userId].lastPost[msgKey] = 0;
    savePoints(allData);
    if (!isEdit) message.reply('✅ Logged (no points — daily volume limit reached).').then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
  }
}

async function processTrainingLog(message, { isEdit = false } = {}) {
  const userId = message.author.id;
  const member = message.member;
  if (!member) return;

  if (!message.attachments.size) {
    if (!isEdit) message.reply('⚠️ Your post needs a **photo/screenshot**. **Delete and repost** with the image attached **to receive points** — Discord does not support adding attachments via edit.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  if (!message.content.trim()) {
    if (!isEdit) message.reply('⚠️ Your post needs a **session description** too. **Edit this same post** to add what you trained — points will land automatically.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  const hasImage = message.attachments.some(a => a.contentType?.startsWith('image/'));
  if (!hasImage) {
    if (!isEdit) message.reply('⚠️ Your attachment must be an **image** (photo, screenshot). Other file types do not count.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }

  if (IGNORED_USER_IDS.includes(userId)) { await message.react('✅').catch(() => {}); return; }

  const msgKey = `msg_${message.id}`;
  const preCheck = getUserPoints(userId);
  if (preCheck.lastPost[msgKey] != null) return;

  const ctDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().split('T')[0];
  // Migrate: if legacy boolean key exists, treat as count 1
  const legacyKey = `workout_${ctDate}`;
  const countKey  = `workout_count_${ctDate}`;
  const legacyLogged = preCheck.lastPost[legacyKey] === true;
  const currentCount = preCheck.lastPost[countKey] != null
    ? preCheck.lastPost[countKey]
    : (legacyLogged ? 1 : 0);

  if (currentCount >= 2) {
    if (!isEdit) message.reply('✅ Already hit the 2/day training cap. Great work.').then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
    return;
  }

  const updated = addPoints(userId, POINTS.WORKOUT);
  const allData = loadPoints();
  allData[userId].lastPost[countKey] = currentCount + 1;
  allData[userId].lastPost[msgKey] = POINTS.WORKOUT;
  savePoints(allData);

  await updateMemberRole(member, updated.allTime);
  await message.react('✅').catch(() => {});
  message.reply(`+${POINTS.WORKOUT} pts logged (${currentCount + 1}/2 today). All-time: **${updated.allTime} pts**`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
  postAllTimeLeaderboard(message.guild, client).catch(() => {});
  postWeeklyBoard(message.guild, client).catch(() => {});
  postDailyBoard(message.guild, client).catch(() => {});

  const name = member.nickname || member.user.username;
  await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
    .setTitle('🪙 Points Awarded — Training')
    .addFields(
      { name: 'Member',   value: name,                          inline: true },
      { name: 'Amount',   value: `+${POINTS.WORKOUT} pts`,      inline: true },
      { name: 'Session',  value: `${currentCount + 1}/2 today`, inline: true },
      { name: 'All-Time', value: `${updated.allTime} pts`,      inline: true },
    )
    .setColor(0x57F287)
    .setTimestamp()
  );
}

async function processDietLog(message, { isEdit = false } = {}) {
  const userId = message.author.id;
  const member = message.member;
  if (!member) return;

  if (!message.attachments.size) {
    if (!isEdit) message.reply('⚠️ Your post needs a **meal photo**. **Delete and repost** with the image attached **to receive points** — Discord does not support adding attachments via edit.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  if (!message.content.trim()) {
    if (!isEdit) message.reply('⚠️ Your post needs a **caption** too. **Edit this same post** to add what you ate — points will land automatically.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }
  const hasImage = message.attachments.some(a => a.contentType?.startsWith('image/'));
  if (!hasImage) {
    if (!isEdit) message.reply('⚠️ Your attachment must be an **image** (photo of your meal). Other file types do not count.').then(m => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
    return;
  }

  if (IGNORED_USER_IDS.includes(userId)) { await message.react('✅').catch(() => {}); return; }

  const msgKey = `msg_${message.id}`;
  const preCheck = getUserPoints(userId);
  if (preCheck.lastPost[msgKey] != null) return;

  const ctDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().split('T')[0];
  const countKey = `dietlog_count_${ctDate}`;
  const currentCount = preCheck.lastPost[countKey] || 0;
  const pts = calculateDiminishingPoints(currentCount);

  await message.react('✅').catch(() => {});

  if (pts > 0) {
    const updated = addPoints(userId, pts);
    const freshData = loadPoints();
    if (!freshData[userId]) freshData[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: null };
    freshData[userId].lastPost[countKey] = currentCount + 1;
    freshData[userId].lastPost[msgKey] = pts;
    savePoints(freshData);

    await updateMemberRole(member, updated.allTime);
    message.reply(`+${pts} point${pts !== 1 ? 's' : ''} logged. All-time: **${updated.allTime} pts**`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
    postAllTimeLeaderboard(message.guild, client).catch(() => {});
    postWeeklyBoard(message.guild, client).catch(() => {});
    postDailyBoard(message.guild, client).catch(() => {});

    const dietName = member.nickname || member.user.username;
    await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
      .setTitle('🪙 Points Awarded — Diet')
      .addFields(
        { name: 'Member',   value: dietName,                   inline: true },
        { name: 'Amount',   value: `+${pts} pts`,              inline: true },
        { name: 'Post #',   value: `${currentCount + 1}/day`,  inline: true },
        { name: 'All-Time', value: `${updated.allTime} pts`,   inline: true },
      )
      .setColor(0x57F287)
      .setTimestamp()
    );
  } else {
    const allData = loadPoints();
    if (!allData[userId]) allData[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: null };
    allData[userId].lastPost[countKey] = currentCount + 1;
    allData[userId].lastPost[msgKey] = 0;
    savePoints(allData);
    if (!isEdit) message.reply('✅ Logged (no points — daily volume limit reached).').then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
  }
}

function routePointMessage(message, opts) {
  // Archived on EVOLVE: points come from the habit system (/checkin). Set
  // LEGACY_CHANNEL_POINTS=on to bring per-channel post scoring back.
  if (process.env.LEGACY_CHANNEL_POINTS !== 'on') return null;
  const cid = message.channel.id;
  if (cid === DAILY_WEEKLY_REVIEW_CHANNEL_ID && DAILY_WEEKLY_REVIEW_CHANNEL_ID) return processDailyWeeklyReview(message, opts);
  if (cid === TRADE_LOG_CHANNEL_ID         && TRADE_LOG_CHANNEL_ID)             return processTradeLog(message, opts);
  if (cid === TRAINING_LOG_CHANNEL_ID      && TRAINING_LOG_CHANNEL_ID)          return processTrainingLog(message, opts);
  if (cid === DIET_LOG_CHANNEL_ID          && DIET_LOG_CHANNEL_ID)              return processDietLog(message, opts);
  return null;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot && message.author.id === client.user?.id) return;

  const userId    = message.author.id;
  const member    = message.member;
  if (!member) return;

  // Update last-seen for inactivity tracking
  updateLastSeen(userId);

  // #tracker-bugs intake — files member bug reports to Notion (zero points,
  // no overlap with point channels; module self-gates on channel + config)
  trackerIssues.handleMessage(message, client).catch(e =>
    console.error('[tracker-issues] handleMessage error:', e)
  );

  await routePointMessage(message, { isEdit: false });

  // Habit proof: a member's photo post in a proof channel gets The Eye's stamp picker
  if (!ROOM_MODE) habits.handleMessage(message).catch(e => console.error('[habits] handleMessage error:', e));
});

// ── Message update — re-evaluate edited posts in points channels ──────────────
// Catches the case where a member posts image-only and edits a caption in
// (Discord does not support adding attachments via edit, so the symmetric
// case — text-first then attach an image — is delivered as two separate
// messageCreate events, not an edit, and is handled by the no-attachment
// warning copy). Gated to 24h after the original post; the per-message
// `msg_${id}` marker inside each helper guarantees no double-award.
client.on('messageUpdate', async (_oldMessage, newMessage) => {
  try {
    if (newMessage.partial) {
      try { newMessage = await newMessage.fetch(); } catch { return; }
    }
    if (!newMessage.guild) return;
    if (newMessage.author?.bot && newMessage.author.id === client.user?.id) return;
    if (!newMessage.author) return;
    if (Date.now() - newMessage.createdTimestamp > 24 * 60 * 60 * 1000) return;
    await routePointMessage(newMessage, { isEdit: true });
  } catch (e) {
    console.error('messageUpdate error:', e);
  }
});

// ─── Deleted message log ──────────────────────────────────────────────────────
client.on('messageDelete', async (message) => {
  if (message.author?.bot && message.author.id === client.user?.id) return;
  if (!message.guild) return;

  // Diet log delete-deduction (deducts stored per-message amount)
  if (
    DIET_LOG_CHANNEL_ID &&
    message.channelId === DIET_LOG_CHANNEL_ID &&
    message.content?.trim() &&
    message.attachments.some(a => a.contentType?.startsWith('image/'))
  ) {
    const userId = message.author?.id;
    if (userId) {
      const data = loadPoints();
      if (data[userId]) {
        const msgKey = `msg_${message.id}`;
        const awardedPts = (data[userId].lastPost?.[msgKey] != null)
          ? data[userId].lastPost[msgKey]
          : POINTS.DIET; // fallback for pre-update posts
        if (awardedPts > 0) {
          data[userId].allTime = Math.max(0, (data[userId].allTime || 0) - awardedPts);
          data[userId].weekly  = Math.max(0, (data[userId].weekly  || 0) - awardedPts);
          data[userId].daily   = Math.max(0, (data[userId].daily   || 0) - awardedPts);
          if (data[userId].lastPost?.[msgKey] != null) {
            delete data[userId].lastPost[msgKey];
            const ctDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().split('T')[0];
            const countKey = `dietlog_count_${ctDate}`;
            if ((data[userId].lastPost[countKey] || 0) > 0) {
              data[userId].lastPost[countKey]--;
            }
          }
          savePoints(data);
          const deductName = message.member?.nickname || message.author?.username || 'Unknown';
          await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
            .setTitle('🪙 Points Deducted — Diet Post Deleted')
            .addFields(
              { name: 'Member',   value: deductName,                    inline: true },
              { name: 'Amount',   value: `-${awardedPts} pts`,          inline: true },
              { name: 'All-Time', value: `${data[userId].allTime} pts`, inline: true },
            )
            .setColor(0xED4245)
            .setTimestamp()
          );
        }
      }
    }
  }

  // Trade log delete-deduction
  if (
    TRADE_LOG_CHANNEL_ID &&
    message.channelId === TRADE_LOG_CHANNEL_ID &&
    message.content?.trim() &&
    message.attachments.some(a => a.contentType?.startsWith('image/'))
  ) {
    const userId = message.author?.id;
    if (userId) {
      const data = loadPoints();
      if (data[userId]) {
        const msgKey = `msg_${message.id}`;
        const awardedPts = data[userId].lastPost?.[msgKey];
        if (awardedPts != null && awardedPts > 0) {
          data[userId].allTime = Math.max(0, (data[userId].allTime || 0) - awardedPts);
          data[userId].weekly  = Math.max(0, (data[userId].weekly  || 0) - awardedPts);
          data[userId].daily   = Math.max(0, (data[userId].daily   || 0) - awardedPts);
          delete data[userId].lastPost[msgKey];
          const ctDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().split('T')[0];
          const countKey = `tradelog_count_${ctDate}`;
          if ((data[userId].lastPost[countKey] || 0) > 0) {
            data[userId].lastPost[countKey]--;
          }
          savePoints(data);
          const deductName = message.member?.nickname || message.author?.username || 'Unknown';
          await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
            .setTitle('🪙 Points Deducted — Trade Log Post Deleted')
            .addFields(
              { name: 'Member',   value: deductName,                    inline: true },
              { name: 'Amount',   value: `-${awardedPts} pts`,          inline: true },
              { name: 'All-Time', value: `${data[userId].allTime} pts`, inline: true },
            )
            .setColor(0xED4245)
            .setTimestamp()
          );
        }
      }
    }
  }

  const name    = message.member?.nickname || message.author?.username || 'Unknown';
  const content = message.content || '*No text content*';
  const attachments = message.attachments.size
    ? message.attachments.map(a => a.url).join('\n')
    : '*No attachments*';

  await adminLog(LOG_DELETED_MESSAGES_ID, new EmbedBuilder()
    .setTitle('🗑️ Message Deleted')
    .addFields(
      { name: 'Member',      value: name,                        inline: true },
      { name: 'Channel',     value: `<#${message.channelId}>`,   inline: true },
      { name: 'Content',     value: content.slice(0, 1000),      inline: false },
      { name: 'Attachments', value: attachments.slice(0, 1000),  inline: false },
    )
    .setColor(0xED4245)
    .setTimestamp()
  );
});

// ─── Onboarding reset helper ──────────────────────────────────────────────────
async function executeOnboardingReset(guild, userId, targetMember) {
  const POINTS_FILE_PATH = path.join(config.dataDir, 'points.json');

  // 1. Update points.json — preserve points, clear onboarding fields
  let pData = {};
  try { if (fs.existsSync(POINTS_FILE_PATH)) pData = JSON.parse(fs.readFileSync(POINTS_FILE_PATH, 'utf8')); }
  catch (e) { console.error('[resetonboarding] Error loading points:', e); }

  if (!pData[userId]) pData[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {} };
  pData[userId].onboardingState = 'PENDING';
  pData[userId].inactive = false;
  delete pData[userId].realName;

  try { fs.writeFileSync(POINTS_FILE_PATH, JSON.stringify(pData, null, 2)); }
  catch (e) { console.error('[resetonboarding] Error saving points:', e); }

  // 2. Fix roles — remove all transitional + tier roles, add PENDING
  if (targetMember) {
    const rolesToRemove = [
      AGREED_ROLE_ID, TIMEZONE_SET_ROLE_ID, ACCOUNTABILITY_SET_ROLE_ID,
      PROSPECT_ROLE_ID, MEMBER_ROLE_ID, VETERAN_ROLE_ID, ELITE_ROLE_ID, TOP_ROLE_ID,
    ].filter(Boolean);
    for (const rid of rolesToRemove) {
      if (targetMember.roles.cache.has(rid)) await targetMember.roles.remove(rid).catch(() => {});
    }
    if (PENDING_ROLE_ID && !targetMember.roles.cache.has(PENDING_ROLE_ID)) {
      await targetMember.roles.add(PENDING_ROLE_ID).catch(() => {});
    }
  }

  // 3. Search #welcome for the member's intro post and delete it
  try {
    const welcomeChannel = guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (welcomeChannel) {
      const messages = await welcomeChannel.messages.fetch({ limit: 100 });
      const introMsg = messages.find(m => m.content.includes(`<@${userId}>`));
      if (introMsg) {
        await introMsg.delete().catch(e => console.error('[resetonboarding] Failed to delete intro post:', e));
        console.log(`[resetonboarding] Deleted intro post for ${userId}`);
      }
    }
  } catch (e) { console.error('[resetonboarding] Error searching #welcome:', e); }

  console.log(`[resetonboarding] Reset complete for userId=${userId}`);
}

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Habit system autocomplete (/habit remove, /checkin) ─────────────────────
  if (interaction.isAutocomplete()) {
    await habits.handleAutocomplete(interaction).catch(e => console.error('[habits] autocomplete error:', e));
    return;
  }

  // ── Habit panel in #habits (buttons, pop-ups, edit picker — customIds hb*) ──
  if ((interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) && interaction.customId?.startsWith('hb')) {
    await habits.handleComponent(interaction).catch(e => console.error('[habits] panel error:', e));
    return;
  }

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {

    // Log every slash command used
    const name = interaction.member?.nickname || interaction.user.username;
    await adminLog(LOG_COMMANDS_ID, new EmbedBuilder()
      .setTitle('⌨️ Slash Command Used')
      .addFields(
        { name: 'Command', value: `/${interaction.commandName}`, inline: true },
        { name: 'User',    value: name,                          inline: true },
        { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
      )
      .setColor(0x5865F2)
      .setTimestamp()
    );

    if (await habits.handleCommand(interaction)) return;

    if (interaction.commandName === 'setuprules') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const channel = interaction.guild.channels.cache.get(RULES_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ Rules channel not found.', flags: 64 });
      const embed = ROOM_MODE ? roomCopy.rules() : new EmbedBuilder()
        .setTitle('📋 EVOLVE — THE STANDARD')
        .setDescription(
          "*You're here because you decided to become the man you need to be. " +
          "Paying got you in the door. The standard keeps you here.*\n\n" +
          '*Read every word. By clicking the agreement button below you commit to all of it.*'
        )
        .addFields(
          {
            name: '🧭 What This Is',
            value:
              "Personal development for traders. I'm not going to sell you a trading result I don't have. " +
              "I'm giving you what I use to become the man who gets it: habits, training, diet, discipline, " +
              'and a room that holds you to it.'
          },
          {
            name: '⚡ Your Daily Habits',
            value:
              'You build your own habit system: at least **4 🧬 Evolution** habits (personal development) and ' +
              '**1 📈 Trading** habit (your daily process), each scheduled on the days you do it.\n\n' +
              'Every time you knock one out: `/checkin`. Show up every day. Not negotiable.'
          },
          {
            name: '👁️ The Eye',
            value:
              'The bot scores every habit you post. The more consistently you live your habits, the more points you earn. ' +
              'Public leaderboard updates daily.\n\n' +
              'Score below **25 points/week** → called out publicly in #callouts.'
          },
          {
            name: '🔓 Find Your Circle',
            value:
              'Every tier you climb unlocks a private room with the men at your level. ' +
              'The most consistent, most disciplined men end up in the same room.'
          },
          {
            name: '🚨 Callouts Are Public',
            value:
              'Fall behind on your habits and you get called out in #callouts. Not to shame. ' +
              'To remind everyone the standard is enforced.'
          },
          {
            name: '🎙️ War Room',
            value:
              'Live voice sessions in #war-room:\n' +
              'Post-NY AM session: recap the morning together\n' +
              'Afternoon work block: heads-down, cameras on\n\n' +
              '**Cameras required. Audio required. No lurking.**'
          },
          {
            name: '💬 Direct Access to Luccas',
            value:
              "I'm in #chat daily. Tag me when you need something. I read every habit you post. I lead the war rooms."
          },
          {
            name: "🚫 What You Don't Do Here",
            value:
              'No promotion (channels, services, affiliate links): instant removal\n' +
              'No "what indicator do you use": this is not a signals room\n' +
              "No \"I'll start tomorrow\": either you showed up for your habits today or you didn't\n" +
              'No drama, no politics, no off-topic'
          },
          {
            name: '🏁 How You Climb',
            value:
              "Your payment gets you in. Your habits move you up.\n\n" +
              'Fall behind and you get called out publicly in #callouts until you pick your habits back up.'
          }
        )
        .setColor(0xe63b1e)
        .setFooter({ text: 'EVOLVE: become the man you need to be.' });
      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: `✅ Rules embed posted and pinned in <#${channel.id}>.`, flags: 64 });
    }

    if (interaction.commandName === 'setupaccountability') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const channel = interaction.guild.channels.cache.get(ACCOUNTABILITY_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ Accountability channel not found.', flags: 64 });
      const embed = new EmbedBuilder()
        .setTitle('👁️ THE EYE — HOW YOUR HABITS ARE SCORED')
        .setDescription(
          '*The Eye tracks the proof of your habits. Every post that shows the habit counts. ' +
          'The more consistently you live your habits, the more points you earn and the higher you climb.*'
        )
        .addFields(
          {
            name: '🧭 Your Habit System',
            value:
              '**Build it:** `/habit add` — at least 4 🧬 Evolution + 1 📈 Trading habit, each on the days you do it.\n' +
              '**See it:** `/habit view` · **Today\'s board:** `/habit board`\n\n' +
              'War room voice attendance tracked manually.'
          },
          {
            name: '💯 Point System',
            value:
              '**Check in a habit:** `/checkin` → **+1**\n' +
              '**Share proof** (a photo) with the community → **+1 more**\n' +
              'One check-in per habit per scheduled day.\n\n' +
              'Proof lands in #training, #nutrition, #trading-review or #trade-journal for every man to see.'
          },
          {
            name: '⚠️ The Threshold',
            value:
              'Below **25 points/week** = you get called out in #callouts and reviewed.\n\n' +
              'Living your habits every day puts you well above it.'
          },
          {
            name: '🏆 Leaderboards',
            value:
              '**All-time:** Pinned in #leaderboard, auto-updates.\n' +
              '**Daily standings:** Posted midnight ET. #1 daily = +5 bonus.\n' +
              '**Weekly leaderboard:** Posted Monday midnight ET. Top 3 bonuses: +15 / +10 / +5.'
          },
          {
            name: '🔓 Find Your Circle',
            value:
              'Every tier unlocks a private room with the men at your level:\n' +
              '🔴 Member (75 pts) → **#member-circle**\n' +
              '🟢 Veteran (150) → **#veteran-circle**\n' +
              '🟣 Elite (300) → **#elite-circle**\n' +
              '🟡 Proven (600) → **#proven-circle**\n\n' +
              'The higher you climb, the more dialed-in the men around you. Promotions get an @everyone announcement.'
          },
          {
            name: '🔄 Weekly Reset',
            value:
              'Monday midnight ET. Weekly score finalized, top 3 rewarded, bottom called out.'
          },
          {
            name: '❌ Gaming The System',
            value:
              "Don't bother. Checking in a habit you didn't do is lying to the men beside you — and to yourself. " +
              'Proof is public.'
          },
          {
            name: '💬 Questions',
            value: 'Tag Luccas in #chat. Answers happen in public.'
          }
        )
        .setColor(0xe63b1e)
        .setFooter({ text: 'The Eye is watching.' });
      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: `✅ System guide posted and pinned in <#${channel.id}>.`, flags: 64 });
    }

    if (interaction.commandName === 'setupwelcome') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const channel = interaction.guild.channels.cache.get(WELCOME_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ Welcome channel not found.', flags: 64 });
      const embed = ROOM_MODE ? roomCopy.welcome() : new EmbedBuilder()
        .setTitle('👋 WELCOME TO EVOLVE')
        .setDescription('*You made it in. Now become him.*')
        .addFields(
          {
            name: '⚡ What Happens Next',
            value:
              'Go to **#rules**, read the contract, then click **Begin Onboarding**.\n\n' +
              'The process takes 2 minutes:\n' +
              '1. Acknowledge the rules\n' +
              '2. Set your real name on the server\n' +
              '3. Set your timezone\n' +
              '4. Acknowledge the accountability standard\n' +
              '5. **Complete your introduction**\n\n' +
              "Once finished, you're a Prospect. The work begins."
          },
          {
            name: '📝 Your Introduction',
            value:
              'A modal will pop up requiring you to fill in:\n' +
              "Name | Location | Trading | Why I'm here | Commitment\n\n" +
              'Bullshit answers get flagged. Specific answers earn respect.'
          },
          {
            name: '✅ What to Do Today',
            value:
              '1. Read #rules in full: the contract and how your habits are scored\n' +
              '2. Build your habit system: `/habit add` (4 🧬 Evolution + 1 📈 Trading minimum)\n' +
              '3. Check in your first habit: `/checkin`, with photo proof for +1 more\n' +
              '4. See who showed up: `/habit board`\n' +
              '5. Show up to the next war room in #war-room'
          },
          {
            name: '👁️ The Eye Starts Tracking Today',
            value:
              'Every habit you check in counts. Weekly score finalized Monday midnight ET. ' +
              'Below 25 points = you get called out in #callouts.\n\n' +
              'No pressure. Just truth.'
          }
        )
        .setColor(0xe63b1e)
        .setFooter({ text: 'Welcome to EVOLVE. — Luccas' });
      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: `✅ Welcome embed posted and pinned in <#${channel.id}>.`, flags: 64 });
    }

    if (interaction.commandName === 'setupannouncements') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const channel = interaction.guild.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ Announcements channel not found.', flags: 64 });
      const embed = ROOM_MODE ? roomCopy.announcements() : new EmbedBuilder()
        .setTitle('📢 #ANNOUNCEMENTS')
        .setDescription('*Official server communications. Read-only for members.*')
        .addFields(
          {
            name: '📌 Server Updates',
            value:
              'Community updates & milestones\n' +
              'Promotion announcements\n' +
              'Server-wide communications',
            inline: true,
          },
          {
            name: '🏆 Standings',
            value:
              'Weekly leaderboard results\n' +
              'Daily standings #1 calls\n' +
              'Bonus point awards',
            inline: true,
          },
          {
            name: '🚨 Callouts',
            value:
              'Members falling behind on their habits are called out in #callouts.',
            inline: true,
          },
          {
            name: '🔕 Notifications',
            value:
              '@everyone tags are used for important announcements. Keep notifications on if you want to stay sharp.',
            inline: false,
          }
        )
        .setColor(0xe63b1e)
        .setFooter({ text: 'Read-only. No replies.' });
      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: `✅ Announcements embed posted and pinned in <#${channel.id}>.`, flags: 64 });
    }

    if (interaction.commandName === 'setupevents') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const channel = interaction.guild.channels.cache.get(EVENTS_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ Events channel not found.', flags: 64 });
      const embed = buildEventsEmbed();
      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: `✅ Events schedule posted and pinned in <#${channel.id}>.`, flags: 64 });
    }

    if (interaction.commandName === 'setevents') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }

      const modal = new ModalBuilder()
        .setCustomId('setevents_modal')
        .setTitle('Update War Room Schedule');

      // Discord modals support up to 5 rows — one row = one event.
      // Format per row: "Name | Time | Days"
      //   Name : free text
      //   Time : "11:30 AM ET" or "11:30 AM - 12:30 PM ET" (start time used for reminders;
      //          trailing TZ abbreviation accepted but ignored — all times are ET).
      //   Days : "Mon-Fri" | "Mon/Wed/Fri" | "Mon, Wed, Fri" | "Daily" | "Weekdays" | "Weekends"
      //          | single day "Monday"/"Mon". Unparseable → event is shown on the
      //          schedule embed but no reminders fire for it.
      // Reminders fire 30 minutes and 5 minutes before each event's start time.
      const eventInputs = [1, 2, 3, 4, 5].map(n =>
        new TextInputBuilder()
          .setCustomId(`event_${n}`)
          .setLabel(`Event ${n} — Name | Time ET | Days`)
          .setStyle(TextInputStyle.Short)
          .setRequired(n === 1)
          .setMaxLength(200)
          .setPlaceholder(
            n === 1 ? 'NY AM Session Recap | 11:30 AM - 12:30 PM ET | Mon-Fri'
          : n === 2 ? 'Afternoon Work Block | 1:00 PM - 4:00 PM ET | Daily'
          : 'Name | 9:00 AM - 10:00 AM ET | Mon-Fri / Mon/Wed/Fri / Daily / Weekends'
          )
      );

      modal.addComponents(eventInputs.map(i => new ActionRowBuilder().addComponents(i)));
      await interaction.showModal(modal);
    }

    if (interaction.commandName === 'setupworldclock') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const channel = interaction.guild.channels.cache.get(WORLD_CLOCK_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ World clock channel not found.', flags: 64 });
      const embed = new EmbedBuilder()
        .setTitle('🌍 #WORLD-CLOCK — TIMEZONE COORDINATION')
        .setDescription("*Track every member's local time. Know when your brothers are online.*")
        .addFields(
          {
            name: '⚙️ Set or Update Your Timezone',
            value:
              'Use `/timezone` to set or change your timezone.\n\n' +
              "You'll get a paginated menu of timezone options. Pick yours, you're set.\n\n" +
              'Your local time will appear in the live clock embed below.'
          },
          {
            name: '🔄 Manual Refresh',
            value:
              'Use `/worldclock` to force a refresh of the live clock embed.\n\n' +
              'The clock auto-refreshes every 5 minutes but you can force it if needed.'
          }
        )
        .setColor(0xe63b1e)
        .setFooter({ text: 'Set once. Updates automatically.' });
      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: `✅ World clock info posted and pinned in <#${channel.id}>.`, flags: 64 });
    }

    if (interaction.commandName === 'announce') {
      const title   = interaction.options.getString('title');
      const message = interaction.options.getString('message');
      const channel = client.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: 'Announcements channel not found.', flags: 64 });
      const embed = new EmbedBuilder()
        .setTitle(`❗ ${title}`)
        .setDescription(message)
        .setColor(NETWORK_ACCENT)
        .setTimestamp()
        .setFooter({ text: `Announced by ${interaction.user.username}` });
      await channel.send({ content: '@everyone', embeds: [embed] });
      await interaction.reply({ content: 'Announcement posted.', flags: 64 });
    }

    if (interaction.commandName === 'cancelwarroom') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      await interaction.reply({ content: 'Cancelling today\'s War Room…', flags: 64 });
      try {
        const result = await cancelWarRoom(interaction.guild, client, {
          eventsChannelId: EVENTS_CHANNEL_ID,
          invokedBy: interaction.user.tag,
        });
        if (!result.ok) {
          return interaction.editReply({ content: `⚠️ ${result.error}` });
        }
        const names = result.cancelled.map(c => c.name).join(', ');
        const note = result.announced
          ? `Announcement posted in <#${EVENTS_CHANNEL_ID}>.`
          : '⚠️ Event cancelled but the announcement could not be posted (events channel not found).';
        await interaction.editReply({ content: `✅ Cancelled: ${names}. ${note}` });
      } catch (e) {
        console.error('cancelwarroom error:', e);
        await interaction.editReply({ content: `❌ Error cancelling War Room: ${e.message}` });
      }
    }

    if (interaction.commandName === 'standings') {
      await interaction.reply({ content: 'Refreshing standings board…', flags: 64 });
      const guild = interaction.guild;
      await postWeeklyBoard(guild, client);
      await postDailyBoard(guild, client);
      await interaction.editReply({ content: 'Daily + weekly boards refreshed in #leaderboard.' });
    }

    if (interaction.commandName === 'timezone') {
      await interaction.reply({ content: 'Select your timezone:', components: [buildTimezoneUpdateComponents(0)], flags: 64 });
    }

    if (interaction.commandName === 'worldclock') {
      await interaction.reply({ content: 'Updating world clock...', flags: 64 });
      await updateWorldClock();
      await interaction.editReply({ content: 'World clock updated.' });
    }

    if (interaction.commandName === 'points') {
      const userId = interaction.user.id;
      const data   = getUserPoints(userId);
      const tier   = [...ROLE_TIERS].reverse().find(t => data.allTime >= t.minPoints) || ROLE_TIERS[0];
      const next   = ROLE_TIERS.find(t => t.minPoints > data.allTime);
      const embed  = new EmbedBuilder()
        .setTitle('📊 Your Points')
        .addFields(
          { name: 'All-Time',  value: `${data.allTime} pts`,  inline: true },
          { name: 'This Week', value: `${data.weekly} pts`,   inline: true },
          { name: 'Today',     value: `${data.daily} pts`,    inline: true },
          { name: 'Current Tier', value: tier.name,           inline: true },
          { name: 'Next Tier', value: next ? `${next.name} (${next.minPoints - data.allTime} pts away)` : 'Max tier reached', inline: true },
        )
        .setColor(NETWORK_ACCENT);
      await interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (interaction.commandName === 'leaderboard') {
      await interaction.deferReply({ flags: 64 });
      await postAllTimeLeaderboard(interaction.guild, client, interaction);
      postWeeklyBoard(interaction.guild, client).catch(() => {});
      postDailyBoard(interaction.guild, client).catch(() => {});
    }

    if (interaction.commandName === 'adjustpoints') {
      // Admin only — check for manage guild permission
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason') || 'Manual adjustment';

      const scope = interaction.options.getString('scope') || 'alltime';
      const data = loadPoints();
      if (!data[target.id]) data[target.id] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: null };
      data[target.id].allTime = Math.max(0, data[target.id].allTime + amount);
      if (scope === 'all') {
        data[target.id].weekly = Math.max(0, data[target.id].weekly + amount);
        data[target.id].daily  = Math.max(0, data[target.id].daily  + amount);
      }
      savePoints(data);

      const targetMember = interaction.guild.members.cache.get(target.id);
      if (targetMember) await updateMemberRole(targetMember, data[target.id].allTime);
      postAllTimeLeaderboard(interaction.guild, client).catch(() => {});
      postWeeklyBoard(interaction.guild, client).catch(() => {});
      postDailyBoard(interaction.guild, client).catch(() => {});

      const sign = amount >= 0 ? '+' : '';
      const adminName = interaction.member?.nickname || interaction.user.username;
      const targetName = interaction.guild.members.cache.get(target.id)?.nickname || target.username;

      await interaction.reply({
        content: `✅ **${targetName}** — ${sign}${amount} pts (${reason}). New all-time: **${data[target.id].allTime} pts**`,
        flags: 64
      });

      await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
        .setTitle('🪙 Points Manually Adjusted')
        .addFields(
          { name: 'Target',    value: targetName,                    inline: true },
          { name: 'Amount',    value: `${sign}${amount} pts`,        inline: true },
          { name: 'All-Time',  value: `${data[target.id].allTime} pts`, inline: true },
          { name: 'Reason',    value: reason,                        inline: false },
          { name: 'Admin',     value: adminName,                     inline: true },
        )
        .setColor(amount >= 0 ? 0x57F287 : 0xED4245)
        .setTimestamp()
      );
    }

    if (interaction.commandName === 'clearlogs') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }

      // Only allow in admin log channels
      const adminChannels = new Set([
        LOG_COMMANDS_ID, LOG_MEMBERS_ID, LOG_INACTIVITY_ID,
        LOG_ACCOUNTABILITY_ID, LOG_ROLES_ID, LOG_POINTS_AUDIT_ID,
        LOG_DELETED_MESSAGES_ID
      ]);

      if (!adminChannels.has(interaction.channelId)) {
        return interaction.reply({ content: '⚠️ This command can only be used in admin log channels.', flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      const channel = interaction.channel;
      let deleted = 0;

      // Bulk delete in batches of 100
      let fetched;
      do {
        fetched = await channel.messages.fetch({ limit: 100 });
        if (fetched.size === 0) break;
        await channel.bulkDelete(fetched, true).catch(() => {});
        deleted += fetched.size;
      } while (fetched.size >= 2);

      const adminName = interaction.member?.nickname || interaction.user.username;
      await interaction.editReply({ content: `✅ Cleared **${deleted}** messages from <#${channel.id}>.` });
    }

    if (interaction.commandName === 'backuppoints') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      await interaction.deferReply({ flags: 64 });
      await backupPoints(interaction.guild, client);
      await interaction.editReply({ content: '✅ Backup posted to accountability log.' });
    }

    if (interaction.commandName === 'setupproven') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }

      const embed = new EmbedBuilder()
        .setTitle('⚡ PROVEN — Command Reference')
        .setDescription(
          '*You have earned the highest role in EVOLVE. These are the tools available to you as a Proven member. Use them with discretion.*'
        )
        .addFields(
          {
            name: '📢 Announcements',
            value:
              '`/announce` — Post a formatted @everyone announcement in #announcements.\n' +
              '*Usage: `/announce title: message:`*'
          },
          {
            name: '📊 Leaderboard & Standings',
            value:
              '`/standings` — Manually trigger the daily standings post in #leaderboard.\n' +
              '`/leaderboard` — Post and refresh the all-time leaderboard.'
          },
          {
            name: '🪙 Points Management',
            value:
              '`/adjustpoints @user amount reason` — Manually add or subtract points from a member.\n' +
              '*Use positive numbers to add, negative to subtract. Always include a reason.*\n' +
              '`/backuppoints` — Post a full points backup file to the accountability log.'
          },
          {
            name: '🗳️ Voting',
            value:
              '`/vote type:yes/no question:"..." duration:24` — Yes/No vote\n' +
              '`/vote type:multiple question:"..." option1:"..." option2:"..." duration:24` — Multiple choice\n' +
              '`/vote type:nomination question:"..." nominee1:@user nominee2:@user duration:24` — Nomination vote'
          },
          {
            name: '🔍 Monitoring',
            value:
              '`/checkinactivity` — View all members and their last active time, flagging anyone inactive 3+ days.\n' +
              '`/worldclock` — Manually refresh the world clock embed.'
          },
          {
            name: '⚠️ Permissions Reminder',
            value:
              'You have the ability to delete messages, mute members in voice, and move members between voice channels.\n\n' +
              'You do **not** have the ability to kick, ban, manage roles, or manage channels.\n\n' +
              '*If a situation requires escalation, bring it to the owner directly.*'
          }
        )
        .setColor(NETWORK_ACCENT)
        .setFooter({ text: 'EVOLVE — Proven Command Reference' });

      const msg = await interaction.channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: '✅ Proven command reference posted and pinned.', flags: 64 });
    }

    if (interaction.commandName === 'setupvoting') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }

      const channel = interaction.guild.channels.cache.get(VOTE_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ Vote channel not found.', flags: 64 });

      const embed = new EmbedBuilder()
        .setTitle('✅ EVOLVE — Voting Guide')
        .setDescription('*Your voice shapes the community. Votes are anonymous — only tallies are shown, never who voted for what.*')
        .addFields(
          {
            name: '📊 Vote Types',
            value:
              '**Yes / No** — Simple agree or disagree on a proposal.\n' +
              '**Multiple Choice** — Pick from up to 4 custom options.\n' +
              '**Nomination** — Vote for a member from an admin-selected list of nominees. 🏆 Winner earns +10 points.'
          },
          {
            name: '⏱️ Duration',
            value: '1 hour • 6 hours • 12 hours • 24 hours • 48 hours • 72 hours\n*Set by leadership when creating the vote.*'
          },
          {
            name: '🪙 Points for Voting',
            value:
              '**Cast any vote** — **+3 points**\n' +
              '**Win a nomination vote** — **+10 points**\n\n' +
              '*You can change your vote at any time before the poll closes.*'
          },
          {
            name: '🔒 Anonymous',
            value: 'All votes are completely anonymous. Results show tallies only — no names, no history.'
          }
        )
        .setColor(0xe63b1e)
        .setFooter({ text: 'EVOLVE — Voting System' });

      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      await interaction.reply({ content: `✅ Voting guide posted and pinned in <#${channel.id}>.`, flags: 64 });
    }

    if (interaction.commandName === 'vote') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ Only admins can create votes.', flags: 64 });
      }
      await createVote(interaction);
    }

    if (interaction.commandName === 'checkinactivity') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      await interaction.deferReply({ flags: 64 });

      const lastSeen = loadLastSeen();
      const now = Date.now();
      const members = await interaction.guild.members.fetch();

      const rows = [];
      for (const [id, member] of members) {
        if (member.user.bot) continue;
        const hasRole = ROLE_TIERS.some(t => t.roleId && member.roles.cache.has(t.roleId));
        if (!hasRole) continue;

        const last = lastSeen[id];
        const name = member.nickname || member.user.username;

        if (!last) {
          rows.push({ name, display: `**${name}** — never recorded` });
        } else {
          const daysSince = Math.floor((now - last) / (24 * 60 * 60 * 1000));
          const timestamp = Math.floor(last / 1000);
          const flag = daysSince >= INACTIVITY_THRESHOLD_DAYS ? ' ⚠️' : '';
          rows.push({ name, daysSince: daysSince || 0, display: `**${name}** — last seen <t:${timestamp}:R>${flag}` });
        }
      }

      rows.sort((a, b) => (b.daysSince ?? 999) - (a.daysSince ?? 999));

      if (!rows.length) {
        return interaction.editReply({ content: 'No activity data found yet.' });
      }

      // Split into chunks if over Discord's 4096 char limit
      const lines = rows.map(r => r.display);
      const chunks = [];
      let current = '';
      for (const line of lines) {
        if ((current + '\n' + line).length > 3800) {
          chunks.push(current);
          current = line;
        } else {
          current += (current ? '\n' : '') + line;
        }
      }
      if (current) chunks.push(current);

      for (let i = 0; i < chunks.length; i++) {
        const embed = new EmbedBuilder()
          .setTitle(i === 0 ? `👥 Member Activity Report` : `👥 Member Activity Report (cont.)`)
          .setDescription(chunks[i])
          .setColor(0x5865F2)
          .setFooter({ text: `⚠️ = inactive ${INACTIVITY_THRESHOLD_DAYS}+ days • Sorted by least recent` })
          .setTimestamp();

        if (i === 0) await interaction.editReply({ embeds: [embed] });
        else await interaction.followUp({ embeds: [embed], flags: 64 });
      }
    }

    // ── /setuponboarding ────────────────────────────────────────────────────────
    if (interaction.commandName === 'setuponboarding') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      const channel = interaction.guild.channels.cache.get(RULES_CHANNEL_ID);
      if (!channel) return interaction.reply({ content: '⚠️ Rules channel not found.', flags: 64 });

      const onboardingEmbed = ROOM_MODE ? roomCopy.onboarding() : new EmbedBuilder()
        .setTitle('🎯 START YOUR ONBOARDING')
        .setDescription(
          '*You just joined EVOLVE. Before you can access the rest of the server, ' +
          'you need to complete onboarding.*\n\n' +
          '*Read the contract above carefully, then click below to begin.*'
        )
        .addFields({
          name: '📋 What You\'ll Do',
          value:
            '1. Acknowledge the rules\n' +
            '2. Set your real name\n' +
            '3. Set your timezone\n' +
            '4. Acknowledge the accountability standard\n' +
            '5. Complete your introduction\n\n' +
            'Takes 2 minutes. Then you\'re in.',
        })
        .setColor(0xe63b1e)
        .setFooter({ text: 'One click. Then the work.' });

      const onboardingButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('start_onboarding')
          .setLabel('Begin Onboarding')
          .setStyle(ButtonStyle.Danger)
      );

      try {
        const pins = await channel.messages.fetchPinned();
        const existing = pins.find(m =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0]?.title?.includes('START YOUR ONBOARDING')
        );

        if (existing) {
          await existing.edit({ embeds: [onboardingEmbed], components: [onboardingButton] });
          return interaction.reply({ content: '✅ Onboarding entry-point updated in #rules.', flags: 64 });
        } else {
          const msg = await channel.send({ embeds: [onboardingEmbed], components: [onboardingButton] });
          await msg.pin().catch(() => {});
          return interaction.reply({ content: '✅ Onboarding entry-point posted and pinned in #rules.', flags: 64 });
        }
      } catch (e) {
        console.error('Error in /setuponboarding:', e);
        return interaction.reply({ content: `⚠️ Error: ${e.message}`, flags: 64 });
      }
    }

    // ── /resetonboarding ────────────────────────────────────────────────────────
    if (interaction.commandName === 'resetonboarding') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }

      const targetUser   = interaction.options.getUser('user');
      const confirmFlag  = interaction.options.getBoolean('confirm') || false;

      // Reject bots
      if (targetUser.bot) {
        return interaction.reply({ content: '⛔ Cannot reset onboarding for a bot.', flags: 64 });
      }

      // Fetch target member
      let targetMember = interaction.guild.members.cache.get(targetUser.id)
        || await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({ content: `⛔ <@${targetUser.id}> is not in this server.`, flags: 64 });
      }

      // Reject admin / owner
      const isAdmin = targetMember.permissions.has('Administrator') || interaction.guild.ownerId === targetMember.id;
      if (isAdmin) {
        return interaction.reply({ content: '⛔ Cannot reset onboarding for an admin or server owner.', flags: 64 });
      }

      const isSelf = interaction.user.id === targetUser.id;
      const selfWarn = isSelf ? '\n\n⚠️ **Note:** You are resetting your own onboarding.' : '';

      if (confirmFlag) {
        // Execute immediately without prompt
        await interaction.deferReply({ flags: 64 });
        await executeOnboardingReset(interaction.guild, targetUser.id, targetMember);
        return interaction.editReply({
          content:
            `✅ Onboarding reset for <@${targetUser.id}>. They'll walk through the flow again on next interaction.` +
            (isSelf ? '\n⚠️ Note: You reset yourself.' : ''),
        });
      } else {
        // Show confirmation prompt
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`resetonb_confirm:${targetUser.id}`)
            .setLabel('Yes, Reset')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('resetonb_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({
          content:
            `⚠️ **Reset onboarding for <@${targetUser.id}>?**${selfWarn}\n\n` +
            `This will:\n` +
            `• Remove roles: Prospect, Member, Veteran, Elite, Proven, Agreed, Timezone Set, Accountability Set\n` +
            `• Assign role: Pending\n` +
            `• Set onboardingState = PENDING\n` +
            `• Clear realName field\n` +
            `• Delete their intro post in #welcome (if found in last 100 messages)\n` +
            `• **PRESERVE** all points (all-time, weekly, daily)`,
          components: [confirmRow],
          flags: 64,
        });
      }
    }

    // ── /setupdailyitinerary ────────────────────────────────────────────────────
    if (interaction.commandName === 'setupdailyitinerary') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', flags: 64 });
      }
      await interaction.deferReply({ flags: 64 });
      try {
        await updateDailyItineraryEmbed(interaction.guild);
        return interaction.editReply({ content: '✅ Daily Itinerary embed posted/updated in #world-clock.' });
      } catch (e) {
        console.error('Error in /setupdailyitinerary:', e);
        return interaction.editReply({ content: `⚠️ Error: ${e.message}` });
      }
    }

    // ── /myschedule ─────────────────────────────────────────────────────────────
    if (interaction.commandName === 'myschedule') {
      try {
        const member = interaction.member;
        const userTz = memberTimezones.get(member.id);
        if (!userTz) {
          return interaction.reply({
            content: "You haven't set a timezone yet. Use /timezone to set yours.",
            flags: 64,
          });
        }
        const tzLabel = TIMEZONES.find(t => t.value === userTz)?.label || userTz;
        const schedule = loadEventsSchedule();

        const fields = [];

        // ── War Rooms ──
        if (schedule && schedule.events && schedule.events.length > 0) {
          const warRoomLines = schedule.events.map(ev => {
            const displayTime = ev.time.replace(/(\b(?:AM|PM)\b)\s+[A-Z]{2,4}$/i, '$1').trim();
            return `**${ev.name}** (${ev.days}): ${convertETTime(ev.time, userTz)}`;
          }).join('\n');
          fields.push({ name: '🎙️ War Rooms', value: warRoomLines, inline: false });
        } else {
          fields.push({ name: '🎙️ War Rooms', value: '*No events scheduled yet.*', inline: false });
        }

        // ── Standings ──
        const dailyTime  = convertETTime('11:00 PM', userTz);
        const weeklyTime = convertETTime('11:00 PM', userTz);
        fields.push({
          name: '📊 Standings',
          value: `Daily standings: **${dailyTime}**\nWeekly leaderboard: Sunday **${weeklyTime}**`,
          inline: false,
        });

        const embed = new EmbedBuilder()
          .setTitle('🕘 YOUR PERSONAL ITINERARY')
          .setDescription(`*In your timezone (${tzLabel}):*`)
          .addFields(fields)
          .setColor(NETWORK_ACCENT)
          .setFooter({ text: 'Schedule changes? Use /myschedule again to refresh.' });
        return interaction.reply({ embeds: [embed], flags: 64 });
      } catch (e) {
        console.error('Error in /myschedule:', e);
        return interaction.reply({ content: `⚠️ Error: ${e.message}`, flags: 64 });
      }
    }
  }

  // ── Select menus ────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {

    if (interaction.customId.startsWith('timezone_onboarding')) {
      try {
        const member = interaction.member;
        const tz     = interaction.values[0];

        // Handle pagination — update ephemeral in-place
        if (tz.startsWith('__page_')) {
          const nextPage = parseInt(tz.replace('__page_', ''));
          await interaction.update({ components: [buildTimezoneComponents(nextPage)] });
          return;
        }

        // Guard: must be in NICKNAME_SET state (step 3 of ephemeral onboarding)
        const userData = getUserPoints(member.id);
        if (userData.onboardingState !== 'NICKNAME_SET') {
          await interaction.reply({ content: 'You have already set your timezone or have not completed the previous step.', flags: 64 });
          return;
        }

        const tzLabel = TIMEZONES.find(t => t.value === tz)?.label || tz;

        // Save timezone and advance state
        memberTimezones.set(member.id, tz);
        saveTimezones();
        await updateWorldClock().catch(() => {});

        const data = loadPoints();
        if (data[member.id]) data[member.id].onboardingState = 'TIMEZONE_SET';
        savePoints(data);

        await member.roles.remove(AGREED_ROLE_ID).catch(() => {});
        await member.roles.add(TIMEZONE_SET_ROLE_ID).catch(console.error);

        // Update ephemeral to Step 4
        const step3Row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('onb_step3_acknowledge')
            .setLabel('I Understand The Standard')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚡ STEP 4 OF 5 — THE DISCIPLINE STANDARD')
              .setColor(0xe63b1e)
              .setDescription(
                `*✅ Timezone set to **${tzLabel}**.\n\n` +
                'The Eye is the bot that watches every member. Every habit you check in counts. Every week, your score shows if you showed up.\n\n' +
                '**The Standard:**\n' +
                '• Build your habit system: at least 4 🧬 Evolution + 1 📈 Trading habit, scheduled on your days\n' +
                '• `/checkin` every habit you knock out, with photo proof when you can\n' +
                '• Run your trading process even on days not worth trading\n' +
                '• War room attendance (when you can)\n\n' +
                '**Scoring:**\n' +
                '• Above 25 points/week = you\'re showing up\n' +
                '• Below 25 points/week = DM warning + called out in #callouts\n\n' +
                'Read the full system guide in #rules before clicking. You\'re agreeing to be measured.*'
              )
          ],
          components: [step3Row],
          content: '',
        });

        // Log Step 3
        await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
          .setTitle('📋 Onboarding — Timezone Set')
          .addFields(
            { name: 'Member',   value: member.nickname || member.user.username, inline: true },
            { name: 'Timezone', value: tzLabel,                                  inline: true },
            { name: 'Step',     value: '3 of 5',                                 inline: true },
          )
          .setColor(0xFFD700).setTimestamp()
        );

      } catch (e) { console.error('Error setting timezone:', e); }
    }

    if (interaction.customId === 'timezone_update') {
      try {
        const member  = interaction.member;
        const tz      = interaction.values[0];
        const tzLabel = TIMEZONES.find(t => t.value === tz)?.label || tz;
        memberTimezones.set(member.id, tz);
        saveTimezones();
        await updateWorldClock();
        await interaction.reply({ content: `Timezone updated to **${tzLabel}**.`, flags: 64 });
      } catch (e) {
        console.error('Error updating timezone:', e);
        await interaction.reply({ content: 'Something went wrong. Try again.', flags: 64 });
      }
    }

    if (interaction.customId.startsWith('timezone_update_p')) {
      try {
        const member = interaction.member;
        const tz     = interaction.values[0];

        // Handle pagination
        if (tz.startsWith('__page_')) {
          const nextPage = parseInt(tz.replace('__page_', ''));
          await interaction.update({ components: [buildTimezoneUpdateComponents(nextPage)] });
          return;
        }

        const tzLabel = TIMEZONES.find(t => t.value === tz)?.label || tz;
        memberTimezones.set(member.id, tz);
        saveTimezones();
        await updateWorldClock();
        await interaction.reply({ content: `✅ Timezone updated to **${tzLabel}**.`, flags: 64 });
      } catch (e) {
        console.error('Error updating timezone:', e);
        await interaction.reply({ content: 'Something went wrong. Try again.', flags: 64 });
      }
    }
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {

    // Handle vote buttons first
    if (interaction.customId.startsWith('vote_option:')) {
      await handleVoteButton(interaction);
      return;
    }

    // ── New ephemeral onboarding entry-point ──────────────────────────────────
    if (interaction.customId === 'start_onboarding') {
      try {
        const member = interaction.member;
        // If already Prospect or higher, skip
        if (ROLE_TIERS.some(t => t.roleId && member.roles.cache.has(t.roleId))) {
          return interaction.reply({ content: 'You have already completed onboarding.', flags: 64 });
        }
        // Paid gate (Whop grants PAID_ROLE_ID on purchase): no paid role, no onboarding.
        if (PAID_ROLE_ID && !member.roles.cache.has(PAID_ROLE_ID)) {
          return interaction.reply({
            content: 'Evolve Trading is for members. Join here, then come back and click **Begin Onboarding**:\n' +
              (JOIN_URL || 'ask Luccas for the link'),
            flags: 64,
          });
        }
        // Ensure they have PENDING_ROLE (add if missing — e.g. legacy member)
        if (!member.roles.cache.has(PENDING_ROLE_ID)) {
          await member.roles.add(PENDING_ROLE_ID).catch(() => {});
        }
        // Update onboarding state
        const data = loadPoints();
        if (!data[member.id]) data[member.id] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: 'PENDING' };
        else data[member.id].onboardingState = 'PENDING';
        savePoints(data);

        // Store this interaction before reply so we can delete M1 when name_modal submits
        userEphemerals.set(member.id, interaction);

        if (ROOM_MODE) {
          await interaction.reply({ ...standardCardPayload(0, true), flags: 64 });
          unlockStandardCard(interaction, 0);
          await logOnboardingStep(member, 'Started', 'Started');
          return;
        }

        const step1Row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('onb_step1_agree')
            .setLabel('I Agree')
            .setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('📋 STEP 1 OF 5 — THE CONTRACT')
              .setColor(0xe63b1e)
              .setDescription(
                '*The rules above are not suggestions. They define what EVOLVE is and what it isn\'t.\n\n' +
                'Daily habits in #training, #nutrition, #trading-review and #trade-journal. War room attendance. Direct access to Luccas. ' +
                'Public callouts when you fall behind.\n\n' +
                'When you click I Agree below, you are signing a contract. Not with me — with yourself. ' +
                'You are committing to the man you said you wanted to become when you applied for a seat here.\n\n' +
                'Read every word above before clicking.*'
              )
          ],
          components: [step1Row],
          flags: 64,
        });
      } catch (e) { console.error('Error handling start_onboarding:', e); }
    }

    // ── Room mode: next card of the standard ───────────────────────────────────
    if (interaction.customId.startsWith('onb_std_next:')) {
      try {
        const i = Number(interaction.customId.split(':')[1]);
        await interaction.update(standardCardPayload(i, true));
        unlockStandardCard(interaction, i);
        await logOnboardingStep(interaction.member, roomCopy.STANDARD[i - 1].title, `${i} of ${roomCopy.STEPS}`);
      } catch (e) { console.error('Error handling onb_std_next:', e); }
    }

    // ── Step 1: Agree to rules ─────────────────────────────────────────────────
    if (interaction.customId === 'onb_step1_agree') {
      try {
        const member = interaction.member;
        if (!member.roles.cache.has(PENDING_ROLE_ID)) {
          return interaction.reply({ content: 'You have already agreed to the rules.', flags: 64 });
        }

        // Room mode: the member holds the one Onboarding (PENDING) role until the intro lands.
        if (!ROOM_MODE) {
          await member.roles.remove(PENDING_ROLE_ID);
          await member.roles.add(AGREED_ROLE_ID);
        }

        const data = loadPoints();
        if (!data[member.id]) data[member.id] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: 'AGREED' };
        else data[member.id].onboardingState = 'AGREED';
        savePoints(data);

        const step2NicknameRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('onb_step2_open_name_modal')
            .setLabel('Set My Name')
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.update({
          embeds: [
            ROOM_MODE ? roomCopy.step2() : new EmbedBuilder()
              .setTitle('👤 STEP 2 OF 5 — YOUR REAL NAME')
              .setColor(0xe63b1e)
              .setDescription(
                '*Your Discord username is anonymous. EVOLVE is not.\n\n' +
                'We operate on real names because real names carry weight. Other members see who you are. ' +
                'The world-clock shows your real name across timezones. When you log a trade, your real name is attached to it. ' +
                'When you miss a day, your real name is on the leaderboard.\n\n' +
                'Anonymous discipline is fake discipline. Identity comes first.*'
              )
          ],
          components: [step2NicknameRow],
          content: '',
        });

        const name = member.nickname || member.user.username;
        await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
          .setTitle('📋 Onboarding — Rules Agreed')
          .addFields(
            { name: 'Member', value: name,     inline: true },
            { name: 'Step',   value: ROOM_MODE ? `5 of ${roomCopy.STEPS}` : '1 of 5', inline: true },
          )
          .setColor(0xFFD700).setTimestamp()
        );
      } catch (e) { console.error('Error handling onb_step1_agree:', e); }
    }

    // ── Step 2: Open name modal ────────────────────────────────────────────────
    if (interaction.customId === 'onb_step2_open_name_modal') {
      try {
        const member = interaction.member;
        const userData = getUserPoints(member.id);
        if (userData.onboardingState !== 'AGREED') {
          return interaction.reply({ content: 'You have already set your name, or have not agreed to the rules yet.', flags: 64 });
        }

        const nameModal = new ModalBuilder()
          .setCustomId('name_modal')
          .setTitle('Your Real Name');

        const firstNameInput = new TextInputBuilder()
          .setCustomId('first_name')
          .setLabel('First Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(30)
          .setPlaceholder('John');

        const lastNameInput = new TextInputBuilder()
          .setCustomId('last_name')
          .setLabel('Last Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(30)
          .setPlaceholder('Smith');

        nameModal.addComponents(
          new ActionRowBuilder().addComponents(firstNameInput),
          new ActionRowBuilder().addComponents(lastNameInput),
        );

        await interaction.showModal(nameModal);
      } catch (e) { console.error('Error showing name modal:', e); }
    }

    // ── Step 3: Acknowledge discipline standard ───────────────────────────────
    if (interaction.customId === 'onb_step3_acknowledge') {
      try {
        const member = interaction.member;
        if (!member.roles.cache.has(TIMEZONE_SET_ROLE_ID)) {
          return interaction.reply({ content: 'Complete the timezone step first.', flags: 64 });
        }

        await member.roles.remove(TIMEZONE_SET_ROLE_ID);
        await member.roles.add(ACCOUNTABILITY_SET_ROLE_ID);

        const data = loadPoints();
        if (data[member.id]) data[member.id].onboardingState = 'ACCOUNTABILITY_SET';
        savePoints(data);

        const step4Row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('onb_step4_open_modal')
            .setLabel('Open Intro Form')
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle('📝 STEP 5 OF 5 — YOUR INTRODUCTION')
              .setColor(0xe63b1e)
              .setDescription(
                '*✅ Discipline enrolled.\n\n' +
                'The last step. The brotherhood needs to know who you are.\n\n' +
                'Click below to open the introduction form. Five fields — name, location, what you trade, why you\'re here, your commitment.\n\n' +
                'Bullshit answers get flagged. Specific answers earn respect.\n\n' +
                'This is the first thing other members see when they look you up. Make it count.*'
              )
          ],
          components: [step4Row],
          content: '',
        });

        const name = member.nickname || member.user.username;
        await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
          .setTitle('📋 Onboarding — Discipline Enrolled')
          .addFields(
            { name: 'Member', value: name,     inline: true },
            { name: 'Step',   value: '4 of 5', inline: true },
          )
          .setColor(0xFFD700).setTimestamp()
        );
      } catch (e) { console.error('Error handling onb_step3_acknowledge:', e); }
    }

    // ── Step 4: Open intro modal ───────────────────────────────────────────────
    if (interaction.customId === 'onb_step4_open_modal') {
      try {
        const member = interaction.member;
        if (!member.roles.cache.has(ROOM_MODE ? PENDING_ROLE_ID : ACCOUNTABILITY_SET_ROLE_ID)) {
          return interaction.reply({ content: 'Complete the previous steps first.', flags: 64 });
        }

        const modal = new ModalBuilder()
          .setCustomId('intro_modal')
          .setTitle('Your Introduction');

        const nameInput = new TextInputBuilder()
          .setCustomId('intro_name')
          .setLabel('First Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50)
          .setPlaceholder('John');

        const locationInput = new TextInputBuilder()
          .setCustomId('intro_location')
          .setLabel('City/State, Country')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder('e.g., Austin/Texas, USA');

        const tradingInput = new TextInputBuilder()
          .setCustomId('intro_trading')
          .setLabel('What You Trade / How Long / Current State')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder('Futures, 2 years. Profitable on sim, struggling to hold winners live.');

        const whyInput = new TextInputBuilder()
          .setCustomId('intro_why')
          .setLabel("Why I'm Here (What you're trying to fix)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder("I need accountability. I overtrade when I'm up.");

        const commitInput = new TextInputBuilder()
          .setCustomId('intro_commit')
          .setLabel(ROOM_MODE ? 'Your Commitment to Show Up' : "Your Commitment (I will / I won't)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(300)
          .setPlaceholder(ROOM_MODE
            ? "I will show up every day and post my wins and my losses."
            : "I will post every log daily. I won't skip without notifying.");

        modal.addComponents(
          new ActionRowBuilder().addComponents(nameInput),
          new ActionRowBuilder().addComponents(locationInput),
          new ActionRowBuilder().addComponents(tradingInput),
          new ActionRowBuilder().addComponents(whyInput),
          new ActionRowBuilder().addComponents(commitInput),
        );

        await interaction.showModal(modal);
      } catch (e) { console.error('Error showing intro modal:', e); }
    }

    // ── Reset onboarding confirm button ───────────────────────────────────────
    if (interaction.customId.startsWith('resetonb_confirm:')) {
      try {
        if (!interaction.member.permissions.has('ManageGuild')) {
          return interaction.reply({ content: '⛔ You do not have permission.', flags: 64 });
        }
        const targetUserId = interaction.customId.split(':')[1];
        await interaction.deferUpdate();
        const tMember = interaction.guild.members.cache.get(targetUserId)
          || await interaction.guild.members.fetch(targetUserId).catch(() => null);
        await executeOnboardingReset(interaction.guild, targetUserId, tMember);
        await interaction.editReply({
          content: `✅ Onboarding reset for <@${targetUserId}>. They'll walk through the flow again on next interaction.`,
          components: [],
        });
      } catch (e) { console.error('Error in resetonb_confirm:', e); }
    }

    // ── Reset onboarding cancel button ────────────────────────────────────────
    if (interaction.customId === 'resetonb_cancel') {
      try {
        await interaction.update({ content: '❌ Reset cancelled.', components: [] });
      } catch (e) { console.error('Error in resetonb_cancel:', e); }
    }
  }

  // ── Modal submissions ───────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {

    // ── Name modal (Step 2 of onboarding) ───────────────────────────────────
    if (interaction.customId === 'name_modal') {
      try {
        const member = interaction.member;
        const firstName = interaction.fields.getTextInputValue('first_name').trim();
        const lastName  = interaction.fields.getTextInputValue('last_name').trim();
        const nickname  = `${firstName} ${lastName}`.replace(/\s+/g, ' ').trim();

        // Validate: Unicode letters, spaces, hyphens, apostrophes, periods
        const nameRegex = /^[\p{L}\s\-'.]+$/u;
        if (!nameRegex.test(nickname)) {
          return interaction.reply({
            content:
              `⚠️ **Invalid name format.**\n\n` +
              `Names can only contain:\n` +
              `• Letters (including international characters)\n` +
              `• Spaces\n` +
              `• Hyphens (-), apostrophes ('), periods (.)\n\n` +
              `Please click **Set My Name** again and try a different name.`,
            flags: 64,
          });
        }

        // Set server nickname
        await member.setNickname(nickname).catch(e => console.error('Error setting nickname:', e));

        // Save to points.json
        const pData = loadPoints();
        if (!pData[member.id]) pData[member.id] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: 'NICKNAME_SET' };
        else pData[member.id].onboardingState = 'NICKNAME_SET';
        pData[member.id].realName = nickname;
        savePoints(pData);

        const priorInteraction = userEphemerals.get(member.id);

        if (ROOM_MODE) {
          // Room mode: name -> intro. Skip timezone + standard. No role change here: the member
          // stays AGREED until the intro lands, so the channel list doesn't shift mid-flow, and
          // the new card posts BEFORE the old one goes so the screen is never left empty.
          const rData = loadPoints();
          if (rData[member.id]) rData[member.id].onboardingState = 'ACCOUNTABILITY_SET';
          savePoints(rData);
          await interaction.reply({
            embeds: [roomCopy.step3(nickname)],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('onb_step4_open_modal').setLabel('Open Intro Form').setStyle(ButtonStyle.Primary)
            )],
            flags: 64,
          });
          if (priorInteraction) {
            try { await priorInteraction.deleteReply(); } catch (_) {}
          }
          userEphemerals.set(member.id, interaction);
          await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
            .setTitle('📋 Onboarding — Nickname Set')
            .addFields(
              { name: 'Member',   value: member.user.username, inline: true },
              { name: 'Nickname', value: nickname,             inline: true },
              { name: 'Step',     value: `6 of ${roomCopy.STEPS}`, inline: true },
            )
            .setColor(0xFFD700).setTimestamp()
          );
          return;
        }

        // Delete prior ephemeral (M1 — the step 1/2 embed) before posting step 3
        if (priorInteraction) {
          try { await priorInteraction.deleteReply(); } catch (_) {}
        }

        // Show Step 3 — Timezone (new ephemeral M2)
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🌍 STEP 3 OF 5 — YOUR TIMEZONE')
              .setColor(0xe63b1e)
              .setDescription(
                `*✅ Name set to **${nickname}**.\n\n` +
                'EVOLVE operates across timezones. War rooms run on Eastern Time (ET), but members trade and train from across the world.\n\n' +
                'Set your timezone so the world-clock can coordinate the community. So members know when you\'re awake. ' +
                'So scheduled events show up in your local time.\n\n' +
                'This is how a global community stays in sync.*'
              )
          ],
          components: [buildTimezoneComponents(0)],
          flags: 64,
        });

        // Store this interaction so intro_modal can delete M2
        userEphemerals.set(member.id, interaction);

        await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
          .setTitle('📋 Onboarding — Nickname Set')
          .addFields(
            { name: 'Member',   value: member.user.username, inline: true },
            { name: 'Nickname', value: nickname,             inline: true },
            { name: 'Step',     value: '2 of 5',             inline: true },
          )
          .setColor(0xFFD700).setTimestamp()
        );
      } catch (e) { console.error('Error handling name_modal submit:', e); }
    }

    if (interaction.customId === 'intro_modal') {
      try {
        const member = interaction.member;
        const name     = interaction.fields.getTextInputValue('intro_name');
        const location = interaction.fields.getTextInputValue('intro_location');
        const trading  = interaction.fields.getTextInputValue('intro_trading');
        const why      = interaction.fields.getTextInputValue('intro_why');
        const commit   = interaction.fields.getTextInputValue('intro_commit');

        const welcomeChannel = interaction.guild.channels.cache.get(WELCOME_CHANNEL_ID);
        if (welcomeChannel) {
          const introPost = ROOM_MODE ? roomCopy.introPost(member.id, { name, location, trading, why, commit }) :
            `🆕 **NEW MEMBER**\n\n` +
            `<@${member.id}> just joined EVOLVE.\n\n` +
            `📛 **Name:** ${name}\n` +
            `📍 **Location:** ${location}\n` +
            `📊 **Trading:** ${trading}\n` +
            `🎯 **Why I'm here:** ${why}\n` +
            `🤝 **Commitment:** ${commit}\n\n` +
            `Welcome to EVOLVE.`;
          await welcomeChannel.send(introPost);
        }

        // Role transition: ACCOUNTABILITY_SET → PROSPECT
        await member.roles.remove(ROOM_MODE ? PENDING_ROLE_ID : ACCOUNTABILITY_SET_ROLE_ID).catch(e => console.error('Remove onboarding role error:', e));
        if (PROSPECT_ROLE_ID) {
          await member.roles.add(PROSPECT_ROLE_ID).catch(e => console.error('Add PROSPECT_ROLE error:', e));
        }

        // Mark onboarding complete — this is the ONLY place onboardingState = 'COMPLETE' is set
        const data = loadPoints();
        if (!data[member.id]) {
          data[member.id] = { allTime: 0, weekly: 0, daily: 0, lastPost: {}, onboardingState: 'COMPLETE' };
        } else {
          data[member.id].onboardingState = 'COMPLETE';
        }
        savePoints(data);

        // Chopping Block: grant first-week grace. Sets exemptUntil to the next
        // Monday strictly after today so the eval at that Monday skips this
        // member; first real evaluation is the Monday AFTER that. No-op when
        // chopping-block is unconfigured on this environment.
        choppingBlock.markExemptFromOnboardingComplete(member.id);

        // Post completion first, then delete prior ephemeral (M2 — the step 3/4/5 embed)
        const priorInteraction = userEphemerals.get(member.id);

        await interaction.reply({
          content: ROOM_MODE ? roomCopy.complete() :
            '✅ **Discipline enrolled. Onboarding complete.**\n\n' +
            'You are now a Prospect of EVOLVE. The Eye is tracking you from this moment.\n\n' +
            'Your first move: build your habit system with `/habit add` — at least 4 🧬 Evolution + 1 📈 Trading habit, each on the days you do it. ' +
            'Then `/checkin` every time you knock one out (+1, +1 more with photo proof).\n\n' +
            'Welcome to EVOLVE.',
          flags: 64,
        });

        if (priorInteraction) {
          try { await priorInteraction.deleteReply(); } catch (_) {}
          userEphemerals.delete(member.id);
        }

        const displayName = member.nickname || member.user.username;
        await adminLog(LOG_MEMBERS_ID, new EmbedBuilder()
          .setTitle('✅ Onboarding Complete — Intro Modal')
          .addFields(
            { name: 'Member',   value: displayName,  inline: true },
            { name: 'Step',     value: ROOM_MODE ? `${roomCopy.STEPS} of ${roomCopy.STEPS}` : '5 of 5', inline: true },
            { name: 'Name',     value: name,         inline: true },
            { name: 'Location', value: location,     inline: true },
          )
          .setColor(0x57F287).setTimestamp()
        );
      } catch (e) { console.error('Error handling intro modal submit:', e); }
    }

    if (interaction.customId === 'setevents_modal') {
      try {
        if (!interaction.member.permissions.has('ManageGuild')) {
          return interaction.reply({ content: '⛔ Permission denied.', flags: 64 });
        }

        // Parse pipe-delimited event lines
        const events = [];
        for (let n = 1; n <= 5; n++) {
          const raw = interaction.fields.getTextInputValue(`event_${n}`).trim();
          if (!raw) continue;
          const parts = raw.split('|').map(p => p.trim());
          if (parts.length < 3 || !parts[0]) continue;
          events.push({ name: parts[0], time: parts[1] || '', days: parts[2] || '' });
        }

        // Persist to volume
        const scheduleData = {
          events,
          updated_at: new Date().toISOString(),
          updated_by: interaction.user.id,
        };
        saveEventsSchedule(scheduleData);

        // Find pinned events embed and edit in-place
        const eventsChannel = interaction.guild.channels.cache.get(EVENTS_CHANNEL_ID);
        let editedMsgId = null;
        if (eventsChannel) {
          try {
            const pins = await eventsChannel.messages.fetchPinned();
            const pinned = pins.find(m =>
              m.author.id === client.user.id &&
              m.embeds.length > 0 &&
              m.embeds[0].title?.includes('#EVENTS')
            );
            const newEmbed = buildEventsEmbed();
            if (pinned) {
              await pinned.edit({ embeds: [newEmbed] });
              editedMsgId = pinned.id;
            } else {
              // No pinned embed found — post a new one
              const msg = await eventsChannel.send({ embeds: [newEmbed] });
              await msg.pin().catch(() => {});
              editedMsgId = msg.id;
            }
          } catch (e) { console.error('Error updating events embed:', e); }
        }

        // Also update the Daily Itinerary embed in #world-clock
        await updateDailyItineraryEmbed(interaction.guild).catch(e =>
          console.error('[setevents] Error updating daily itinerary embed:', e)
        );

        await interaction.reply({
          content: `✅ Events schedule updated. ${events.length} event${events.length !== 1 ? 's' : ''} scheduled.`,
          flags: 64,
        });

        console.log(`[setevents] Schedule updated by ${interaction.user.tag}: ${events.length} events, msgId=${editedMsgId}`);
      } catch (e) { console.error('Error handling setevents modal submit:', e); }
    }

  }
});

// ─── All-time leaderboard (also used for pinned message) ──────────────────────
const LEADERBOARD_MSG_FILE = path.join(config.dataDir, 'leaderboard_msg.json');

function loadLeaderboardMsgId() {
  try {
    if (fs.existsSync(LEADERBOARD_MSG_FILE)) return JSON.parse(fs.readFileSync(LEADERBOARD_MSG_FILE, 'utf8')).msgId || null;
  } catch (e) {}
  return null;
}

function saveLeaderboardMsgId(msgId) {
  try { fs.writeFileSync(LEADERBOARD_MSG_FILE, JSON.stringify({ msgId })); }
  catch (e) { console.error('Error saving leaderboard msg ID:', e); }
}

async function postAllTimeLeaderboard(guild, client, interaction = null) {
  try {
    const channel = client.channels.cache.get(LEADERBOARD_CHANNEL_ID);
    if (!channel) return;

    const data   = loadPoints();
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, allTime: d.allTime, weekly: d.weekly, inactive: d.inactive }))
      .filter(d => d.allTime > 0 && !d.inactive && !IGNORED_USER_IDS.includes(d.id))
      .sort((a, b) => b.allTime - a.allTime)
      .slice(0, 15);

    const medals = ['🥇', '🥈', '🥉'];
    let description;
    if (!sorted.length) {
      // Empty-state placeholder — board ALWAYS renders, never freezes on
      // stale content. Mirrors the daily/weekly board contract.
      description = '*No points yet. Lock in.*';
    } else {
      const lines = await Promise.all(sorted.map(async (entry, i) => {
        const member = await guild.members.fetch(entry.id).catch(() => null);
        const name   = member?.nickname || member?.user?.username || 'Unknown';
        const tier   = [...ROLE_TIERS].reverse().find(t => entry.allTime >= t.minPoints)?.name || 'Prospect';
        const medal  = medals[i] || `${i + 1}.`;
        return `${medal} **${name}** — ${entry.allTime} pts • ${tier}`;
      }));
      description = lines.join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle('🏆 All-Time Leaderboard')
      .setDescription(description)
      .setColor(NETWORK_ACCENT)
      .setFooter({ text: 'Updated automatically. Earn points through the discipline system.' })
      .setTimestamp();

    // Try to edit the saved message ID first
    const savedMsgId = loadLeaderboardMsgId();
    if (savedMsgId) {
      const existing = await channel.messages.fetch(savedMsgId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        if (interaction) await interaction.editReply({ content: sorted.length ? 'Leaderboard updated.' : 'No points yet — board now shows placeholder.' });
        return;
      }
    }

    // No saved message — post fresh and pin it
    const msg = await channel.send({ embeds: [embed] });
    await msg.pin().catch(() => {});
    await deletePinSystemMessage(channel);
    saveLeaderboardMsgId(msg.id);

    if (interaction) await interaction.editReply({ content: sorted.length ? 'Leaderboard posted and pinned.' : 'No points yet — placeholder board posted and pinned.' });
  } catch (e) { console.error('Error posting all-time leaderboard:', e); }
}

// ─── Voting system ────────────────────────────────────────────────────────────

async function createVote(interaction) {
  const type     = interaction.options.getString('type');
  const question = interaction.options.getString('question');
  const hours    = parseInt(interaction.options.getString('duration'));
  const channel  = interaction.guild.channels.cache.get(VOTE_CHANNEL_ID);

  if (!channel) {
    return interaction.reply({ content: '⚠️ Vote channel not found.', flags: 64 });
  }

  const closeAt   = Date.now() + hours * 3_600_000;
  const closeTime = Math.floor(closeAt / 1000);

  let options = [];
  let voteMsg;

  // ── Yes / No ──────────────────────────────────────────────────────────────
  if (type === 'yesno') {
    options = ['Yes', 'No'];
    const embed = buildVoteEmbed(question, options, {}, closeTime, type);
    const row = buildVoteButtons(options, 'yesno');
    voteMsg = await channel.send({ content: '@everyone', embeds: [embed], components: [row] });

  // ── Multiple Choice ───────────────────────────────────────────────────────
  } else if (type === 'multiple') {
    const raw = [1, 2, 3, 4]
      .map(n => interaction.options.getString(`option${n}`))
      .filter(Boolean);
    if (raw.length < 2) {
      return interaction.reply({ content: '⚠️ Multiple choice requires at least 2 options.', flags: 64 });
    }
    options = raw;
    const embed = buildVoteEmbed(question, options, {}, closeTime, type);
    const row = buildVoteButtons(options, 'multiple');
    voteMsg = await channel.send({ content: '@everyone', embeds: [embed], components: [row] });

  // ── Nomination ────────────────────────────────────────────────────────────
  } else if (type === 'nomination') {
    const nominees = [1, 2, 3, 4, 5]
      .map(n => interaction.options.getUser(`nominee${n}`))
      .filter(Boolean);
    if (nominees.length < 2) {
      return interaction.reply({ content: '⚠️ Nomination requires at least 2 nominees.', flags: 64 });
    }

    // Fetch all guild members then resolve by ID
    await interaction.guild.members.fetch();
    const nomineeNames = nominees.map(u => {
      const m = interaction.guild.members.cache.get(u.id);
      return { id: u.id, name: m?.nickname || u.username };
    });

    options = nomineeNames.map(n => n.name);
    const nomineeIds = nomineeNames.map(n => n.id);
    const embed = buildNominationEmbed(question, options, new Array(options.length).fill(0), closeTime);
    const row = buildVoteButtons(options, 'nomination');
    voteMsg = await channel.send({ content: '@everyone', embeds: [embed], components: [row] });

    // Store nominee IDs for points awarding
    activeVotes.set(voteMsg.id, {
      type, question, options,
      votes: {},           // userId -> optionIndex (anonymous — no names stored)
      tallies: new Array(options.length).fill(0),
      closeAt, channelId: channel.id,
      nomineeIds: nomineeIds || [],
    });

    await interaction.reply({ content: `Vote posted in <#${channel.id}>!`, flags: 64 });
    setTimeout(() => closeVote(voteMsg.id, interaction.guild), hours * 3_600_000);
    return;
  }

  activeVotes.set(voteMsg.id, {
    type, question, options,
    votes: {},
    tallies: new Array(options.length).fill(0),
    closeAt, channelId: channel.id,
    nomineeIds: [],
  });

  await interaction.reply({ content: `Vote posted in <#${channel.id}>!`, flags: 64 });
  setTimeout(() => closeVote(voteMsg.id, interaction.guild), hours * 3_600_000);
}

function buildVoteEmbed(question, options, tallies, closeTime, type) {
  const typeLabel = type === 'yesno' ? 'Yes / No' : type === 'multiple' ? 'Multiple Choice' : 'Nomination';
  const optionLines = options.map((opt, i) => {
    const count = typeof tallies === 'object' && !Array.isArray(tallies)
      ? (tallies[i] || 0)
      : (tallies[i] || 0);
    return `**${opt}** — ${count} vote${count !== 1 ? 's' : ''}`;
  }).join('\n');

  return new EmbedBuilder()
    .setTitle(`📊 ${question}`)
    .setDescription(`${optionLines}\n\n*Votes are anonymous. Closes <t:${closeTime}:R>*`)
    .addFields({ name: 'Type', value: typeLabel, inline: true })
    .setColor(0x5865F2)
    .setFooter({ text: 'EVOLVE — Voting System' })
    .setTimestamp();
}

function buildVoteButtons(options, type) {
  const styles = [
    ButtonStyle.Primary,    // Blue
    ButtonStyle.Success,    // Green
    ButtonStyle.Danger,     // Red
    ButtonStyle.Secondary,  // Grey
    ButtonStyle.Success,    // Green
  ];
  const row = new ActionRowBuilder();
  options.slice(0, 5).forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`vote_option:${i}`)
        .setLabel(opt.length > 80 ? opt.slice(0, 77) + '...' : opt)
        .setStyle(styles[i] || ButtonStyle.Secondary)
    );
  });
  return row;
}

function buildNominationEmbed(question, options, tallies, closeTime) {
  const optionLines = options.map((opt, i) => {
    const count = tallies[i] || 0;
    return `**${opt}** — ${count} vote${count !== 1 ? 's' : ''}`;
  }).join('\n');

  return new EmbedBuilder()
    .setTitle(`🏆 Nomination Vote — ${question}`)
    .setDescription(
      `${optionLines}\n\n` +
      `🪙 *Winner receives **+10 points***\n` +
      `*Votes are anonymous. Closes <t:${closeTime}:R>*`
    )
    .addFields({ name: 'Type', value: 'Nomination', inline: true })
    .setColor(0xFFD700)
    .setFooter({ text: 'EVOLVE — Voting System' })
    .setTimestamp();
}

async function handleVoteButton(interaction) {
  if (!interaction.customId.startsWith('vote_option:')) return false;

  const optionIndex = parseInt(interaction.customId.split(':')[1]);
  const messageId   = interaction.message.id;
  const vote        = activeVotes.get(messageId);

  if (!vote) {
    await interaction.reply({ content: 'This vote has already closed.', flags: 64 });
    return true;
  }

  const userId = interaction.user.id;

  // Check if already voted
  if (vote.votes[userId] !== undefined) {
    // Allow changing vote
    const oldIndex = vote.votes[userId];
    vote.tallies[oldIndex] = Math.max(0, vote.tallies[oldIndex] - 1);
  } else {
    // First time voting — award points (skip ignored users e.g. test bots)
    if (!IGNORED_USER_IDS.includes(userId)) {
      const member = interaction.guild.members.cache.get(userId)
        ?? await interaction.guild.members.fetch(userId).catch(() => null);
      const updated = addPoints(userId, POINTS.VOTE_CAST);
      if (member) await updateMemberRole(member, updated.allTime);

      await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
        .setTitle('🪙 Points Awarded — Vote Cast')
        .addFields(
          { name: 'Member',   value: member?.nickname || interaction.user.username, inline: true },
          { name: 'Amount',   value: `+${POINTS.VOTE_CAST} pts`, inline: true },
          { name: 'All-Time', value: `${updated.allTime} pts`,   inline: true },
        )
        .setColor(0x57F287).setTimestamp()
      );
    }
  }

  vote.votes[userId] = optionIndex;
  vote.tallies[optionIndex]++;

  // Update embed with new tallies
  const closeTime = Math.floor(vote.closeAt / 1000);
  const updatedEmbed = vote.type === 'nomination'
    ? buildNominationEmbed(vote.question, vote.options, vote.tallies, closeTime)
    : buildVoteEmbed(vote.question, vote.options, vote.tallies, closeTime, vote.type);
  const row = buildVoteButtons(vote.options, vote.type);
  await interaction.update({ embeds: [updatedEmbed], components: [row] });
  return true;
}

async function closeVote(messageId, guild) {
  const vote = activeVotes.get(messageId);
  if (!vote) return;
  activeVotes.delete(messageId);

  const channel = guild.channels.cache.get(vote.channelId);
  if (!channel) return;

  const message = await channel.messages.fetch(messageId).catch(() => null);

  // Find winning option(s)
  const maxVotes  = Math.max(...vote.tallies);
  const winnerIdx = vote.tallies.indexOf(maxVotes);
  const winnerLabel = vote.options[winnerIdx];
  const tied = vote.tallies.filter(t => t === maxVotes).length > 1;

  // Award nomination win points (skip ignored users e.g. test bots)
  if (vote.type === 'nomination' && !tied && vote.nomineeIds?.[winnerIdx]) {
    const winnerId = vote.nomineeIds[winnerIdx];
    if (!IGNORED_USER_IDS.includes(winnerId)) {
      const winnerMember = guild.members.cache.get(winnerId)
        ?? await guild.members.fetch(winnerId).catch(() => null);
      if (winnerMember) {
        const updated = addPoints(winnerId, POINTS.NOMINATION_WIN);
        await updateMemberRole(winnerMember, updated.allTime);
        await adminLog(LOG_POINTS_AUDIT_ID, new EmbedBuilder()
          .setTitle('🪙 Points Awarded — Nomination Win')
          .addFields(
            { name: 'Member',   value: winnerMember.nickname || winnerMember.user.username, inline: true },
            { name: 'Amount',   value: `+${POINTS.NOMINATION_WIN} pts`, inline: true },
            { name: 'All-Time', value: `${updated.allTime} pts`,        inline: true },
          )
          .setColor(0xFFD700).setTimestamp()
        );
      }
    }
  }

  // Build results embed
  const resultLines = vote.options.map((opt, i) => {
    const isWinner = !tied && i === winnerIdx;
    return `${isWinner ? '🏆 ' : ''}**${opt}** — ${vote.tallies[i]} vote${vote.tallies[i] !== 1 ? 's' : ''}${isWinner ? ' ← Winner' : ''}`;
  }).join('\n');

  const resultEmbed = new EmbedBuilder()
    .setTitle(`📊 Vote Closed — ${vote.question}`)
    .setDescription(
      `${resultLines}\n\n` +
      (tied ? '*Result: Tied*' : `*Winner: **${winnerLabel}***`)
    )
    .setColor(tied ? 0x99AAB5 : 0x57F287)
    .setFooter({ text: 'EVOLVE — Voting System' })
    .setTimestamp();

  // Disable buttons
  const disabledRow = new ActionRowBuilder();
  vote.options.slice(0, 5).forEach((opt, i) => {
    disabledRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`vote_closed_${i}`)
        .setLabel(`${opt} (${vote.tallies[i]})`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
  });

  if (message) await message.edit({ embeds: [resultEmbed], components: [disabledRow] }).catch(() => {});
  await channel.send({ content: '@everyone', embeds: [resultEmbed] });
}

// ─── Points backup ────────────────────────────────────────────────────────────
async function backupPoints(guild, client) {
  try {
    const channel = client.channels.cache.get(LOG_ACCOUNTABILITY_ID);
    if (!channel) return;

    const data = loadPoints();
    const json = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(json, 'utf8');
    const now = new Date().toISOString().split('T')[0];

    await channel.send({
      content: `📦 Automatic points backup — ${now}`,
      files: [{ attachment: buffer, name: `points-backup-${now}.json` }]
    });
    console.log('Points backup posted to accountability log.');
  } catch (e) { console.error('Error backing up points:', e); }
}

// ─── Inactivity check ─────────────────────────────────────────────────────────
async function checkInactivity(guild) {
  try {
    const lastSeen = loadLastSeen();
    const now = Date.now();
    const threshold = INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    const members = await guild.members.fetch();
    const reported = [];

    for (const [id, member] of members) {
      if (member.user.bot) continue;
      // Only check members who have Prospect role or above (completed onboarding)
      const hasRole = ROLE_TIERS.some(t => t.roleId && member.roles.cache.has(t.roleId));
      if (!hasRole) continue;

      const last = lastSeen[id];
      if (!last) continue; // Never seen — skip

      const daysSince = Math.floor((now - last) / (24 * 60 * 60 * 1000));
      if (daysSince >= INACTIVITY_THRESHOLD_DAYS) {
        const name = member.nickname || member.user.username;
        reported.push({ name, daysSince, id });
      }
    }

    if (!reported.length) return;

    const lines = reported
      .sort((a, b) => b.daysSince - a.daysSince)
      .map(m => `• **${m.name}** — inactive for **${m.daysSince} days**`)
      .join('\n');

    await adminLog(LOG_INACTIVITY_ID, new EmbedBuilder()
      .setTitle(`⚠️ Inactivity Report — ${reported.length} member${reported.length !== 1 ? 's' : ''}`)
      .setDescription(lines)
      .setColor(0xFFD700)
      .setFooter({ text: `Threshold: ${INACTIVITY_THRESHOLD_DAYS} days` })
      .setTimestamp()
    );

    console.log(`Inactivity report: ${reported.length} members flagged.`);
  } catch (e) { console.error('Error checking inactivity:', e); }
}

// ─── Admin HTTP API ───────────────────────────────────────────────────────────
// Express runs alongside the Discord client. /health is unauthenticated (Railway
// probe friendly). All /admin/* routes require Bearer token auth.
{
  const app         = express();
  const ADMIN_TOKEN = config.tokens.admin;
  const PORT        = config.port;

  app.use(express.json({ limit: '2mb' }));

  // Public health probe — no auth required
  app.get('/health', (req, res) => res.json({
    ok:     true,
    bot:    client.user?.tag || 'starting',
    uptime: Math.floor(process.uptime()),
    ready:  client.isReady(),
  }));

  // Authenticated admin routes
  app.use('/admin', createAdminRouter(client, {
    GUILD_ID,
    ADMIN_TOKEN,
    dataDir: config.dataDir,
    // Member-facing channels (8 protected from deletion + others used by handlers)
    WELCOME_CHANNEL_ID,
    RULES_CHANNEL_ID,
    EVENTS_CHANNEL_ID,
    WAR_ROOM_ID,
    ANNOUNCEMENTS_CHANNEL_ID,
    WORLD_CLOCK_CHANNEL_ID,
    ACCOUNTABILITY_CHANNEL_ID,
    LEADERBOARD_CHANNEL_ID,
    VOTE_CHANNEL_ID,
    // Admin/log channels (skipped by apply-lockdown + apply-voice-permissions)
    LOG_COMMANDS_ID,
    LOG_MEMBERS_ID,
    LOG_INACTIVITY_ID,
    LOG_ACCOUNTABILITY_ID,
    LOG_ROLES_ID,
    LOG_POINTS_AUDIT_ID,
    LOG_DELETED_MESSAGES_ID,
    // Chopping Block — special case in apply-lockdown (read-only for tier roles)
    CHOPPING_BLOCK_CHANNEL_ID: choppingBlock.CHOPPING_BLOCK_CHANNEL_ID,
    // Roles
    PENDING_ROLE_ID,
    PROSPECT_ROLE_ID,
    MEMBER_ROLE_ID,
    VETERAN_ROLE_ID,
    ELITE_ROLE_ID,
    TOP_ROLE_ID,
    AGREED_ROLE_ID,
    TIMEZONE_SET_ROLE_ID,
    ACCOUNTABILITY_SET_ROLE_ID,
    // Test-only hooks for the staging-gated simulate-midnight-tick endpoint.
    // The endpoint itself enforces STAGING_TEST_TRIGGERS_ENABLED=1; these
    // references are inert on live (env unset → endpoint returns 403).
    runMidnightTasks,
    schedulerHooks: {
      resetDailyPoints,
      resetWeeklyPoints,
      updateMemberRole,
      postAllTimeLeaderboard,
      choppingBlockEvaluate: runChoppingBlockEval,
    },
    choppingBlockEnsureListEmbeds: choppingBlock.ensureListEmbeds,
    fireEventsReminder,
    runScheduledReminders,
  }));

  // POST /admin/trigger/standings — refresh the daily + weekly boards now.
  // The boards are silent edit-in-place in #leaderboard; this just forces a
  // refresh (no @everyone, no awards — those fire only on the midnight tick).
  app.post('/admin/trigger/standings', async (req, res) => {
    const auth = req.headers['authorization'] || '';
    if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const g = client.guilds.cache.get(GUILD_ID);
    if (!g) return res.status(503).json({ error: 'Guild not cached' });
    try {
      await postWeeklyBoard(g, client);
      await postDailyBoard(g, client);
      res.json({ ok: true, message: 'Daily + weekly boards refreshed.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /admin/trigger/weekly — manual weekly closeout (board + top-3 awards
  // + winners ping + warning DMs). Does NOT reset weekly points (matches the
  // pre-Phase-6 behavior of this endpoint).
  app.post('/admin/trigger/weekly', async (req, res) => {
    const auth = req.headers['authorization'] || '';
    if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const g = client.guilds.cache.get(GUILD_ID);
    if (!g) return res.status(503).json({ error: 'Guild not cached' });
    try {
      await postWeeklyBoard(g, client);
      const { winnerLines } = await awardWeeklyTop3Bonuses(g, client, updateMemberRole);
      if (winnerLines.length) await postWeeklyWinnersPing(client, winnerLines);
      res.json({ ok: true, message: 'Weekly closeout fired (no reset).' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Schedule builder (lab) — member-facing calendar, auth via signed per-member link
  app.use('/schedule', require('./lib/schedule-web')(habits));

  // 404 catch-all
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(PORT, () => console.log(`Admin API listening on port ${PORT}`));
}

// ─── Crash guards ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException',  error => console.error('Uncaught exception:',  error));

client.login(TOKEN);
