'use strict';
/**
 * test/tracker-issues.test.js — unit tests for lib/tracker-issues.js pure logic.
 * No network, no Discord. Run: node test/tracker-issues.test.js
 */
process.env.DATA_DIR = require('os').tmpdir();
// satisfy config required vars with dummies when run standalone
const REQ = ['TOKEN','EYE_ADMIN_TOKEN','CLIENT_ID','GUILD_ID','WELCOME_CHANNEL_ID','RULES_CHANNEL_ID','EVENTS_CHANNEL_ID','ANNOUNCEMENTS_CHANNEL_ID','WORLD_CLOCK_CHANNEL_ID','ACCOUNTABILITY_CHANNEL_ID','LEADERBOARD_CHANNEL_ID','VOTE_CHANNEL_ID','DAILY_WEEKLY_REVIEW_CHANNEL_ID','TRADE_LOG_CHANNEL_ID','TRAINING_LOG_CHANNEL_ID','DIET_LOG_CHANNEL_ID','WAR_ROOM_ID','LOG_COMMANDS_ID','LOG_MEMBERS_ID','LOG_INACTIVITY_ID','LOG_ACCOUNTABILITY_ID','LOG_ROLES_ID','LOG_POINTS_AUDIT_ID','LOG_DELETED_MESSAGES_ID','PENDING_ROLE_ID','AGREED_ROLE_ID','TIMEZONE_SET_ROLE_ID','ACCOUNTABILITY_SET_ROLE_ID','PROSPECT_ROLE_ID','MEMBER_ROLE_ID','VETERAN_ROLE_ID','ELITE_ROLE_ID','TOP_ROLE_ID'];
for (const k of REQ) if (!process.env[k]) process.env[k] = 'x';

const ti = require('../lib/tracker-issues');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; }
  else { fail++; console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}

// classifyTracker
eq(ti.classifyTracker('CSV import fails on my tradezella export'), 'Trade', 'classify trade');
eq(ti.classifyTracker('the rest timer in my workout dies when I add sets'), 'Workout', 'classify workout');
eq(ti.classifyTracker('macros reset to zero after I log food'), 'Diet', 'classify diet');
eq(ti.classifyTracker('the app is broken lol'), 'Unknown', 'classify unknown');
eq(ti.classifyTracker('diet tracker: workout calories wrong'), 'Diet', 'explicit "diet tracker" wins ties');
eq(ti.classifyTracker('Workout tracker shows my meals??'), 'Workout', 'explicit "workout tracker" wins ties');

// parseMessageRef
eq(ti.parseMessageRef('https://discord.com/channels/111/222/333'), { guildId: '111', channelId: '222', messageId: '333' }, 'parse link');
eq(ti.parseMessageRef('garbage'), null, 'parse garbage');

// statusLine
eq(ti.statusLine({ status: 'Fixed', fixVersion: 'v34' }).includes('v34'), true, 'fixed line has version');
eq(ti.statusLine({ status: 'Rejected', triageNote: 'user error' }).includes('user error'), true, 'rejected line has note');
eq(ti.statusLine({ status: 'Reported' }), null, 'reported not announced');
eq(typeof ti.statusLine({ status: 'Awaiting Re-test' }), 'string', 'awaiting-retest has a line');
eq(ti.statusLine({ status: 'Awaiting Re-test' }).toLowerCase().includes('re-open') || ti.statusLine({ status: 'Awaiting Re-test' }).toLowerCase().includes('reopen'), true, 'awaiting-retest line mentions reopen');
eq(typeof ti.statusLine({ status: 'Closed' }), 'string', 'closed has a line');
eq(ti.statusLine({ status: 'Closed' }).toLowerCase().includes('re-open') || ti.statusLine({ status: 'Closed' }).toLowerCase().includes('reopen'), true, 'closed line mentions reopen');

// ANNOUNCE_STATUSES includes new lifecycle statuses
eq(ti.ANNOUNCE_STATUSES.includes('Awaiting Re-test'), true, 'Awaiting Re-test in ANNOUNCE_STATUSES');
eq(ti.ANNOUNCE_STATUSES.includes('Closed'), true, 'Closed in ANNOUNCE_STATUSES');

