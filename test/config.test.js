'use strict';
/**
 * test/config.test.js
 * Standalone Node test for lib/config.js — no Discord connection, no guild access.
 *
 * Verifies:
 *   1. With all required env vars set to dummy values, config loads cleanly
 *      and exposes the expected shape.
 *   2. With one required var unset, requiring config.js throws an error that
 *      names the missing var.
 *
 * Usage: node test/config.test.js
 * Exit 0 = both cases pass. Exit 1 = something is wrong.
 */

const path = require('path');
const assert = require('assert');

const CONFIG_PATH = require.resolve('../lib/config.js');

// Full list mirrors REQUIRED_VARS in lib/config.js. Kept here to make the test
// independent — if config.js changes its required list, the test should fail.
const REQUIRED = [
  'TOKEN', 'EYE_ADMIN_TOKEN',
  'CLIENT_ID', 'GUILD_ID',
  'WELCOME_CHANNEL_ID', 'RULES_CHANNEL_ID', 'EVENTS_CHANNEL_ID',
  'ANNOUNCEMENTS_CHANNEL_ID', 'WORLD_CLOCK_CHANNEL_ID',
  'ACCOUNTABILITY_CHANNEL_ID', 'LEADERBOARD_CHANNEL_ID', 'VOTE_CHANNEL_ID',
  'DAILY_WEEKLY_REVIEW_CHANNEL_ID', 'TRADE_LOG_CHANNEL_ID',
  'TRAINING_LOG_CHANNEL_ID', 'DIET_LOG_CHANNEL_ID', 'WAR_ROOM_ID',
  'LOG_COMMANDS_ID', 'LOG_MEMBERS_ID', 'LOG_INACTIVITY_ID',
  'LOG_ACCOUNTABILITY_ID', 'LOG_ROLES_ID', 'LOG_POINTS_AUDIT_ID',
  'LOG_DELETED_MESSAGES_ID',
  'PENDING_ROLE_ID', 'AGREED_ROLE_ID', 'TIMEZONE_SET_ROLE_ID',
  'ACCOUNTABILITY_SET_ROLE_ID',
  'PROSPECT_ROLE_ID', 'MEMBER_ROLE_ID', 'VETERAN_ROLE_ID',
  'ELITE_ROLE_ID', 'TOP_ROLE_ID',
];

// Optional vars — set/unset to exercise both defaulting and parsing.
const OPTIONAL = ['IGNORED_USER_IDS', 'NOTION_TOKEN', 'PORT', 'DATA_DIR'];

function setAllDummies() {
  for (const name of REQUIRED) {
    if (name === 'TOKEN' || name === 'EYE_ADMIN_TOKEN') {
      process.env[name] = 'dummy-token-value';
    } else {
      process.env[name] = `dummy-${name}`;
    }
  }
  // Optional vars — leave unset; tests below set them as needed
  for (const name of OPTIONAL) delete process.env[name];
  process.env.PORT = '4242';
}

function clearAll() {
  for (const name of REQUIRED) delete process.env[name];
  for (const name of OPTIONAL) delete process.env[name];
}

function freshLoad() {
  delete require.cache[CONFIG_PATH];
  return require('../lib/config.js');
}

let passCount = 0;
let failCount = 0;

