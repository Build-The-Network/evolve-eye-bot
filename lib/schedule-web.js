'use strict';
/**
 * lib/schedule-web.js — the Schedule Builder (lab), a calendar view of a member's habits.
 *
 * Mounted at /schedule on The Eye's Express server. Each member gets a private,
 * HMAC-signed link (24h) from the #schedule-lab button. The page edits the SAME
 * habit list as the #habits panel, so check-ins and the week board pick changes up.
 *
 *   GET  /schedule?t=<token>          the calendar page
 *   GET  /schedule/api/habits?t=...   { habits, min, max }
 *   PUT  /schedule/api/habits?t=...   { habits: [...] } → validated + saved
 */

const express = require('express');

module.exports = function createScheduleRouter(habits) {
  const router = express.Router();

  const userFrom = (req, res) => {
    const userId = habits.verifyLink(req.query.t);
    if (!userId) res.status(401).json({ error: 'This link has expired. Grab a new one from #schedule-lab.' });
    return userId;
  };

  router.get('/', (req, res) => res.type('html').set('Cache-Control', 'no-store').send(PAGE));

  router.get('/api/habits', (req, res) => {
    const userId = userFrom(req, res); if (!userId) return;
    res.json({ habits: habits.getHabits(userId), min: { evolution: habits.MIN_EVOLUTION, trading: habits.MIN_TRADING }, max: habits.MAX_HABITS });
  });

  router.put('/api/habits', express.json({ limit: '64kb' }), (req, res) => {
    const userId = userFrom(req, res); if (!userId) return;
    const result = habits.setHabitsFromCalendar(userId, req.body?.habits);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  return router;
};

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Schedule Builder · EVOLVE</title>
<style>
  :root {
    --bg: #f4f2ef; --panel: #ffffff; --ink: #1d1b19; --muted: #6f6a64; --line: #e3dfda; --line-soft: #efece8;
    --evo: #23845b; --evo-soft: #dcefe5; --trade: #d2381c; --trade-soft: #f8e0d9;
    --accent: #e63b1e; --today: #fff6ef; --shadow: 0 10px 30px rgba(29,27,25,.14);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141312; --panel: #1d1c1a; --ink: #f1eeea; --muted: #a39d96; --line: #2e2c29; --line-soft: #252321;
      --evo: #47b886; --evo-soft: #183428; --trade: #f0603f; --trade-soft: #3a1e17;
      --accent: #f0603f; --today: #221d18; --shadow: 0 10px 30px rgba(0,0,0,.5);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  button, input, select { font: inherit; color: inherit; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 18px 16px 40px; }
  header { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: .01em; }
  .sub { color: var(--muted); font-size: 13px; letter-spacing: .06em; text-transform: uppercase; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); font-size: 13px; font-variant-numeric: tabular-nums; }
  .chip.ok { border-color: var(--evo); }
  .status { font-size: 13px; color: var(--muted); min-width: 64px; text-align: right; }
  .btn { border: 1px solid var(--line); background: var(--panel); padding: 7px 12px; border-radius: 8px; cursor: pointer; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn.danger { color: var(--trade); }
  .btn:focus-visible, .slot:focus-visible, .block:focus-visible, .day-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tray { display: none; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 12px; padding: 10px 12px; background: var(--panel); border: 1px dashed var(--line); border-radius: 10px; font-size: 13px; }
  .tray.show { display: flex; }
  .tray b { color: var(--muted); font-weight: 600; margin-right: 4px; }
  .cal { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .scroll { overflow: auto; max-height: calc(100vh - 190px); min-height: 420px; }
  .grid { display: grid; grid-template-columns: 56px repeat(7, minmax(104px, 1fr)); min-width: 784px; position: relative; }
  .head { position: sticky; top: 0; z-index: 3; background: var(--panel); border-bottom: 1px solid var(--line); padding: 8px 6px; text-align: center; font-size: 13px; font-weight: 600; }
  .head.today { color: var(--accent); }
  .corner { position: sticky; left: 0; top: 0; z-index: 4; background: var(--panel); border-bottom: 1px solid var(--line); }
  .times { position: sticky; left: 0; z-index: 2; background: var(--panel); border-right: 1px solid var(--line); }
  .time { height: 72px; font-size: 11px; color: var(--muted); text-align: right; padding: 0 6px; transform: translateY(-7px); font-variant-numeric: tabular-nums; }
  .col { position: relative; border-right: 1px solid var(--line-soft); }
  .col.today { background: var(--today); }
  .slot { height: 18px; border-bottom: 1px solid transparent; cursor: pointer; }
  .slot.hour { border-bottom-color: var(--line-soft); }
  .slot:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .block { position: absolute; left: 3px; right: 3px; border-radius: 7px; padding: 3px 7px; font-size: 12px; line-height: 1.25; overflow: hidden; cursor: grab; border-left: 3px solid; touch-action: none; user-select: none; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .block.evolution { background: var(--evo-soft); border-color: var(--evo); }
  .block.trading { background: var(--trade-soft); border-color: var(--trade); }
  .block .t { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 11px; }
  .block.short { padding: 1px 6px; white-space: nowrap; text-overflow: ellipsis; display: flex; gap: 4px; align-items: center; }
  .block.dragging { cursor: grabbing; opacity: .85; box-shadow: var(--shadow); z-index: 5; }
  .tag { display: inline-flex; gap: 4px; align-items: center; padding: 4px 9px; border-radius: 999px; cursor: pointer; border: 1px solid; font-size: 13px; background: var(--panel); }
  .tag.evolution { border-color: var(--evo); } .tag.trading { border-color: var(--trade); }
  .hint { color: var(--muted); font-size: 13px; margin: 10px 2px 0; }
  dialog { border: 0; border-radius: 14px; padding: 0; width: min(440px, calc(100vw - 32px)); background: var(--panel); color: var(--ink); box-shadow: var(--shadow); }
  dialog::backdrop { background: rgba(0,0,0,.45); }
  form.ed { padding: 18px; display: grid; gap: 14px; }
  .ed h2 { margin: 0; font-size: 17px; }
  .ed label.f { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
  .ed input[type=text], .ed input[type=time], .ed select { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .seg, .days { display: flex; gap: 6px; flex-wrap: wrap; }
  .seg button, .day-toggle { flex: 1; padding: 8px 6px; border: 1px solid var(--line); background: var(--bg); border-radius: 8px; cursor: pointer; min-width: 40px; }
  .seg button[aria-pressed=true].evolution { background: var(--evo-soft); border-color: var(--evo); font-weight: 600; }
  .seg button[aria-pressed=true].trading { background: var(--trade-soft); border-color: var(--trade); font-weight: 600; }
  .day-toggle[aria-pressed=true] { background: var(--ink); color: var(--panel); border-color: var(--ink); font-weight: 600; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .actions { display: flex; gap: 8px; justify-content: space-between; align-items: center; }
  .err { color: var(--trade); font-size: 13px; min-height: 1em; }
  .gate { max-width: 520px; margin: 18vh auto; text-align: center; padding: 0 16px; }
  @media (prefers-reduced-motion: no-preference) { .block { transition: box-shadow .15s; } }
</style>
</head>
<body>
<div class="wrap" id="app">
  <header>
    <div>
      <div class="sub">EVOLVE · Habit system</div>
      <h1>Schedule builder</h1>
    </div>
    <div class="bar">
      <span class="chip" id="chip-evo">🧬 Evolution 0/4</span>
      <span class="chip" id="chip-trade">📈 Trading 0/1</span>
      <button class="btn primary" id="add">＋ Add habit</button>
      <span class="status" id="status" aria-live="polite"></span>
    </div>
  </header>
  <div class="tray" id="tray"><b>No time set:</b></div>
  <div class="cal"><div class="scroll" id="scroll"><div class="grid" id="grid"></div></div></div>
  <p class="hint">Click an empty slot to drop a habit in. Drag a habit up or down to move it. Click a habit to edit it. Changes save on their own.</p>
</div>

<dialog id="dlg">
  <form class="ed" id="ed" method="dialog">
    <h2 id="ed-title">Add a habit</h2>
    <label class="f">Habit<input type="text" id="f-name" maxlength="60" placeholder="4:00 wake up · Cold shower · Pre-market process" required></label>
    <div class="f" style="display:grid;gap:6px;font-size:13px;color:var(--muted)">Part
      <div class="seg" role="group" aria-label="Part">
        <button type="button" class="evolution" data-part="evolution">🧬 Evolution</button>
        <button type="button" class="trading" data-part="trading">📈 Trading</button>
      </div>
    </div>
    <div class="f" style="display:grid;gap:6px;font-size:13px;color:var(--muted)">Days
      <div class="days" id="f-days" role="group" aria-label="Days"></div>
    </div>
    <div class="row2">
      <label class="f">Start<input type="time" id="f-time" step="900"></label>
      <label class="f">Length
        <select id="f-min"><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="180">3 hours</option></select>
      </label>
    </div>
    <div class="err" id="f-err"></div>
    <div class="actions">
      <button type="button" class="btn danger" id="f-del">Delete</button>
      <span style="display:flex;gap:8px">
        <button type="button" class="btn" id="f-cancel">Cancel</button>
        <button type="submit" class="btn primary" id="f-save">Save</button>
      </span>
    </div>
  </form>
</dialog>

<script>
(() => {
  const token = new URLSearchParams(location.search).get('t');
  const START_H = 3, END_H = 24, PX_PER_MIN = 1.2;     // 72px per hour, 18px per 15 min
  const ORDER = [1, 2, 3, 4, 5, 6, 0];                  // Mon → Sun
  const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let habits = [], min = { evolution: 4, trading: 1 }, max = 15, editing = null, draft = null;
  const $ = (id) => document.getElementById(id);
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toTime = (mins) => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  const fmt = (t) => { const [h, m] = t.split(':').map(Number); return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + (h < 12 ? 'a' : 'p'); };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function gate(msg) { document.body.innerHTML = '<div class="gate"><h1>Schedule builder</h1><p class="sub" style="text-transform:none;letter-spacing:0">' + esc(msg) + '</p></div>'; }

  async function api(method, body) {
    const r = await fetch('/schedule/api/habits?t=' + encodeURIComponent(token), {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { status: r.status });
    return j;
  }

  let saveTimer = null;
  function save() {
    $('status').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { const j = await api('PUT', { habits }); habits = j.habits; render(); $('status').textContent = 'Saved ✓'; }
      catch (e) { if (e.status === 401) return gate(e.message); $('status').textContent = '⚠ ' + e.message; }
    }, 350);
  }

  function chips() {
    const ev = habits.filter(h => h.part === 'evolution').length, tr = habits.filter(h => h.part === 'trading').length;
    $('chip-evo').textContent = (ev >= min.evolution ? '✅' : '🧬') + ' Evolution ' + ev + '/' + min.evolution;
    $('chip-trade').textContent = (tr >= min.trading ? '✅' : '📈') + ' Trading ' + tr + '/' + min.trading;
    $('chip-evo').classList.toggle('ok', ev >= min.evolution);
    $('chip-trade').classList.toggle('ok', tr >= min.trading);
  }

  function render() {
    chips();
    const grid = $('grid'), todayIdx = new Date().getDay();
    grid.innerHTML = '';
    grid.appendChild(Object.assign(document.createElement('div'), { className: 'corner' }));
    for (const d of ORDER) {
      const h = document.createElement('div');
      h.className = 'head' + (d === todayIdx ? ' today' : '');
      h.textContent = NAMES[d];
      grid.appendChild(h);
    }
    const times = document.createElement('div'); times.className = 'times';
    for (let hr = START_H; hr < END_H; hr++) {
      const t = document.createElement('div'); t.className = 'time'; t.textContent = hr === START_H ? '' : fmt(toTime(hr * 60)); times.appendChild(t);
    }
    grid.appendChild(times);
    for (const d of ORDER) {
      const col = document.createElement('div');
      col.className = 'col' + (d === todayIdx ? ' today' : '');
      col.dataset.day = d;
      for (let m = START_H * 60; m < END_H * 60; m += 15) {
        const s = document.createElement('div');
        s.className = 'slot' + ((m + 15) % 60 === 0 ? ' hour' : '');
        s.tabIndex = -1;
        s.addEventListener('click', () => openEditor(null, { days: [d], time: toTime(m) }));
        col.appendChild(s);
      }
      // Lay out this day's blocks; overlapping blocks share the column width.
      const items = habits.filter(h => h.time && h.days.includes(d)).map(h => ({ h, s: toMin(h.time), e: toMin(h.time) + (h.minutes || 30) })).sort((a, b) => a.s - b.s);
      const lanes = [];
      for (const it of items) { let lane = lanes.findIndex(end => end <= it.s); if (lane < 0) { lane = lanes.length; lanes.push(0); } lanes[lane] = it.e; it.lane = lane; }
      for (const it of items) {
        const overlapping = items.filter(o => o.s < it.e && it.s < o.e);
        const width = Math.max(...overlapping.map(o => o.lane)) + 1;
        const b = document.createElement('div');
        b.className = 'block ' + it.h.part;
        b.tabIndex = 0;
        b.style.top = ((it.s - START_H * 60) * PX_PER_MIN) + 'px';
        b.style.height = Math.max(16, (it.e - it.s) * PX_PER_MIN - 2) + 'px';
        b.style.left = 'calc(' + (it.lane / width * 100) + '% + 3px)';
        b.style.width = 'calc(' + (100 / width) + '% - 6px)';
        const short = (it.e - it.s) < 30;
        if (short) b.classList.add('short');
        b.innerHTML = '<span class="t">' + fmt(it.h.time) + '</span>' + (short ? ' ' : '<br>') + '<span class="n">' + esc(it.h.name) + '</span>';
        attachDrag(b, it.h);
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter') openEditor(it.h); });
        col.appendChild(b);
      }
      grid.appendChild(col);
    }
    const tray = $('tray');
    tray.querySelectorAll('.tag').forEach(n => n.remove());
    const untimed = habits.filter(h => !h.time);
    tray.classList.toggle('show', untimed.length > 0);
    for (const h of untimed) {
      const t = document.createElement('button'); t.type = 'button'; t.className = 'tag ' + h.part;
      t.textContent = (h.part === 'evolution' ? '🧬 ' : '📈 ') + h.name;
      t.addEventListener('click', () => openEditor(h));
      tray.appendChild(t);
    }
  }

  // Drag vertically to move a habit's time (all its days move together).
  function attachDrag(el, habit) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const startY = e.clientY, startTop = parseFloat(el.style.top);
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) > 4) moved = true;
        if (!moved) return;
        el.classList.add('dragging');
        const minutes = Math.round((startTop + dy) / PX_PER_MIN / 15) * 15 + START_H * 60;
        const clamped = Math.min(END_H * 60 - 15, Math.max(START_H * 60, minutes));
        el.style.top = ((clamped - START_H * 60) * PX_PER_MIN) + 'px';
        el.querySelector('.t').textContent = fmt(toTime(clamped));
        el.dataset.time = toTime(clamped);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (!moved) return openEditor(habit);
        habit.time = el.dataset.time;
        render(); save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  // ── Editor ──────────────────────────────────────────────────────────────
  const dayBox = $('f-days');
  for (const d of ORDER) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'day-toggle'; b.dataset.day = d;
    b.textContent = NAMES[d][0] + (d === 4 || d === 2 ? NAMES[d][1] : ''); b.setAttribute('aria-label', NAMES[d]);
    b.addEventListener('click', () => { draft.days = draft.days.includes(d) ? draft.days.filter(x => x !== d) : [...draft.days, d]; syncEditor(); });
    dayBox.appendChild(b);
  }
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => { draft.part = b.dataset.part; syncEditor(); }));

  function syncEditor() {
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.part === draft.part)));
    dayBox.querySelectorAll('.day-toggle').forEach(b => b.setAttribute('aria-pressed', String(draft.days.includes(Number(b.dataset.day)))));
  }

  function openEditor(habit, preset = {}) {
    if (!habit && habits.length >= max) { $('status').textContent = '⚠ Up to ' + max + ' habits — core habits beat a long list.'; return; }
    editing = habit;
    draft = habit ? { ...habit, days: [...habit.days] } : { name: '', part: 'evolution', days: preset.days || [new Date().getDay()], time: preset.time || '06:00', minutes: 30 };
    $('ed-title').textContent = habit ? 'Edit habit' : 'Add a habit';
    $('f-name').value = draft.name;
    $('f-time').value = draft.time || '';
    $('f-min').value = String(draft.minutes || 30);
    $('f-del').style.visibility = habit ? 'visible' : 'hidden';
    $('f-err').textContent = '';
    syncEditor();
    $('dlg').showModal();
    $('f-name').focus();
  }

  $('ed').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('f-name').value.trim();
    if (!name) return ($('f-err').textContent = 'Give the habit a name.');
    if (!draft.days.length) return ($('f-err').textContent = 'Pick at least one day.');
    if (habits.some(h => h !== editing && h.name.toLowerCase() === name.toLowerCase())) return ($('f-err').textContent = 'You already have a habit with that name.');
    const next = { ...draft, name, time: $('f-time').value || undefined, minutes: Number($('f-min').value) };
    if (!next.time) delete next.minutes;
    if (editing) Object.assign(editing, next); else habits.push({ ...next, id: 'new-' + Date.now() });
    $('dlg').close(); render(); save();
  });
  $('f-cancel').addEventListener('click', () => $('dlg').close());
  $('f-del').addEventListener('click', () => {
    if (!editing || !confirm('Delete "' + editing.name + '"? Its history stays; it just stops being scheduled.')) return;
    habits = habits.filter(h => h !== editing);
    $('dlg').close(); render(); save();
  });
  $('add').addEventListener('click', () => openEditor(null));

  // ── Boot ───────────────────────────────────────────────────────────────
  if (!token) return gate('Open this from the button in #schedule-lab on Discord.');
  api('GET').then((j) => {
    habits = j.habits; min = j.min; max = j.max;
    render();
    $('scroll').scrollTop = (4 - START_H) * 72;   // start the view at 4:00
  }).catch((e) => gate(e.message));
})();
</script>
</body>
</html>`;
