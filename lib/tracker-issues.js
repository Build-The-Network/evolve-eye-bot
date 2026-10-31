'use strict';
/**
 * lib/tracker-issues.js — #tracker-bugs → Jarvis autonomous fix loop (intake side).
 *
 * Members post tracker bugs in #tracker-bugs. This module:
 *   1. INTAKE  — on each new message in the channel, files a row in the Notion
 *      "Tracker Issues — Member Reports" DB (Status=Reported), reacts ✅ /⚠️,
 *      and enqueues a `triage-chat` Command Queue row so Jarvis responds
 *      conversationally within ~20s (watcher) or ~5 min (cron fallback).
 *      Also fires on every reporter reply in the report's thread (whatever the
 *      ticket status). Reply on a Closed ticket → reopens to Reported.
 *   2. STATUS  — polls the Issues DB every POLL_MINUTES and replies in-thread
 *      when a report transitions through the lifecycle.
 *   3. AUTO-CLOSE — daily check: Awaiting Re-test with no reporter reply for
 *      AUTO_CLOSE_DAYS days → Closed + in-thread "reply to reopen" note.
 *
 * OPTIONAL feature: dormant unless NOTION_TOKEN + TRACKER_BUGS_CHANNEL_ID +
 * TRACKER_ISSUES_DB_ID are all set.
 *
 * 🔒 LOCKED-SPEC BOUNDARY: awards ZERO points, never touches points.json.
 */

const fs   = require('fs');
const path = require('path');
const config = require('./config');

const NOTION_VER       = '2022-06-28';
const FETCH_TIMEOUT_MS = 15000;
const POLL_MINUTES     = 5;
const AUTO_CLOSE_DAYS  = 4;
const MAX_TITLE        = 120;
const MAX_DETAIL       = 1800;

const STATE_FILE = path.join(config.dataDir, 'tracker_issue_status.json');

// ── Flood guard ───────────────────────────────────────────────────────────────
// Max new reports per user per rolling hour (top-level channel posts only).
// Thread replies are not flood-guarded — a reporter can always follow up.
const REPORTS_PER_HOUR = 5;
const _reportTimes = new Map();
function overReportLimit(userId, now) {
  const t = now || Date.now();
  const arr = (_reportTimes.get(userId) || []).filter(x => t - x < 3600e3);
  if (arr.length >= REPORTS_PER_HOUR) { _reportTimes.set(userId, arr); return true; }
  arr.push(t); _reportTimes.set(userId, arr);
  return false;
}

function isConfigured() {
  const ti = config.trackerIssues;
  return !!(config.tokens.notion && ti && ti.channelId && ti.issuesDbId);
}

// ── Pure helpers (unit-tested in test/tracker-issues.test.js) ────────────────

const TRACKER_PATTERNS = [
  { name: 'Trade',   re: /\b(trade|trades|trading|journal|tradezella|zella|playbook|p&l|pnl|csv import|calendar|backtest|r[- ]multiple)\b/i },
  { name: 'Workout', re: /\b(workout|gym|lift|lifting|training tracker|hevy|exercise|set|sets|reps|rep|routine|1rm|pr)\b/i },
  { name: 'Diet',    re: /\b(diet|macro|macros|food|meal|meals|calorie|calories|kcal|macrofactor|nutrition|weigh[- ]?in|fasting)\b/i },
];

function classifyTracker(text) {
  const t = String(text || '');
  const hits = TRACKER_PATTERNS.filter(p => p.re.test(t)).map(p => p.name);
  if (hits.length === 1) return hits[0];
  const explicit = /\b(trade|workout|diet)[- ]?tracker\b/i.exec(t);
  if (explicit) return explicit[1][0].toUpperCase() + explicit[1].slice(1).toLowerCase();
  return hits.length ? hits[0] : 'Unknown';
}

const ANNOUNCE_STATUSES = ['Valid — Queued', 'Fixing', 'Fixed', 'Rejected', 'Awaiting Re-test', 'Closed'];