// computeStatusAnnouncements
{
  const rows = [
    { pageId: 'a', status: 'Valid — Queued' },
    { pageId: 'b', status: 'Reported' },
    { pageId: 'c', status: 'Fixed' },
  ];
  const r1 = ti.computeStatusAnnouncements(rows, {});
  eq(r1.toAnnounce.map(r => r.pageId), ['a', 'c'], 'announce new transitions');
  eq(r1.nextAnnounced, { a: 'Valid — Queued', c: 'Fixed' }, 'state captures announced');

  const r2 = ti.computeStatusAnnouncements(rows, r1.nextAnnounced);
  eq(r2.toAnnounce.length, 0, 'no re-announce same status');

  const r3 = ti.computeStatusAnnouncements([{ pageId: 'a', status: 'Fixed' }], r1.nextAnnounced);
  eq(r3.toAnnounce.map(r => r.pageId), ['a'], 'announce progression');
  eq(r3.nextAnnounced.a, 'Fixed', 'state advances');
}

// computeStatusAnnouncements — new lifecycle statuses
{
  const rows = [
    { pageId: 'd', status: 'Awaiting Re-test' },
    { pageId: 'e', status: 'Closed' },
  ];
  const r = ti.computeStatusAnnouncements(rows, {});
  eq(r.toAnnounce.map(x => x.pageId).sort(), ['d', 'e'], 'Awaiting Re-test + Closed are announced');
  eq(r.nextAnnounced['d'], 'Awaiting Re-test', 'Awaiting Re-test state recorded');
  eq(r.nextAnnounced['e'], 'Closed', 'Closed state recorded');
}

// computeAutoCloseList — pure auto-close logic with injected clock
{
  const nowMs = 1000000000000; // arbitrary fixed timestamp
  const FOUR_DAYS_MS = ti.AUTO_CLOSE_DAYS * 24 * 60 * 60 * 1000;

  const rows = [
    { pageId: 'x', status: 'Awaiting Re-test', link: 'https://discord.com/channels/1/2/100' },
    { pageId: 'y', status: 'Awaiting Re-test', link: 'https://discord.com/channels/1/2/101' },
    { pageId: 'z', status: 'Awaiting Re-test', link: 'https://discord.com/channels/1/2/102' },
  ];

  // x: over 4 days old → should close
  // y: exactly 4 days (boundary) → should close
  // z: 3 days 23h → should NOT close
  const since = {
    'x': nowMs - (FOUR_DAYS_MS + 1000),
    'y': nowMs - FOUR_DAYS_MS,
    'z': nowMs - (FOUR_DAYS_MS - 3600000),
  };

  const toClose = ti.computeAutoCloseList(rows, since, nowMs);
  eq(toClose.map(r => r.pageId).sort(), ['x', 'y'], 'auto-close 4+ day tickets only');
}
{
  // No awaitingRetestSince entry → never close
  const rows = [{ pageId: 'q', status: 'Awaiting Re-test', link: '' }];
  const toClose = ti.computeAutoCloseList(rows, {}, Date.now() + 999999999);
  eq(toClose.length, 0, 'missing since entry → not closed');
}

// isConfigured false with dummies (no NOTION real token? token='x' is set... gate on channel)
// trackerIssues channel unset in this env → not configured
eq(ti.isConfigured(), false, 'dormant without TRACKER_BUGS_CHANNEL_ID/TRACKER_ISSUES_DB_ID');

// overReportLimit — 5/user/hour rolling
{
  const base = 1000000;
  for (let i = 0; i < 5; i++) eq(ti.overReportLimit('u1', base + i * 1000), false, 'report ' + (i + 1) + ' allowed');
  eq(ti.overReportLimit('u1', base + 6000), true, '6th report blocked');
  eq(ti.overReportLimit('u2', base), false, 'other user unaffected');
  eq(ti.overReportLimit('u1', base + 3601e3 + 5000), false, 'budget resets after an hour');
}

console.log(`tracker-issues tests: ${pass} passed, ${fail} failed`);
if (fail) console.error(`\nFAILED TESTS: ${fail}`);
process.exit(fail ? 1 : 0);
