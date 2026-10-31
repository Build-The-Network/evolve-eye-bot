'use strict';
/**
 * lib/habits.js — The Habit System (EVOLVE, ruled by Lucca 2026-10-28)
 *
 * Members build their own habits, schedule each one by weekday, and check them
 * off through the day. The community sees the proof.
 *
 *   /habit add | view | remove | board     /checkin habit [proof] [note]
 *
 * Rules (cowork\_coaching\DAILY-ROUTINE.md):
 *   - Two parts: Evolution (personal development) and Trading (the daily process).
 *   - Minimum to check in: 4 Evolution habits + 1 Trading habit.
 *   - Habits don't climb. A habit is only expected — and only counts — on its scheduled days.
 *   - Check-in = +1. Proof (an image) shared with the community = +1 more.
 *   - One check-in per habit per scheduled day, in the member's own timezone.
 *
 * State (per environment, on the Railway volume):
 *   /data/habits.json            { userId: { habits: [{ id, name, part, days:[0-6] }] } }
 *   /data/habit_checkins.json    { userId: { 'YYYY-MM-DD': { habitId: { at, proof } } } }
 *   /data/habit_panel.json       { panelMsgId, boardMsgId }   (the #habits panel + live week board)
 */

const fs   = require('fs');
const path = require('path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const MIN_EVOLUTION = 4;
const MIN_TRADING   = 1;
const MAX_HABITS    = 15;
const POINTS_CHECKIN = 1;
const POINTS_PROOF   = 1;

const PARTS = { evolution: '🧬 Evolution', trading: '📈 Trading' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_PRESETS = {
  daily:    [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  mwf:      [1, 3, 5],
  tts:      [2, 4, 6],
};

// ── Day parsing / formatting ────────────────────────────────────────────────
function parseDays(preset, custom) {
  if (preset && preset !== 'custom') return DAY_PRESETS[preset] || null;
  if (!custom) return null;
  const days = new Set();
  for (const raw of custom.toLowerCase().split(/[\s,/]+/).filter(Boolean)) {
    const i = DAY_NAMES.findIndex(d => raw.startsWith(d.toLowerCase()));
    if (i < 0) return null;
    days.add(i);
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

function formatDays(days) {
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return days.map(d => DAY_NAMES[d]).join('/');
}

// Local calendar date + weekday for a timezone (falls back to ET).
function localDay(tz, offsetDays = 0) {
  const when = new Date(Date.now() + offsetDays * 86400000);
  let zone = tz || 'America/New_York';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'America/New_York'; }
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(when);
  return { date, weekday: DAY_NAMES.indexOf(wd) };
}

module.exports = function createHabits(deps) {
  const {
    client, dataDir, getTimezone, addPoints, updateMemberRole, isIgnored,
    channels, accent, auditLog,
  } = deps;

  const HABITS_FILE   = path.join(dataDir, 'habits.json');
  const CHECKINS_FILE = path.join(dataDir, 'habit_checkins.json');
  
  const load = (file) => {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`[habits] Error loading ${path.basename(file)}:`, e); }
    return {};
  };
  const save = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    catch (e) { console.error(`[habits] Error saving ${path.basename(file)}:`, e); }
  };

  const habitsOf = (userId) => (load(HABITS_FILE)[userId]?.habits) || [];
  const counts = (habits) => ({
    evolution: habits.filter(h => h.part === 'evolution').length,
    trading:   habits.filter(h => h.part === 'trading').length,
  });
  const meetsMinimum = (habits) => {
    const c = counts(habits);
    return c.evolution >= MIN_EVOLUTION && c.trading >= MIN_TRADING;
  };
  const minimumLine = (habits) => {
    const c = counts(habits);
    const ok = (n, min) => (n >= min ? '✅' : '⬜');
    return `${ok(c.evolution, MIN_EVOLUTION)} Evolution ${c.evolution}/${MIN_EVOLUTION} · ${ok(c.trading, MIN_TRADING)} Trading ${c.trading}/${MIN_TRADING}`;
  };

  // Consecutive scheduled days completed, counting back from today (today
  // only counts once it's checked; an unchecked today doesn't break the run).
  function streak(userId, habit) {
    const log = load(CHECKINS_FILE)[userId] || {};
    const tz = getTimezone(userId);
    let run = 0;
    for (let back = 0; back < 400; back++) {
      const { date, weekday } = localDay(tz, -back);
      if (!habit.days.includes(weekday)) continue;
      if (log[date]?.[habit.id]) { run++; continue; }
      if (back === 0) continue;
      break;
    }
    return run;
  }

  function proofChannelId(habit) {
    const n = habit.name.toLowerCase();
    if (habit.part === 'evolution') {
      return /meal|eat|food|nutrition|diet|protein|water|fast/.test(n) ? channels.nutrition : channels.training;
    }
    return /review|pre-?market|post-?market|annotat|plan|journal|recap/.test(n) ? channels.tradingReview : channels.tradeJournal;
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  const commands = [
    new SlashCommandBuilder()
      .setName('habit')
      .setDescription('Build and manage your habits')
      .addSubcommand(s => s
        .setName('add')
        .setDescription('Add a habit to your schedule')
        .addStringOption(o => o.setName('name').setDescription('The habit, e.g. "4:00 wake up" or "Pre-market process"').setRequired(true).setMaxLength(60))
        .addStringOption(o => o.setName('part').setDescription('Evolution (personal development) or Trading (your process)').setRequired(true)
          .addChoices({ name: '🧬 Evolution', value: 'evolution' }, { name: '📈 Trading', value: 'trading' }))
        .addStringOption(o => o.setName('days').setDescription('Which days you do it').setRequired(true)
          .addChoices(
            { name: 'Every day',          value: 'daily' },
            { name: 'Weekdays (Mon–Fri)', value: 'weekdays' },
            { name: 'Weekends (Sat–Sun)', value: 'weekends' },
            { name: 'Mon / Wed / Fri',    value: 'mwf' },
            { name: 'Tue / Thu / Sat',    value: 'tts' },
            { name: 'Custom (fill in custom_days)', value: 'custom' },
          ))
        .addStringOption(o => o.setName('custom_days').setDescription('Only for Custom, e.g. "mon, tue, thu"').setRequired(false)))
      .addSubcommand(s => s.setName('view').setDescription('See your habits and today\'s progress'))
      .addSubcommand(s => s
        .setName('remove')
        .setDescription('Remove one of your habits')
        .addStringOption(o => o.setName('habit').setDescription('The habit to remove').setRequired(true).setAutocomplete(true)))
      .addSubcommand(s => s.setName('board').setDescription('Today\'s habit board — who has knocked out their habits')),
    new SlashCommandBuilder()
      .setName('checkin')
      .setDescription('Check off a habit for today (+1). Share proof for +1 more.')
      .addStringOption(o => o.setName('habit').setDescription('Which habit you just did').setRequired(true).setAutocomplete(true))
      .addAttachmentOption(o => o.setName('proof').setDescription('Photo proof — shared with the community for +1 more').setRequired(false))
      .addStringOption(o => o.setName('note').setDescription('A line on how it went').setRequired(false).setMaxLength(300)),
  ];

  // ── Autocomplete ──────────────────────────────────────────────────────────
  async function handleAutocomplete(interaction) {
    const isRemove  = interaction.commandName === 'habit' && interaction.options.getSubcommand(false) === 'remove';
    const isCheckin = interaction.commandName === 'checkin';
    if (!isRemove && !isCheckin) return false;

    const userId = interaction.user.id;
    const typed  = (interaction.options.getFocused() || '').toLowerCase();
    let habits   = habitsOf(userId);
    if (isCheckin) {
      const { date, weekday } = localDay(getTimezone(userId));
      const done = load(CHECKINS_FILE)[userId]?.[date] || {};
      habits = habits.filter(h => h.days.includes(weekday) && !done[h.id]);
    }
    const choices = habits
      .filter(h => h.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map(h => ({ name: `${h.part === 'evolution' ? '🧬' : '📈'} ${h.name}`.slice(0, 100), value: h.id }));
    await interaction.respond(choices).catch(() => {});
    return true;
  }

  // ── Slash command handling ────────────────────────────────────────────────
  async function handleCommand(interaction) {
    if (interaction.commandName === 'habit') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add')    { await addHabit(interaction);    return true; }
      if (sub === 'view')   { await viewHabits(interaction);  return true; }
      if (sub === 'remove') { await removeHabit(interaction); return true; }
      if (sub === 'board')  { await showBoard(interaction);   return true; }
    }
    if (interaction.commandName === 'checkin') { await checkin(interaction); return true; }
    return false;
  }

  async function addHabit(interaction) {
    const userId = interaction.user.id;
    const name   = interaction.options.getString('name').trim();
    const part   = interaction.options.getString('part');
    const days   = parseDays(interaction.options.getString('days'), interaction.options.getString('custom_days'));
    if (!days) {
      return interaction.reply({ content: '⚠️ For **Custom**, fill in `custom_days` with days like `mon, wed, fri`.', flags: 64 });
    }
    const data = load(HABITS_FILE);
    const habits = data[userId]?.habits || [];
    if (habits.length >= MAX_HABITS) {
      return interaction.reply({ content: `⚠️ You already have ${MAX_HABITS} habits. Core habits beat a long list — remove one first.`, flags: 64 });
    }
    if (habits.some(h => h.name.toLowerCase() === name.toLowerCase())) {
      return interaction.reply({ content: `⚠️ You already have a habit called **${name}**.`, flags: 64 });
    }
    habits.push({ id: Math.random().toString(36).slice(2, 9), name, part, days });
    data[userId] = { ...(data[userId] || {}), habits };
    save(HABITS_FILE, data);

    const ready = meetsMinimum(habits);
    return interaction.reply({
      content:
        `✅ Added **${name}** — ${PARTS[part]} · ${formatDays(days)}\n` +
        `${minimumLine(habits)}\n` +
        (ready ? 'Your habit system is set. `/checkin` every time you knock one out.'
               : `Build to the minimum (${MIN_EVOLUTION} Evolution + ${MIN_TRADING} Trading) to start checking in.`),
      flags: 64,
    });
  }

  function renderHabits(userId) {
    const habits = habitsOf(userId);
    const { date, weekday } = localDay(getTimezone(userId));
    const done = load(CHECKINS_FILE)[userId]?.[date] || {};
    const lines = (part) => habits.filter(h => h.part === part).map(h => {
      const today = h.days.includes(weekday) ? (done[h.id] ? (done[h.id].proof ? '✅📸' : '✅') : '⬜') : '➖';
      const s = streak(userId, h);
      return `${today} **${h.name}** · ${formatDays(h.days)}${s ? ` · 🔥${s}` : ''}`;
    }).join('\n') || '*None yet*';
    return new EmbedBuilder()
      .setTitle('🧭 YOUR HABITS')
      .setDescription(`${minimumLine(habits)}\n*Today: ✅ done · ✅📸 done with proof · ⬜ still to do · ➖ not scheduled*`)
      .addFields(
        { name: PARTS.evolution, value: lines('evolution') },
        { name: PARTS.trading,   value: lines('trading') },
      )
      .setColor(accent)
      .setFooter({ text: 'Build them. Schedule them. Knock them out.' });
  }

  async function viewHabits(interaction) {
    return interaction.reply({ embeds: [renderHabits(interaction.user.id)], flags: 64 });
  }

  async function removeHabit(interaction) {
    const userId = interaction.user.id;
    const id = interaction.options.getString('habit');
    const data = load(HABITS_FILE);
    const habits = data[userId]?.habits || [];
    const habit = habits.find(h => h.id === id || h.name.toLowerCase() === String(id).toLowerCase());
    if (!habit) return interaction.reply({ content: '⚠️ Habit not found. Pick one from the list.', flags: 64 });
    data[userId].habits = habits.filter(h => h !== habit);
    save(HABITS_FILE, data);
    return interaction.reply({ content: `🗑️ Removed **${habit.name}**.\n${minimumLine(data[userId].habits)}`, flags: 64 });
  }

  // ── Core: record a check-in / proof (shared by /checkin and the panel) ────
  // Returns { ok, msg, amount, doneToday, scheduledToday, shared }.
  async function recordCheckin(user, member, habit, image, note, opts = {}) {
    const userId = user.id;
    const habits = habitsOf(userId);
    const { date, weekday } = localDay(getTimezone(userId));
    if (!habit.days.includes(weekday)) return { ok: false, msg: `➖ **${habit.name}** isn't scheduled today (${formatDays(habit.days)}).` };
    const log = load(CHECKINS_FILE);
    log[userId] = log[userId] || {};
    log[userId][date] = log[userId][date] || {};
    const prior = log[userId][date][habit.id];
    if (prior && (!image || prior.proof)) {
      return { ok: false, msg: `✅ **${habit.name}** is already checked in today${prior.proof ? ' with proof' : ''}.` };
    }

    // New check-in = +1 (+1 with proof). Proof added to an existing check-in = +1.
    const amount = (prior ? 0 : POINTS_CHECKIN) + (image ? POINTS_PROOF : 0);
    log[userId][date][habit.id] = { at: prior?.at || new Date().toISOString(), proof: !!image || !!prior?.proof };
    if (opts.proofUrl) log[userId][date][habit.id].proofUrl = opts.proofUrl;
    save(CHECKINS_FILE, log);

    const updated = isIgnored(userId) ? null : addPoints(userId, amount);
    if (updated && member) await updateMemberRole(member, updated.allTime).catch(() => {});

    const s = streak(userId, habit);
    const scheduledToday = habits.filter(h => h.days.includes(weekday));
    const doneToday = scheduledToday.filter(h => log[userId][date][h.id]).length;
    const name = member?.nickname || user.username;

    let shared = '';
    if (image && !opts.proofUrl) {
      const ch = client.channels.cache.get(proofChannelId(habit));
      if (ch) {
        const embed = new EmbedBuilder()
          .setAuthor({ name, iconURL: user.displayAvatarURL() || undefined })
          .setTitle(`${habit.part === 'evolution' ? '🧬' : '📈'} ${habit.name}${s > 1 ? ` · 🔥${s}` : ''}`)
          .setDescription(note || null)
          .setImage(image.url)
          .setFooter({ text: `Habit ${doneToday}/${scheduledToday.length} today` })
          .setColor(accent)
          .setTimestamp();
        const msg = await ch.send({ embeds: [embed] }).catch(e => { console.error('[habits] proof post failed:', e.message); return null; });
        if (msg) shared = `\n📸 Proof shared in <#${ch.id}>.`;
      }
    }

    await auditLog?.(new EmbedBuilder()
      .setTitle('🪙 Points Awarded — Habit Check-in')
      .addFields(
        { name: 'Member', value: name, inline: true },
        { name: 'Habit',  value: habit.name, inline: true },
        { name: 'Amount', value: `+${amount} pts${image ? ' (proof)' : ''}`, inline: true },
      )
      .setColor(0x5865F2)
      .setTimestamp());

    scheduleBoardRefresh();
    return {
      ok: true, amount, doneToday, scheduledToday: scheduledToday.length, shared, streak: s, wasCheckedIn: !!prior,
      msg: `✅ **${habit.name}** — +${amount} pts${image ? (prior ? ' for proof' : ' (+1 for proof)') : ''}` +
           `${s > 1 ? ` · 🔥 ${s} in a row` : ''}\nToday: **${doneToday}/${scheduledToday.length}** habits${shared}`,
    };
  }

  async function checkin(interaction) {
    const habits = habitsOf(interaction.user.id);
    if (!meetsMinimum(habits)) {
      return interaction.reply({
        content: `⚠️ Build your habit system first — ${MIN_EVOLUTION} Evolution + ${MIN_TRADING} Trading minimum.\n${minimumLine(habits)}`,
        flags: 64,
      });
    }
    const id = interaction.options.getString('habit');
    const habit = habits.find(h => h.id === id || h.name.toLowerCase() === String(id).toLowerCase());
    if (!habit) return interaction.reply({ content: '⚠️ Habit not found. Pick one from the list.', flags: 64 });
    const proof = interaction.options.getAttachment('proof');
    if (proof && !(proof.contentType || '').startsWith('image/')) {
      return interaction.reply({ content: '⚠️ Proof has to be an image.', flags: 64 });
    }
    const r = await recordCheckin(interaction.user, interaction.member, habit, proof, interaction.options.getString('note'));
    return interaction.reply({ content: r.ok && !proof ? `${r.msg}\n*Share proof for +1 more.*` : r.msg, flags: 64 });
  }

  // ── Week view helpers ─────────────────────────────────────────────────────
  // The member's current Monday→Sunday week, in his own timezone.
  function weekDays(userId) {
    const tz = getTimezone(userId);
    const today = localDay(tz);
    const mondayOffset = -((today.weekday + 6) % 7);
    return Array.from({ length: 7 }, (_, i) => ({ ...localDay(tz, mondayOffset + i), offset: mondayOffset + i }));
  }

  function dayCell(habits, logDay, day) {
    const scheduled = habits.filter(h => h.days.includes(day.weekday));
    if (!scheduled.length) return '➖';
    const done = scheduled.filter(h => logDay?.[h.id]).length;
    if (day.offset > 0) return '▫️';
    if (done === scheduled.length) return '✅';
    if (day.offset === 0) return done ? '🟡' : '⬜';
    return done ? '🟡' : '❌';
  }

  // Consecutive days (back from today) with every scheduled habit done.
  function dayStreak(userId, habits) {
    const log = load(CHECKINS_FILE)[userId] || {};
    const tz = getTimezone(userId);
    let run = 0;
    for (let back = 0; back < 400; back++) {
      const { date, weekday } = localDay(tz, -back);
      const scheduled = habits.filter(h => h.days.includes(weekday));
      if (!scheduled.length) continue;
      const all = scheduled.every(h => log[date]?.[h.id]);
      if (all) { run++; continue; }
      if (back === 0) continue;
      break;
    }
    return run;
  }

  async function renderWeekBoard(guild) {
    const all = load(HABITS_FILE);
    const log = load(CHECKINS_FILE);
    const rows = [];
    for (const [userId, rec] of Object.entries(all)) {
      if (isIgnored(userId) || !meetsMinimum(rec.habits || [])) continue;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      const days = weekDays(userId);
      let done = 0, total = 0;
      for (const d of days) {
        if (d.offset > 0) continue;
        const sched = rec.habits.filter(h => h.days.includes(d.weekday));
        total += sched.length;
        done += sched.filter(h => log[userId]?.[d.date]?.[h.id]).length;
      }
      const cells = days.map(d => dayCell(rec.habits, log[userId]?.[d.date], d)).join('');
      rows.push({ name: member.nickname || member.user.username, cells, done, total, streak: dayStreak(userId, rec.habits) });
    }
    rows.sort((a, b) => (b.total ? b.done / b.total : 0) - (a.total ? a.done / a.total : 0) || b.streak - a.streak);
    const body = rows.length
      ? rows.map(r => `${r.cells}  **${r.name}** · ${r.done}/${r.total}${r.streak ? ` · 🔥${r.streak}` : ''}`).join('\n').slice(0, 3900)
      : '*Nobody has built their habit system yet. Hit **➕ Add habit** above.*';
    return new EmbedBuilder()
      .setTitle('📅 THIS WEEK · WHO IS SHOWING UP')
      .setDescription('`M  T  W  T  F  S  S`\n' + body)
      .setColor(accent)
      .setFooter({ text: '✅ all done · 🟡 some · ❌ missed · ⬜ today, not yet · ▫️ ahead · ➖ nothing scheduled · 🔥 days in a row' })
      .setTimestamp();
  }

  function renderMyWeek(userId) {
    const habits = habitsOf(userId);
    const log = load(CHECKINS_FILE)[userId] || {};
    const days = weekDays(userId);
    const line = (h) => days.map(d => {
      if (!h.days.includes(d.weekday)) return '➖';
      const c = log[d.date]?.[h.id];
      if (d.offset > 0) return '▫️';
      if (c) return c.proof ? '📸' : '✅';
      return d.offset === 0 ? '⬜' : '❌';
    }).join('');
    const part = (p) => habits.filter(h => h.part === p).map(h => `${line(h)}  ${h.name}`).join('\n') || '*None yet*';
    return new EmbedBuilder()
      .setTitle('📋 YOUR WEEK')
      .setDescription(`${minimumLine(habits)}\n\`M  T  W  T  F  S  S\``)
      .addFields(
        { name: PARTS.evolution, value: part('evolution') },
        { name: PARTS.trading,   value: part('trading') },
      )
      .setColor(accent)
      .setFooter({ text: '✅ done · 📸 done with proof · ❌ missed · ⬜ today · ▫️ ahead · ➖ not scheduled' });
  }

  // ── The #habits panel (one static message + one live week board) ─────────
  const PANEL_FILE = path.join(dataDir, 'habit_panel.json');
  const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, LabelBuilder,
    TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, FileUploadBuilder,
  } = require('discord.js');

  function panelEmbed() {
    return new EmbedBuilder()
      .setTitle('🧭 YOUR HABIT SYSTEM')
      .setDescription(
        '*Your habits shape who you become. Build them, schedule them, knock them out — in front of the men beside you.*\n\n' +
        `**Build it:** at least **${MIN_EVOLUTION} 🧬 Evolution** habits (personal development) and **${MIN_TRADING} 📈 Trading** habit (your daily process), each on the days you do it.\n` +
        '**Live it:** hit **✅ Check in** every time you knock one out. **+1** per habit.\n' +
        `**Prove it:** post your photo in <#${channels.training}>, <#${channels.nutrition}>, <#${channels.tradeJournal}> or <#${channels.tradingReview}>. ` +
        'The Eye asks which habit it is — one tap, **+1 more**. Your post stays yours: replies reach you, and it stays in your journal.\n\n' +
        'Everything here is private to you except your proof and the week board below.'
      )
      .setColor(accent)
      .setFooter({ text: 'Build them. Schedule them. Knock them out.' });
  }

  function panelRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hb:checkin').setLabel('Check in').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('hb:add').setLabel('Add habit').setEmoji('➕').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('hb:edit').setLabel('Edit habits').setEmoji('🛠️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('hb:week').setLabel('My week').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    );
  }

  let guildRef = null;
  let refreshTimer = null;
  function scheduleBoardRefresh() {
    if (!guildRef || !channels.habits) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshBoard().catch(e => console.error('[habits] board refresh error:', e)), 3000);
  }

  async function refreshBoard() {
    const ch = client.channels.cache.get(channels.habits);
    const state = load(PANEL_FILE);
    if (!ch || !state.boardMsgId) return;
    const msg = await ch.messages.fetch(state.boardMsgId).catch(() => null);
    if (msg) await msg.edit({ embeds: [await renderWeekBoard(guildRef)] });
  }

  // Idempotent: posts the panel + board once, then only edits them in place.
  async function ensurePanel(guild) {
    guildRef = guild;
    const ch = client.channels.cache.get(channels.habits);
    if (!ch) { console.log('[habits] HABITS_CHANNEL_ID not set — panel dormant.'); return; }
    const state = load(PANEL_FILE);
    let panel = state.panelMsgId && await ch.messages.fetch(state.panelMsgId).catch(() => null);
    if (panel) await panel.edit({ embeds: [panelEmbed()], components: [panelRow()] });
    else {
      panel = await ch.send({ embeds: [panelEmbed()], components: [panelRow()] });
      await panel.pin().catch(() => {});
      state.panelMsgId = panel.id;
    }
    let board = state.boardMsgId && await ch.messages.fetch(state.boardMsgId).catch(() => null);
    if (board) await board.edit({ embeds: [await renderWeekBoard(guild)] });
    else {
      board = await ch.send({ embeds: [await renderWeekBoard(guild)] });
      state.boardMsgId = board.id;
    }
    save(PANEL_FILE, state);
    console.log(`[habits] Panel ready in #${ch.name} (panel ${state.panelMsgId}, board ${state.boardMsgId})`);
    // Roll the board over as days change (ticks are cheap: one edit).
    setInterval(() => refreshBoard().catch(() => {}), 10 * 60 * 1000);
  }

  // ── Panel components ──────────────────────────────────────────────────────
  const DAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map(d => ({ label: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d], value: String(d) }));

  function habitModal(customId, title, habit) {
    const name = new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(true)
      .setPlaceholder('e.g. 4:00 wake up · Cold shower · Pre-market process');
    if (habit) name.setValue(habit.name);
    const part = new StringSelectMenuBuilder().setCustomId('part').setMinValues(1).setMaxValues(1).addOptions(
      { label: 'Evolution (personal development)', value: 'evolution', emoji: '🧬', default: habit?.part === 'evolution' },
      { label: 'Trading (your daily process)',     value: 'trading',   emoji: '📈', default: habit?.part === 'trading' },
    );
    const days = new StringSelectMenuBuilder().setCustomId('days').setMinValues(1).setMaxValues(7)
      .setPlaceholder('Pick every day you do it')
      .addOptions(DAY_OPTIONS.map(o => ({ ...o, default: !!habit?.days.includes(Number(o.value)) })));
    return new ModalBuilder().setCustomId(customId).setTitle(title).addLabelComponents(
      new LabelBuilder().setLabel('Habit').setTextInputComponent(name),
      new LabelBuilder().setLabel('Part').setStringSelectMenuComponent(part),
      new LabelBuilder().setLabel('Days').setDescription('A habit only counts on the days you schedule it.').setStringSelectMenuComponent(days),
    );
  }

  function checkinView(userId) {
    const habits = habitsOf(userId);
    const { date, weekday } = localDay(getTimezone(userId));
    const done = load(CHECKINS_FILE)[userId]?.[date] || {};
    const today = habits.filter(h => h.days.includes(weekday)).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    const buttons = [];
    for (const h of today) {
      const c = done[h.id];
      buttons.push(new ButtonBuilder()
        .setCustomId(`hb:do:${h.id}`)
        .setLabel(`${h.time ? h.time + ' ' : ''}${h.name}`.slice(0, 70))
        .setEmoji(c ? '✅' : '⬜')
        .setStyle(c ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!!c));
    }
    const rows = [];
    for (let i = 0; i < Math.min(buttons.length, 25); i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    const doneCount = today.filter(h => done[h.id]).length;
    const content = today.length
      ? `**Today: ${doneCount}/${today.length}** — tap a habit when you've done it (+1).\n📸 **Proof:** post your photo in <#${channels.training}>, <#${channels.nutrition}>, <#${channels.tradeJournal}> or <#${channels.tradingReview}> — The Eye stamps it (+1).`
      : 'Nothing scheduled for you today. Rest is part of it.';
    return { content, components: rows };
  }

  function editPicker(userId) {
    const habits = habitsOf(userId);
    if (!habits.length) return { content: 'No habits yet — hit **➕ Add habit**.', components: [] };
    const menu = new StringSelectMenuBuilder().setCustomId('hbs:pick').setPlaceholder('Choose a habit to edit or remove')
      .addOptions(habits.slice(0, 25).map(h => ({
        label: h.name.slice(0, 100), value: h.id, emoji: h.part === 'evolution' ? '🧬' : '📈', description: formatDays(h.days),
      })));
    return { content: `${minimumLine(habits)}\nWhich habit?`, components: [new ActionRowBuilder().addComponents(menu)] };
  }

  async function handleComponent(interaction) {
    const id = interaction.customId || '';
    if (!id.startsWith('hb')) return false;
    const userId = interaction.user.id;
    const [kind, action, habitId] = id.split(':');

    // Buttons
    if (kind === 'hb' && interaction.isButton()) {
      if (action === 'add') {
        if (habitsOf(userId).length >= MAX_HABITS) {
          await interaction.reply({ content: `⚠️ You already have ${MAX_HABITS} habits. Core habits beat a long list.`, flags: 64 });
          return true;
        }
        await interaction.showModal(habitModal('hbm:add', 'Add a habit'));
        return true;
      }
      if (action === 'checkin') {
        const habits = habitsOf(userId);
        if (!meetsMinimum(habits)) {
          await interaction.reply({ content: `⚠️ Build your habit system first — ${MIN_EVOLUTION} 🧬 Evolution + ${MIN_TRADING} 📈 Trading minimum.\n${minimumLine(habits)}\nHit **➕ Add habit**.`, flags: 64 });
          return true;
        }
        await interaction.reply({ ...checkinView(userId), flags: 64 });
        return true;
      }
      if (action === 'edit') { await interaction.reply({ ...editPicker(userId), flags: 64 }); return true; }
      if (action === 'week') { await interaction.reply({ embeds: [renderMyWeek(userId)], flags: 64 }); return true; }
      if (action === 'do') {
        const habit = habitsOf(userId).find(h => h.id === habitId);
        if (!habit) { await interaction.update({ content: '⚠️ That habit no longer exists.', components: [] }); return true; }
        const r = await recordCheckin(interaction.user, interaction.member, habit, null, null);
        const view = checkinView(userId);
        await interaction.update({ content: `${r.msg}\n\n${view.content}`, components: view.components });
        return true;
      }
      if (action === 'proof') {
        const habit = habitsOf(userId).find(h => h.id === habitId);
        if (!habit) { await interaction.reply({ content: '⚠️ That habit no longer exists.', flags: 64 }); return true; }
        await interaction.showModal(new ModalBuilder().setCustomId(`hbm:proof:${habit.id}`).setTitle(`Proof: ${habit.name}`.slice(0, 45)).addLabelComponents(
          new LabelBuilder().setLabel('Photo proof').setDescription('Shared with the community for +1').setFileUploadComponent(
            new FileUploadBuilder().setCustomId('photo').setMinValues(1).setMaxValues(1).setRequired(true)),
          new LabelBuilder().setLabel('Note (optional)').setTextInputComponent(
            new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false)),
        ));
        return true;
      }
      if (action === 'editone') {
        const habit = habitsOf(userId).find(h => h.id === habitId);
        if (!habit) { await interaction.update({ content: '⚠️ That habit no longer exists.', components: [] }); return true; }
        await interaction.showModal(habitModal(`hbm:edit:${habit.id}`, 'Edit habit', habit));
        return true;
      }
      if (action === 'remove') {
        const habit = habitsOf(userId).find(h => h.id === habitId);
        if (!habit) { await interaction.update({ content: '⚠️ That habit no longer exists.', components: [] }); return true; }
        await interaction.update({
          content: `Remove **${habit.name}**? Its history stays; it just stops being scheduled.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`hb:removeyes:${habit.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('hb:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
          )],
        });
        return true;
      }
      if (action === 'removeyes') {
        const data = load(HABITS_FILE);
        const before = data[userId]?.habits || [];
        const habit = before.find(h => h.id === habitId);
        if (data[userId]) data[userId].habits = before.filter(h => h.id !== habitId);
        save(HABITS_FILE, data);
        scheduleBoardRefresh();
        const picker = editPicker(userId);
        await interaction.update({ content: `🗑️ Removed **${habit?.name || 'habit'}**.\n${picker.content}`, components: picker.components });
        return true;
      }
      if (action === 'back') { await interaction.update(editPicker(userId)); return true; }
      if (action === 'lab')  { await labLink(interaction); return true; }
      if (action === 'stamp' || action === 'stampx') { await handleStamp(interaction, action, habitId); return true; }
    }

    // Edit picker select
    if (kind === 'hbs' && interaction.isStringSelectMenu() && action === 'pick') {
      const habit = habitsOf(userId).find(h => h.id === interaction.values[0]);
      if (!habit) { await interaction.update({ content: '⚠️ That habit no longer exists.', components: [] }); return true; }
      await interaction.update({
        content: `${habit.part === 'evolution' ? '🧬' : '📈'} **${habit.name}** · ${formatDays(habit.days)}`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`hb:editone:${habit.id}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`hb:remove:${habit.id}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('hb:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
        )],
      });
      return true;
    }

    // Modals
    if (kind === 'hbm' && interaction.isModalSubmit()) {
      if (action === 'add' || action === 'edit') {
        const name = interaction.fields.getTextInputValue('name').trim();
        const part = interaction.fields.getStringSelectValues('part')[0];
        const days = interaction.fields.getStringSelectValues('days').map(Number).sort((a, b) => a - b);
        const data = load(HABITS_FILE);
        const habits = data[userId]?.habits || [];
        if (habits.some(h => h.name.toLowerCase() === name.toLowerCase() && h.id !== habitId)) {
          await interaction.reply({ content: `⚠️ You already have a habit called **${name}**.`, flags: 64 });
          return true;
        }
        let verb = 'Added';
        if (action === 'edit') {
          const h = habits.find(x => x.id === habitId);
          if (!h) { await interaction.reply({ content: '⚠️ That habit no longer exists.', flags: 64 }); return true; }
          Object.assign(h, { name, part, days });
          verb = 'Updated';
        } else {
          if (habits.length >= MAX_HABITS) { await interaction.reply({ content: `⚠️ You already have ${MAX_HABITS} habits.`, flags: 64 }); return true; }
          habits.push({ id: Math.random().toString(36).slice(2, 9), name, part, days });
        }
        data[userId] = { ...(data[userId] || {}), habits };
        save(HABITS_FILE, data);
        scheduleBoardRefresh();
        const ready = meetsMinimum(habits);
        await interaction.reply({
          content: `✅ ${verb} **${name}** — ${PARTS[part]} · ${formatDays(days)}\n${minimumLine(habits)}\n` +
            (ready ? 'Your habit system is set. Hit **✅ Check in** every time you knock one out.'
                   : `Keep building: ${MIN_EVOLUTION} 🧬 Evolution + ${MIN_TRADING} 📈 Trading to unlock check-ins.`),
          flags: 64,
        });
        return true;
      }
      if (action === 'proof') {
        const habit = habitsOf(userId).find(h => h.id === habitId);
        const files = interaction.fields.getUploadedFiles('photo');
        const image = files?.first?.();
        if (!habit) { await interaction.reply({ content: '⚠️ That habit no longer exists.', flags: 64 }); return true; }
        if (!image || !(image.contentType || '').startsWith('image/')) {
          await interaction.reply({ content: '⚠️ Proof has to be an image.', flags: 64 });
          return true;
        }
        const note = interaction.fields.getTextInputValue('note') || null;
        const r = await recordCheckin(interaction.user, interaction.member, habit, image, note);
        await interaction.reply({ content: r.msg, flags: 64 });
        return true;
      }
    }
    return false;
  }

  async function showBoard(interaction) {
    return interaction.reply({ embeds: [await renderWeekBoard(interaction.guild)], flags: 64 });
  }

  // Replaces the old daily #leaderboard post: the #habits week board is live.
  function startBoard(guild) {
    ensurePanel(guild).catch(e => console.error('[habits] panel error:', e));
    ensureLab().catch(e => console.error('[habits] lab error:', e));
  }

  // ── Proof stamping: the member posts, The Eye stamps ──────────────────────
  // A NEW post with an image in one of the four proof channels gets a reply:
  // "Which habit is this?" (only the author can tap). The member's own message
  // stays the proof — replies to it notify him, and `from:@him` keeps his
  // journal searchable. Text-only discussion and replies never trigger anything.
  const pendingStamps = new Map(); // pickerMessageId -> { userId, postUrl, part }
  const STAMP_TTL_MS = 15 * 60 * 1000;

  function proofChannelPart(channelId) {
    if (channelId === channels.training || channelId === channels.nutrition) return 'evolution';
    if (channelId === channels.tradeJournal || channelId === channels.tradingReview) return 'trading';
    return null;
  }

  function stampCandidates(userId, part) {
    const { date, weekday } = localDay(getTimezone(userId));
    const done = load(CHECKINS_FILE)[userId]?.[date] || {};
    const open = habitsOf(userId).filter(h => h.days.includes(weekday) && !done[h.id]?.proof);
    const inPart = open.filter(h => h.part === part);
    return (inPart.length ? inPart : open).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  }

  async function handleMessage(message) {
    if (message.author?.bot || !message.guild) return;
    const part = proofChannelPart(message.channel.id);
    if (!part || message.reference || message.channel.isThread?.()) return;
    const hasImage = [...message.attachments.values()].some(a => (a.contentType || '').startsWith('image/'));
    if (!hasImage) return;
    const userId = message.author.id;
    if (isIgnored(userId) || !meetsMinimum(habitsOf(userId))) return;
    const candidates = stampCandidates(userId, part);
    if (!candidates.length) return;

    const buttons = candidates.slice(0, 19).map(h => new ButtonBuilder()
      .setCustomId(`hb:stamp:${h.id}`)
      .setLabel(`${h.time ? h.time + ' ' : ''}${h.name}`.slice(0, 70))
      .setEmoji(h.part === 'evolution' ? '🧬' : '📈')
      .setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setCustomId('hb:stampx').setLabel('Not a habit').setEmoji('✖️').setStyle(ButtonStyle.Danger));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));

    const picker = await message.reply({
      content: `<@${userId}> which habit is this proof for?`,
      components: rows,
      allowedMentions: { parse: [] },
    }).catch(e => { console.error('[habits] stamp picker failed:', e.message); return null; });
    if (!picker) return;
    pendingStamps.set(picker.id, { userId, postUrl: message.url, part, imageUrl: [...message.attachments.values()][0].url });
    setTimeout(async () => {
      if (!pendingStamps.has(picker.id)) return;
      pendingStamps.delete(picker.id);
      await picker.delete().catch(() => {});
    }, STAMP_TTL_MS).unref?.();
  }

  async function handleStamp(interaction, action, habitId) {
    const pending = pendingStamps.get(interaction.message.id);
    if (!pending) {
      await interaction.reply({ content: 'This picker expired — post the photo again to stamp it.', flags: 64 });
      return;
    }
    if (interaction.user.id !== pending.userId) {
      await interaction.reply({ content: `Only <@${pending.userId}> can stamp this one.`, flags: 64, allowedMentions: { parse: [] } });
      return;
    }
    if (action === 'stampx') {
      pendingStamps.delete(interaction.message.id);
      await interaction.message.delete().catch(() => {});
      await interaction.reply({ content: 'Got it — not logged.', flags: 64 });
      return;
    }
    const habit = habitsOf(pending.userId).find(h => h.id === habitId);
    if (!habit) { await interaction.reply({ content: '⚠️ That habit no longer exists.', flags: 64 }); return; }
    const r = await recordCheckin(interaction.user, interaction.member, habit, { url: pending.imageUrl }, null, { proofUrl: pending.postUrl });
    if (!r.ok) { await interaction.reply({ content: r.msg, flags: 64 }); return; }
    pendingStamps.delete(interaction.message.id);
    const card = new EmbedBuilder()
      .setTitle(`${habit.part === 'evolution' ? '🧬' : '📈'} ${habit.name}${r.streak > 1 ? ` · 🔥${r.streak}` : ''}`)
      .setDescription(`**+${r.amount} pts**${r.wasCheckedIn ? ' · proof' : ' · check-in + proof'} · **${r.doneToday}/${r.scheduledToday}** today`)
      .setColor(accent)
      .setFooter({ text: 'Stamped by The Eye' })
      .setTimestamp();
    await interaction.update({ content: `<@${pending.userId}>`, embeds: [card], components: [], allowedMentions: { parse: [] } });
  }

  // ── Schedule lab: calendar builder on the web (lib/schedule-web.js) ──────
  // Habits may carry an optional time ('HH:MM') + minutes so they sit on a
  // calendar. Everything else (check-ins, board) ignores them.
  const crypto = require('crypto');
  const LAB_FILE = path.join(dataDir, 'habit_lab.json');

  function signLink(userId, ttlMs = 24 * 60 * 60 * 1000) {
    const exp = Date.now() + ttlMs;
    const body = Buffer.from(`${userId}.${exp}`).toString('base64url');
    const sig = crypto.createHmac('sha256', deps.linkSecret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }
  function verifyLink(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !deps.linkSecret) return null;
    const want = crypto.createHmac('sha256', deps.linkSecret).update(body).digest('base64url');
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    const [userId, exp] = Buffer.from(body, 'base64url').toString().split('.');
    return Number(exp) > Date.now() ? userId : null;
  }

  // Validates + saves a full habit list from the calendar. Existing ids keep
  // their check-in history; anything else gets a fresh id.
  function setHabitsFromCalendar(userId, incoming) {
    if (!Array.isArray(incoming) || incoming.length > MAX_HABITS) return { error: `Up to ${MAX_HABITS} habits.` };
    const current = habitsOf(userId);
    const known = new Set(current.map(h => h.id));
    const clean = [];
    for (const h of incoming) {
      const name = String(h?.name || '').trim().slice(0, 60);
      const part = h?.part === 'trading' ? 'trading' : h?.part === 'evolution' ? 'evolution' : null;
      const days = [...new Set((h?.days || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
      if (!name || !part || !days.length) return { error: 'Every habit needs a name, a part and at least one day.' };
      if (clean.some(c => c.name.toLowerCase() === name.toLowerCase())) return { error: `Two habits are called "${name}".` };
      const habit = { id: known.has(h.id) ? h.id : Math.random().toString(36).slice(2, 9), name, part, days };
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(h?.time || '')) {
        habit.time = h.time;
        habit.minutes = Math.min(240, Math.max(5, Number(h.minutes) || 30));
      }
      clean.push(habit);
    }
    const data = load(HABITS_FILE);
    data[userId] = { ...(data[userId] || {}), habits: clean };
    save(HABITS_FILE, data);
    scheduleBoardRefresh();
    return { habits: clean };
  }

  function labEmbed() {
    return new EmbedBuilder()
      .setTitle('🗓️ SCHEDULE BUILDER (LAB)')
      .setDescription(
        '*Testing a calendar way to build your habit system.*\n\n' +
        'Hit **Open schedule builder** for your private link (valid 24h). You get a week calendar:\n' +
        '• **Click a time slot** to drop a habit in\n' +
        '• **Drag a habit** to move it\n' +
        '• **Click a habit** to edit or delete it\n\n' +
        'It saves into the same habit system as #habits. Check-ins and the week board pick it up straight away.'
      )
      .setColor(accent);
  }

  async function ensureLab() {
    const ch = client.channels.cache.get(channels.lab);
    if (!ch) return;
    const state = load(LAB_FILE);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hb:lab').setLabel('Open schedule builder').setEmoji('🗓️').setStyle(ButtonStyle.Primary));
    let msg = state.msgId && await ch.messages.fetch(state.msgId).catch(() => null);
    if (msg) await msg.edit({ embeds: [labEmbed()], components: [row] });
    else { msg = await ch.send({ embeds: [labEmbed()], components: [row] }); state.msgId = msg.id; save(LAB_FILE, state); }
    console.log(`[habits] Schedule lab ready in #${ch.name}`);
  }

  async function labLink(interaction) {
    if (!deps.publicUrl || !deps.linkSecret) {
      await interaction.reply({ content: '⚠️ The schedule builder is not configured yet.', flags: 64 });
      return;
    }
    const url = `https://${deps.publicUrl}/schedule?t=${signLink(interaction.user.id)}`;
    await interaction.reply({
      content: "🗓️ Your private schedule builder — **don't share this link**, it edits your habits. Valid 24h.",
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open schedule builder').setURL(url))],
      flags: 64,
    });
  }

  return {
    commands, handleCommand, handleAutocomplete, handleComponent, handleMessage, startBoard, MIN_EVOLUTION, MIN_TRADING,
    // used by lib/schedule-web.js
    verifyLink, getHabits: habitsOf, setHabitsFromCalendar, MAX_HABITS,
  };
};