function statusLine(row) {
  switch (row.status) {
    case 'Valid — Queued':
      return '✅ **Confirmed** — this is a real issue. Queued for a fix.';
    case 'Fixing':
      return '🔧 **Fix in progress.**';
    case 'Fixed':
      return '🛠️ **Fixed**' + (row.fixVersion ? ` in \`${row.fixVersion}\`` : '') + ' — live now. Refresh the app and confirm.';
    case 'Rejected':
      return '❌ **Closed without a change**' + (row.triageNote ? ` — ${row.triageNote}` : '') + '.';
    case 'Awaiting Re-test':
      return '♻️ **Fix shipped.** Please confirm in this thread that the issue is resolved. Reply here to re-open if it\'s still broken.';
    case 'Closed':
      return '🔒 **Ticket closed.** Reply here to re-open.';
    default: return null;
  }
}

/**
 * Pure: which Awaiting Re-test tickets have been silent for AUTO_CLOSE_DAYS.
 * @param {Array}  awaitingRows — rows currently at Awaiting Re-test status
 * @param {Object} awaitingRetestSince — { [pageId]: timestampMs }
 * @param {number} nowMs — injectable clock for unit tests
 */
function computeAutoCloseList(awaitingRows, awaitingRetestSince, nowMs) {
  const cutoffMs = AUTO_CLOSE_DAYS * 24 * 60 * 60 * 1000;
  return awaitingRows.filter(r => {
    const since = awaitingRetestSince[r.pageId];
    return since && (nowMs - since) >= cutoffMs;
  });
}

/**
 * Diff freshly-polled rows against announced-state.
 */
function computeStatusAnnouncements(rows, announced) {
  const toAnnounce = [];
  const nextAnnounced = {};
  for (const r of rows) {
    if (!r.pageId) continue;
    const prev = announced[r.pageId];
    if (ANNOUNCE_STATUSES.includes(r.status) && r.status !== prev) {
      toAnnounce.push(r);
      nextAnnounced[r.pageId] = r.status;
    } else if (prev) {
      nextAnnounced[r.pageId] = prev;
    }
  }
  return { toAnnounce, nextAnnounced };
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { console.error('[tracker-issues] error loading state:', e); }
  return { announced: {}, awaitingRetestSince: {} };
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('[tracker-issues] error saving state:', e); }
}

// ── Notion REST ───────────────────────────────────────────────────────────────

async function notion(method, endpoint, body) {
  const res = await fetch('https://api.notion.com/v1' + endpoint, {
    method,
    headers: {
      'Authorization': 'Bearer ' + config.tokens.notion,
      'Notion-Version': NOTION_VER,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`notion ${res.status}: ${data.message || endpoint}`);
  return data;
}

const rt = s => [{ text: { content: String(s).slice(0, 1900) } }];

async function createIssuePage(report) {
  return notion('POST', '/pages', {
    parent: { database_id: config.trackerIssues.issuesDbId },
    properties: {
      'Report':       { title: rt(report.title) },
      'Tracker':      { select: { name: report.tracker } },
      'Status':       { select: { name: 'Reported' } },
      'Reporter':     { rich_text: rt(report.reporter) },
      'Discord Link': { url: report.link },
      'Detail':       { rich_text: rt(report.detail) },
      'Reported':     { date: { start: new Date().toISOString() } },
    },
  });
}

async function updateIssueStatus(pageId, newStatus) {
  await notion('PATCH', `/pages/${pageId}`, {
    properties: { 'Status': { select: { name: newStatus } } },
  });
}

async function queryIssueRows() {
  const data = await notion('POST', `/databases/${config.trackerIssues.issuesDbId}/query`, {
    page_size: 100,
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
  });
  return (data.results || []).map(p => {
    const props = p.properties || {};
    const sel  = n => (props[n] && props[n].select && props[n].select.name) || '';
    const text = n => ((props[n] && props[n].rich_text) || []).map(t => t.plain_text).join('');
    return {
      pageId: p.id,
      status: sel('Status'),
      tracker: sel('Tracker'),
      fixVersion: text('Fix Version'),
      triageNote: text('Triage Note'),
      link: (props['Discord Link'] && props['Discord Link'].url) || '',
      title: ((props['Report'] && props['Report'].title) || []).map(t => t.plain_text).join(''),
    };
  });
}

async function findIssueByMsgId(messageId) {
  const rows = await queryIssueRows();
  return rows.find(r => {
    const ref = parseMessageRef(r.link);
    return ref && ref.messageId === String(messageId);
  }) || null;
}

// ── Command Queue dispatchers ─────────────────────────────────────────────────

async function queueTriageDispatch(report, pageId) {
  if (!config.trackerIssues.cmdQueueDbId) return;
  const cmd = `Triage tracker issue: [${report.tracker}] ${report.title}`;
  await notion('POST', '/pages', {
    parent: { database_id: config.trackerIssues.cmdQueueDbId },
    properties: {
      'Command':   { title: rt(cmd.slice(0, 120)) },
      'Action':    { select: { name: 'dispatch' } },
      'Status':    { select: { name: 'Pending' } },
      'Requested': { date: { start: new Date().toISOString() } },
      'Source':    { rich_text: rt('The Eye — #tracker-bugs intake') },
      'Detail':    { rich_text: rt(
        `New member bug report in #tracker-bugs. Run the tracker-issue-triage procedure (JARVIS.md §2): ` +
        `read Tracker Issues page ${pageId} (Status=Reported), judge valid/duplicate/invalid, ` +
        `valid → Fix List row for the ${report.tracker} tracker + Status "Valid — Queued"; ` +
        `invalid/duplicate → "Rejected" + Triage Note. Report: ${report.detail.slice(0, 600)}`
      ) },
    },
  });
}

async function queueTriageChatDispatch({ pageId, discordLink, reporterTag, reporterId, messageText, currentStatus, source }) {
  if (!config.trackerIssues.cmdQueueDbId) return;
  const detail = JSON.stringify({
    ticketPageId: pageId,
    discordLink,
    reporterTag,
    reporterId,
    messageText: String(messageText || '').slice(0, 600),
    currentStatus,
  });
  const cmdPreview = String(messageText || '').slice(0, 80) || `ticket ${pageId}`;
  await notion('POST', '/pages', {
    parent: { database_id: config.trackerIssues.cmdQueueDbId },
    properties: {
      'Command':   { title: rt(`triage-chat: ${cmdPreview}`) },
      'Action':    { select: { name: 'triage-chat' } },
      'Status':    { select: { name: 'Pending' } },
      'Requested': { date: { start: new Date().toISOString() } },
      'Source':    { rich_text: rt(source || 'The Eye — #tracker-bugs') },
      'Detail':    { rich_text: rt(detail) },
    },
  });
}

// ── Intake ────────────────────────────────────────────────────────────────────

async function withRetry(fn, tries, delayMs) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1))); }
  }
  throw lastErr;
}

