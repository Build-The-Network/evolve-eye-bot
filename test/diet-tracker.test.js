'use strict';
// test/diet-tracker.test.js — pure-logic tests for the lapse milestone engine.
// Run: node test/diet-tracker.test.js   (no Discord / network needed)

// Satisfy lib/config.js required vars with dummies before require.
const REQ = ['TOKEN','EYE_ADMIN_TOKEN','CLIENT_ID','GUILD_ID','WELCOME_CHANNEL_ID','RULES_CHANNEL_ID','EVENTS_CHANNEL_ID','ANNOUNCEMENTS_CHANNEL_ID','WORLD_CLOCK_CHANNEL_ID','ACCOUNTABILITY_CHANNEL_ID','LEADERBOARD_CHANNEL_ID','VOTE_CHANNEL_ID','DAILY_WEEKLY_REVIEW_CHANNEL_ID','TRADE_LOG_CHANNEL_ID','TRAINING_LOG_CHANNEL_ID','DIET_LOG_CHANNEL_ID','WAR_ROOM_ID','LOG_COMMANDS_ID','LOG_MEMBERS_ID','LOG_INACTIVITY_ID','LOG_ACCOUNTABILITY_ID','LOG_ROLES_ID','LOG_POINTS_AUDIT_ID','LOG_DELETED_MESSAGES_ID','PENDING_ROLE_ID','AGREED_ROLE_ID','TIMEZONE_SET_ROLE_ID','ACCOUNTABILITY_SET_ROLE_ID','PROSPECT_ROLE_ID','MEMBER_ROLE_ID','VETERAN_ROLE_ID','ELITE_ROLE_ID','TOP_ROLE_ID'];
for (const k of REQ) if (!process.env[k]) process.env[k] = 'test-dummy';
process.env.DATA_DIR = require('os').tmpdir();

const { computeAnnouncements, LAPSE_THRESHOLD_DAYS, REANNOUNCE_EVERY_DAYS } = require('../lib/diet-tracker');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('  ✗ FAIL:', n)); };
const m = (u, d) => ({ username: u, name: u, lastLogged: d == null ? null : 'x', daysSinceLastLog: d });

// 1. fresh lapse at threshold announces
let r = computeAnnouncements([m('a', 5)], {});
ok(r.lapses.length === 1 && r.nextAnnounced.a === 5, 'announces at threshold (5d)');
// 2. below threshold: silent, no state
r = computeAnnouncements([m('a', 4)], {});
ok(r.lapses.length === 0 && !('a' in r.nextAnnounced), 'silent below threshold');
// 3. already announced at 5 → no repeat at 6..9
r = computeAnnouncements([m('a', 7)], { a: 5 });
ok(r.lapses.length === 0 && r.nextAnnounced.a === 5, 'no daily spam between milestones');
// 4. re-announces at next milestone (10)
r = computeAnnouncements([m('a', 10)], { a: 5 });
ok(r.lapses.length === 1 && r.nextAnnounced.a === 10, 're-announces at +5d milestone');
// 5. recovered member drops out of state
r = computeAnnouncements([m('a', 0)], { a: 10 });
ok(r.lapses.length === 0 && !('a' in r.nextAnnounced), 'recovered member resets');
// 6. never-logged member (null) is skipped entirely
r = computeAnnouncements([m('a', null)], {});
ok(r.lapses.length === 0 && !('a' in r.nextAnnounced), 'never-logged skipped');
// 7. mixed roster
r = computeAnnouncements([m('a', 12), m('b', 3), m('c', 5), m('d', null), m('e', 6)], { a: 10, e: 5 });
ok(r.lapses.map(x => x.username).sort().join(',') === 'c'
  && r.nextAnnounced.a === 10 && r.nextAnnounced.c === 5 && r.nextAnnounced.e === 5
  && !('b' in r.nextAnnounced) && !('d' in r.nextAnnounced), 'mixed roster: only fresh milestone announces');
// 8. constants sane
ok(LAPSE_THRESHOLD_DAYS === 5 && REANNOUNCE_EVERY_DAYS === 5, 'constants match Streak System spec');

console.log(`diet-tracker tests: ${pass}/${pass + fail}${fail ? ' — FAILED' : ''}`);
process.exit(fail ? 1 : 0);