function check(label, fn) {
  try {
    fn();
    console.log('  ✅', label);
    passCount++;
  } catch (e) {
    console.log('  ❌', label, '—', e.message);
    failCount++;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Case 1: all required vars set → loads cleanly with expected shape
// ───────────────────────────────────────────────────────────────────────────
console.log('\n─── Case 1: all required vars set → clean load ──────────────────\n');
clearAll();
setAllDummies();
let cfg;
check('config loads without throwing', () => {
  cfg = freshLoad();
});

check('top-level keys present', () => {
  for (const k of ['dataDir', 'port', 'tokens', 'clientId', 'guildId',
                   'channels', 'logChannels', 'roles', 'ignoredUserIds']) {
    assert(k in cfg, `missing top-level key: ${k}`);
  }
});

check('dataDir defaults to /data when DATA_DIR unset', () => {
  assert.strictEqual(cfg.dataDir, '/data');
});

check('PORT parsed as number', () => {
  assert.strictEqual(cfg.port, 4242);
});

check('tokens.bot / tokens.admin populated; tokens.notion is null when unset', () => {
  assert.strictEqual(cfg.tokens.bot, 'dummy-token-value');
  assert.strictEqual(cfg.tokens.admin, 'dummy-token-value');
  assert.strictEqual(cfg.tokens.notion, null);
});

check('clientId and guildId populated from env', () => {
  assert.strictEqual(cfg.clientId, 'dummy-CLIENT_ID');
  assert.strictEqual(cfg.guildId, 'dummy-GUILD_ID');
});

check('all 13 channel keys present and non-empty', () => {
  const expected = ['welcome','rules','events','announcements','worldClock',
    'accountability','leaderboard','vote','dailyWeeklyReview','tradeLog',
    'trainingLog','dietLog','warRoom'];
  for (const k of expected) {
    assert(cfg.channels[k] && cfg.channels[k].length > 0, `channels.${k} empty`);
  }
  assert.strictEqual(Object.keys(cfg.channels).length, expected.length);
});

check('all 7 log-channel keys present and non-empty', () => {
  const expected = ['commands','members','inactivity','accountability',
    'roles','pointsAudit','deletedMessages'];
  for (const k of expected) {
    assert(cfg.logChannels[k] && cfg.logChannels[k].length > 0, `logChannels.${k} empty`);
  }
  assert.strictEqual(Object.keys(cfg.logChannels).length, expected.length);
});

check('all 9 role keys present and non-empty', () => {
  const expected = ['pending','agreed','timezoneSet','accountabilitySet',
    'prospect','member','veteran','elite','top'];
  for (const k of expected) {
    assert(cfg.roles[k] && cfg.roles[k].length > 0, `roles.${k} empty`);
  }
  assert.strictEqual(Object.keys(cfg.roles).length, expected.length);
});

check('ignoredUserIds defaults to [] when IGNORED_USER_IDS is unset', () => {
  assert(Array.isArray(cfg.ignoredUserIds));
  assert.strictEqual(cfg.ignoredUserIds.length, 0);
});

check('ignoredUserIds parsed from CSV into array when set', () => {
  clearAll();
  setAllDummies();
  process.env.IGNORED_USER_IDS = '111, 222 , 333';
  const cfg2 = freshLoad();
  assert.deepStrictEqual([...cfg2.ignoredUserIds], ['111', '222', '333']);
});

check('ignoredUserIds defaults to [] when IGNORED_USER_IDS is empty/whitespace', () => {
  clearAll();
  setAllDummies();
  process.env.IGNORED_USER_IDS = '   ';
  const cfg2 = freshLoad();
  assert.deepStrictEqual([...cfg2.ignoredUserIds], []);
});

check('exported config is frozen (immutable)', () => {
  assert.strictEqual(Object.isFrozen(cfg), true);
  assert.strictEqual(Object.isFrozen(cfg.channels), true);
  assert.strictEqual(Object.isFrozen(cfg.logChannels), true);
  assert.strictEqual(Object.isFrozen(cfg.roles), true);
  assert.strictEqual(Object.isFrozen(cfg.tokens), true);
});

// ───────────────────────────────────────────────────────────────────────────
// Case 2: one required var unset → throws naming the missing var
// ───────────────────────────────────────────────────────────────────────────
console.log('\n─── Case 2: missing required var → throws naming it ─────────────\n');

const MISSING_NAME = 'WELCOME_CHANNEL_ID';
clearAll();
setAllDummies();
delete process.env[MISSING_NAME];

check(`requiring config.js throws when ${MISSING_NAME} is unset`, () => {
  let threw = false;
  let errMsg = '';
  try {
    freshLoad();
  } catch (e) {
    threw = true;
    errMsg = e.message;
  }
  assert.strictEqual(threw, true, 'expected throw, got clean load');
  assert(errMsg.includes(MISSING_NAME),
    `error message did not name the missing var. Got: "${errMsg}"`);
});

check('error message also names multiple missing vars at once', () => {
  clearAll();
  setAllDummies();
  delete process.env.GUILD_ID;
  delete process.env.PROSPECT_ROLE_ID;
  let errMsg = '';
  try {
    freshLoad();
  } catch (e) {
    errMsg = e.message;
  }
  assert(errMsg.includes('GUILD_ID'), `missing GUILD_ID not named: "${errMsg}"`);
  assert(errMsg.includes('PROSPECT_ROLE_ID'), `missing PROSPECT_ROLE_ID not named: "${errMsg}"`);
});

check('empty-string is treated as missing', () => {
  clearAll();
  setAllDummies();
  process.env.CLIENT_ID = '   '; // whitespace only
  let errMsg = '';
  try {
    freshLoad();
  } catch (e) {
    errMsg = e.message;
  }
  assert(errMsg.includes('CLIENT_ID'),
    `whitespace-only CLIENT_ID should be treated as missing. Got: "${errMsg}"`);
});

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n─── Summary: ${passCount} passed, ${failCount} failed ─────────────────────────\n`);
process.exit(failCount === 0 ? 0 : 1);