/**
 * messageCreate hook. Handles both new reports (top-level in #tracker-bugs)
 * and reporter follow-ups (replies in the report's thread).
 * Awards no points; zero @everyone; no LLM in-process.
 */
async function handleMessage(message, client) {
  if (!isConfigured()) return;
  if (!message.guild) return;
  if (message.author.id === client.user?.id) return;
  if (message.author.bot && message.author.id !== config.trackerIssues.testUserId) return;

  const channelId = config.trackerIssues.channelId;
  const ch = message.channel;

  // Detect top-level post vs. thread reply
  const isThread = ch &&
    typeof ch.isThread === 'function' && ch.isThread() &&
    ch.parentId === channelId;
  const isMainChannel = !isThread && message.channelId === channelId;

  if (!isMainChannel && !isThread) return;

  const content = String(message.content || '').trim();
  const attachments = [...message.attachments.values()].map(a => a.url);
  if (!content && attachments.length === 0) return;

  // ── Thread reply (reporter following up on an existing ticket) ────────────
  if (isThread) {
    // message.channelId === thread ID === original report message ID (Discord convention)
    const threadMsgId = message.channelId;
    let ticket;
    try { ticket = await withRetry(() => findIssueByMsgId(threadMsgId), 2, 1500); }
    catch (e) { console.error('[tracker-issues] findIssueByMsgId error:', e.message); return; }
    if (!ticket) {
      console.log(`[tracker-issues] thread reply in ${threadMsgId} — no matching ticket found`);
      return;
    }

    const effectiveStatus = ticket.status;

    // Closed ticket: reopen to Reported before queuing triage-chat
    if (effectiveStatus === 'Closed') {
      try { await withRetry(() => updateIssueStatus(ticket.pageId, 'Reported'), 2, 1500); }
      catch (e) { console.error('[tracker-issues] reopen failed:', e.message); }
    }

    // Reset the awaiting-retest clock so auto-close doesn't fire after a reply
    const state = loadState();
    if (!state.awaitingRetestSince) state.awaitingRetestSince = {};
    if (state.awaitingRetestSince[ticket.pageId]) {
      state.awaitingRetestSince[ticket.pageId] = Date.now();
      saveState(state);
    }

    // Queue triage-chat for Jarvis to reply conversationally AS THE EYE
    const replyLink = `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`;
    try {
      await queueTriageChatDispatch({
        pageId: ticket.pageId,
        discordLink: replyLink,
        reporterTag: message.author.username,
        reporterId: message.author.id,
        messageText: content || '(attachment only)',
        currentStatus: effectiveStatus === 'Closed' ? 'Reported' : effectiveStatus,
        source: 'The Eye — #tracker-bugs thread reply',
      });
      console.log(`[tracker-issues] triage-chat queued for ticket ${ticket.pageId} (status was: ${effectiveStatus})`);
    } catch (e) { console.error('[tracker-issues] triage-chat dispatch failed:', e.message); }
    return;
  }

  // ── New report (top-level in #tracker-bugs) ───────────────────────────────
  if (overReportLimit(message.author.id)) {
    console.log(`[tracker-issues] rate-limited ${message.author.username} (${message.author.id})`);
    try { await message.react('🕒'); } catch {}
    return;
  }

  const report = {
    title: (content || 'Screenshot report').replace(/\s+/g, ' ').slice(0, MAX_TITLE),
    detail: (content + (attachments.length ? '\nAttachments:\n' + attachments.join('\n') : '')).slice(0, MAX_DETAIL),
    tracker: classifyTracker(content),
    reporter: `${message.author.username} (${message.author.id})`,
    link: `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`,
  };

  try {
    const page = await withRetry(() => createIssuePage(report), 3, 1500);
    console.log(`[tracker-issues] filed report ${page.id} [${report.tracker}] by ${report.reporter}`);
    try { await message.react('✅'); } catch (e) { console.error('[tracker-issues] react failed:', e.message); }
    // Queue initial triage-chat so Jarvis acknowledges the report conversationally
    try {
      await queueTriageChatDispatch({
        pageId: page.id,
        discordLink: report.link,
        reporterTag: message.author.username,
        reporterId: message.author.id,
        messageText: report.detail,
        currentStatus: 'Reported',
        source: 'The Eye — #tracker-bugs new report',
      });
    } catch (e) {
      console.error('[tracker-issues] triage-chat dispatch failed (queueing legacy dispatch):', e.message);
      // Fallback: legacy dispatch so triage still happens
      try { await queueTriageDispatch(report, page.id); }
      catch (e2) { console.error('[tracker-issues] legacy dispatch also failed:', e2.message); }
    }
  } catch (e) {
    console.error('[tracker-issues] failed to file report:', e.message);
    try { await message.react('⚠️'); } catch {}
  }
}

