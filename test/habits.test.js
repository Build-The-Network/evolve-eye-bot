'use strict';
// Offline test of lib/habits.js — simulated member, no Discord connection.
// Run: node test/habits.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'habits-'));
const points = {};
const sent = [];
const fakeChannel = { id: 'ch', send: async (m) => { sent.push(m); return { id: 'm1' }; } };
const habits = require('../lib/habits')({
  client: { channels: { cache: { get: () => fakeChannel } } },
  dataDir,
  getTimezone: () => 'Africa/Johannesburg',
  addPoints: (id, n) => { points[id] = (points[id] || 0) + n; return { allTime: points[id] }; },
  updateMemberRole: async () => {},
  isIgnored: () => false,
  channels: { training: 'ch', nutrition: 'ch', tradingReview: 'ch', tradeJournal: 'ch', board: 'ch' },
  accent: 0xe63b1e,
  auditLog: async () => {},
});

function interaction({ command, sub, opts = {} }) {
  const replies = [];
  return {
    replies,
    commandName: command,
    user: { id: 'u1', username: 'tester', displayAvatarURL: () => '' },
    member: { nickname: 'Test Member' },
    options: {
      getSubcommand: () => sub,
      getString: (k) => opts[k] ?? null,
      getAttachment: (k) => opts[k] ?? null,
    },
    reply: async (r) => { replies.push(r); },
  };
}