// ── Status poller ─────────────────────────────────────────────────────────────

function parseMessageRef(link) {
  const m = /channels\/(\d+)\/(\d+)\/(\d+)/.exec(String(link || ''));
  return m ? { guildId: m[1], channelId: m[2], messageId: m[3] } : null;
}

async function pollStatuses(client) {
  if (!isConfigured()) return { ran: false, reason: 'not-configured' };
  let rows;
  try { rows = await queryIssueRows(); }
  catch (e) { console.error('[tracker-issues] status poll query failed:', e.message); return { ran: false, reason: 'query-failed' }; }

  const mapped = rows.map(r => ({ ...r, messageId: (parseMessageRef(r.link) || {}).messageId }));
  const state = loadState();
  const { toAnnounce, nextAnnounced } = computeStatusAnnouncements(mapped, state.announced || {});
  state.announced = nextAnnounced;

  // Track when each ticket enters Awaiting Re-test (start the auto-close clock)
  if (!state.awaitingRetestSince) state.awaitingRetestSince = {};
  for (const r of mapped) {
    if (r.status === 'Awaiting Re-test') {
      if (!state.awaitingRetestSince[r.pageId]) {
        state.awaitingRetestSince[r.pageId] = Date.now();
      }
    } else if (state.awaitingRetestSince[r.pageId]) {
      delete state.awaitingRetestSince[r.pageId];
    }
  }
  saveState(state);

  if (!toAnnounce.length) return { ran: true, announced: 0 };

  const channel = client.channels.cache.get(config.trackerIssues.channelId);
  if (!channel) { console.error('[tracker-issues] bugs channel not in cache'); return { ran: false, reason: 'no-channel' }; }

  let posted = 0;
  for (const row of toAnnounce) {
    const line = statusLine(row);
    if (!line) continue;
    try {
      const ref = parseMessageRef(row.link);
      const payload = { content: line, allowedMentions: { parse: [] } };
      if (ref && ref.channelId === config.trackerIssues.channelId) {
        payload.reply = { messageReference: ref.messageId, failIfNotExists: false };
      } else {
        payload.content = `${line}\n> ${row.title}`;
      }
      await channel.send(payload);
      posted++;
    } catch (e) { console.error('[tracker-issues] status reply failed:', e.message); }
  }
  console.log(`[tracker-issues] status poll: ${posted}/${toAnnounce.length} updates posted.`);
  return { ran: true, announced: posted };
}