(async () => {
  // Five Evolution habits every day + one Trading habit every day.
  for (const name of ['4am wake', 'Cold shower', 'Gym', 'Meals on protocol']) {
    await habits.handleCommand(interaction({ command: 'habit', sub: 'add', opts: { name, part: 'evolution', days: 'daily' } }));
  }
  // Check-in blocked before the Trading minimum is met.
  let i = interaction({ command: 'checkin', opts: { habit: '4am wake' } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /Build your habit system first/);
  assert.strictEqual(points.u1, undefined);

  await habits.handleCommand(interaction({ command: 'habit', sub: 'add', opts: { name: 'Pre-market process', part: 'trading', days: 'daily' } }));

  // Duplicate name rejected.
  i = interaction({ command: 'habit', sub: 'add', opts: { name: 'gym', part: 'evolution', days: 'daily' } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /already have a habit/);

  // Custom days: bad input rejected, good input accepted.
  i = interaction({ command: 'habit', sub: 'add', opts: { name: 'Read', part: 'evolution', days: 'custom', custom_days: 'funday' } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /custom_days/);

  // Check-in without proof = +1, nothing posted.
  i = interaction({ command: 'checkin', opts: { habit: '4am wake' } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /\+1 pts/);
  assert.strictEqual(points.u1, 1);
  assert.strictEqual(sent.length, 0);

  // Same habit again today = refused, no points.
  i = interaction({ command: 'checkin', opts: { habit: '4am wake' } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /already checked in/);
  assert.strictEqual(points.u1, 1);

  // Check-in with image proof = +2, proof posted publicly.
  i = interaction({ command: 'checkin', opts: { habit: 'Gym', proof: { url: 'https://x/y.png', contentType: 'image/png' }, note: 'Legs' } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /\+2 pts/);
  assert.strictEqual(points.u1, 3);
  assert.strictEqual(sent.length, 1);

  // Non-image proof refused, no points.
  i = interaction({ command: 'checkin', opts: { habit: 'Cold shower', proof: { url: 'x.pdf', contentType: 'application/pdf' } } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /has to be an image/);
  assert.strictEqual(points.u1, 3);

  // View renders both parts and today's progress.
  i = interaction({ command: 'habit', sub: 'view' });
  await habits.handleCommand(i);
  const embed = i.replies[0].embeds[0].toJSON();
  assert.ok(embed.fields[0].value.includes('✅ **4am wake**'));
  assert.ok(embed.fields[0].value.includes('✅📸 **Gym**'));
  assert.ok(embed.fields[1].value.includes('⬜ **Pre-market process**'));

  // Not-scheduled habit refused.
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Johannesburg', weekday: 'short' }).format(new Date());
  const other = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].find(d => d !== today);
  await habits.handleCommand(interaction({ command: 'habit', sub: 'add', opts: { name: 'Long run', part: 'evolution', days: 'custom', custom_days: other } }));
  i = interaction({ command: 'checkin', opts: { habit: 'Long run' } });
  await habits.handleCommand(i);
  assert.match(i.replies[0].content, /isn't scheduled today/);

  // ── Panel: add via pop-up, tap to check in, add proof afterwards ─────────
  const comp = (customId, extra = {}) => {
    const out = { replies: [], updates: [], modals: [] };
    return Object.assign(out, {
      customId,
      user: { id: 'u1', username: 'tester', displayAvatarURL: () => '' },
      member: { nickname: 'Test Member' },
      isButton: () => extra.kind === 'button',
      isModalSubmit: () => extra.kind === 'modal',
      isStringSelectMenu: () => extra.kind === 'select',
      values: extra.values,
      fields: extra.fields,
      reply: async (r) => { out.replies.push(r); },
      update: async (r) => { out.updates.push(r); },
      showModal: async (m) => { out.modals.push(m); },
    });
  };
  const viewToday = await (async () => { const c = comp('hb:checkin', { kind: 'button' }); await habits.handleComponent(c); return c.replies[0]; })();
  assert.match(viewToday.content, /Today: 2\/\d+/);

  // Pop-up add: 'Journal' Evolution, every day.
  let c = comp('hbm:add', { kind: 'modal', fields: {
    getTextInputValue: () => 'Journal',
    getStringSelectValues: (k) => (k === 'part' ? ['evolution'] : ['0', '1', '2', '3', '4', '5', '6']),
  } });
  await habits.handleComponent(c);
  assert.match(c.replies[0].content, /Added \*\*Journal\*\*/);

  // Tap to check in: find Journal's button id from the checklist.
  c = comp('hb:checkin', { kind: 'button' });
  await habits.handleComponent(c);
  const journalBtn = c.replies[0].components.flatMap(r => r.components).map(b => b.toJSON()).find(b => b.label === 'Journal');
  c = comp(journalBtn.custom_id, { kind: 'button' });
  await habits.handleComponent(c);
  assert.match(c.updates[0].content, /Journal\*\* — \+1 pts/);
  assert.strictEqual(points.u1, 4);

  // ── Stamp flow: the member posts the photo himself, The Eye stamps it ────
  const pickers = [];
  const post = (over = {}) => ({
    author: { id: 'u1', bot: false }, guild: {}, url: 'https://discord.com/channels/g/ch/post1',
    channel: { id: 'ch', isThread: () => false }, reference: null,
    attachments: new Map([['a', { url: 'https://cdn/j.png', contentType: 'image/png' }]]),
    reply: async (r) => { const m = { id: `pick${pickers.length + 1}`, r, deleted: false, delete: async () => { m.deleted = true; } }; pickers.push(m); return m; },
    ...over,
  });

  // Text-only discussion and replies never trigger anything.
  await habits.handleMessage(post({ attachments: new Map() }));
  await habits.handleMessage(post({ reference: { messageId: 'x' } }));
  assert.strictEqual(pickers.length, 0);

  // A photo post gets the picker; Journal (checked in, no proof yet) is offered.
  await habits.handleMessage(post());
  assert.strictEqual(pickers.length, 1);
  const stampBtn = pickers[0].r.components.flatMap(r => r.components).map(b => b.toJSON()).find(b => b.label === 'Journal');
  assert.ok(stampBtn, 'Journal offered in the picker');

  // Someone else can't tap it.
  c = comp(stampBtn.custom_id, { kind: 'button' });
  c.message = { id: 'pick1' };
  c.user = { id: 'u2', username: 'other', displayAvatarURL: () => '' };
  await habits.handleComponent(c);
  assert.match(c.replies[0].content, /Only <@u1> can stamp/);
  assert.strictEqual(points.u1, 4);

  // The author taps Journal: +1 for proof (already checked in), card replaces the picker, no bot repost.
  c = comp(stampBtn.custom_id, { kind: 'button' });
  c.message = { id: 'pick1' };
  await habits.handleComponent(c);
  assert.strictEqual(points.u1, 5);
  assert.match(c.updates[0].embeds[0].toJSON().description, /\+1 pts\*\* · proof/);
  assert.strictEqual(sent.length, 1, 'no bot repost — the member’s own post is the proof');

  // The same picker can't be used twice.
  await habits.handleComponent(c);
  assert.match(c.replies[0].content, /expired/);
  assert.strictEqual(points.u1, 5);

  // "Not a habit" deletes the picker and logs nothing.
  await habits.handleMessage(post());
  const notBtn = pickers[1].r.components.flatMap(r => r.components).map(b => b.toJSON()).find(b => b.custom_id === 'hb:stampx');
  c = comp(notBtn.custom_id, { kind: 'button' });
  c.message = { id: 'pick2', delete: async () => { pickers[1].deleted = true; } };
  await habits.handleComponent(c);
  assert.ok(pickers[1].deleted);
  assert.strictEqual(points.u1, 5);

  console.log('habits.test.js — all assertions passed. Points:', points.u1);
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