// ── Auto-close check ──────────────────────────────────────────────────────────

async function autoCloseCheck(client) {
  if (!isConfigured()) return;
  const nowMs = Date.now();

  // Daily dedup — run once per calendar day in America/New_York
  const todayET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(nowMs);
  const state = loadState();
  if (state.lastAutoCloseDate === todayET) return;

  let rows;
  try { rows = await queryIssueRows(); }
  catch (e) { console.error('[tracker-issues] auto-close query failed:', e.message); return; }

  const awaitingRows = rows.filter(r => r.status === 'Awaiting Re-test');
  if (!state.awaitingRetestSince) state.awaitingRetestSince = {};

  // Seed timestamps for any Awaiting Re-test tickets not yet tracked
  for (const r of awaitingRows) {
    if (!state.awaitingRetestSince[r.pageId]) {
      state.awaitingRetestSince[r.pageId] = nowMs;
    }
  }
  // Remove entries for tickets no longer Awaiting Re-test
  for (const pageId of Object.keys(state.awaitingRetestSince)) {
    if (!awaitingRows.find(r => r.pageId === pageId)) {
      delete state.awaitingRetestSince[pageId];
    }
  }

  const toClose = computeAutoCloseList(awaitingRows, state.awaitingRetestSince, nowMs);

  const channel = client.channels.cache.get(config.trackerIssues.channelId);

  for (const row of toClose) {
    try {
      await updateIssueStatus(row.pageId, 'Closed');
      delete state.awaitingRetestSince[row.pageId];
      console.log(`[tracker-issues] auto-closed ticket ${row.pageId} (${AUTO_CLOSE_DAYS}d with no reply)`);

      // Post "reply here to reopen" note in the original report's thread/reply
      if (channel) {
        const ref = parseMessageRef(row.link);
        const payload = {
          content: `🔒 Auto-closed after ${AUTO_CLOSE_DAYS} days with no reply. Reply here to re-open this ticket.`,
          allowedMentions: { parse: [] },
        };
        if (ref && ref.channelId === config.trackerIssues.channelId) {
          payload.reply = { messageReference: ref.messageId, failIfNotExists: false };
        } else {
          payload.content += `\n> ${row.title}`;
        }
        await channel.send(payload);
      }
    } catch (e) { console.error('[tracker-issues] auto-close failed for', row.pageId, ':', e.message); }
  }

  state.lastAutoCloseDate = todayET;
  saveState(state);

  if (toClose.length > 0) {
    console.log(`[tracker-issues] daily auto-close: ${toClose.length} ticket(s) closed.`);
  }
}

function startPolling(client) {
  if (!isConfigured()) { console.log('[tracker-issues] not configured — intake dormant.'); return; }
  // 5-min status poller
  setInterval(() => pollStatuses(client).catch(e => console.error('[tracker-issues] poll error:', e)), POLL_MINUTES * 60 * 1000);
  // Daily auto-close check — runs every 60s but bails early if already done today
  setInterval(() => autoCloseCheck(client).catch(e => console.error('[tracker-issues] auto-close error:', e)), 60 * 1000);
  console.log(`[tracker-issues] live — channel ${config.trackerIssues.channelId}, polling every ${POLL_MINUTES} min, daily auto-close enabled.`);
}

module.exports = {
  isConfigured,
  overReportLimit,
  classifyTracker,
  computeStatusAnnouncements,
  computeAutoCloseList,
  statusLine,
  parseMessageRef,
  handleMessage,
  pollStatuses,
  autoCloseCheck,
  startPolling,
  ANNOUNCE_STATUSES,
  AUTO_CLOSE_DAYS,
};
