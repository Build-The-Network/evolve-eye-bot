'use strict';
/**
 * lib/admin-api.js
 * Express router providing authenticated admin HTTP endpoints for The Eye bot.
 *
 * Mount in index.js:
 *   const { createAdminRouter } = require('./lib/admin-api');
 *   app.use('/admin', createAdminRouter(client, { GUILD_ID, ADMIN_TOKEN }));
 */

const express  = require('express');
const { ChannelType, EmbedBuilder } = require('discord.js');
const { reconcile, dumpConfig } = require('./reconciler');
const fs = require('fs');
const path = require('path');

function loadProtectedIds() {
  try {
    const f = path.join(__dirname, '..', '.protected-ids');
    if (fs.existsSync(f)) {
      return new Set(fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
    }
  } catch (_) {}
  return new Set();
}

function createAdminRouter(client, opts = {}) {
  const {
    GUILD_ID, ADMIN_TOKEN,
    dataDir,
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
    // Chopping Block — read-only for tier roles (special case in apply-lockdown)
    CHOPPING_BLOCK_CHANNEL_ID,
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
    // Test-only hooks (staging gate enforced per-endpoint)
    runMidnightTasks,
    schedulerHooks,
    fireEventsReminder,
    runScheduledReminders,
    choppingBlockEnsureListEmbeds, // Phase 5 backfill: seed the two list embeds
  } = opts;

  // Tier roles that should have full channel access (Prospect and above)
  const TIER_ROLE_IDS = [
    PROSPECT_ROLE_ID,
    MEMBER_ROLE_ID,
    VETERAN_ROLE_ID,
    ELITE_ROLE_ID,
    TOP_ROLE_ID,
  ].filter(Boolean);

  // Channel IDs that are always protected from deletion regardless of config.
  // Rebuilt per-router from opts so the same code can run against any guild.
  const CORE_PROTECTED_IDS = new Set([
    WELCOME_CHANNEL_ID,
    RULES_CHANNEL_ID,
    ANNOUNCEMENTS_CHANNEL_ID,
    EVENTS_CHANNEL_ID,
    ACCOUNTABILITY_CHANNEL_ID,
    LEADERBOARD_CHANNEL_ID,
    VOTE_CHANNEL_ID,
    WORLD_CLOCK_CHANNEL_ID,
  ]);

  // Admin/log channels — skipped entirely by apply-lockdown and
  // apply-voice-permissions (bot-only, don't touch their overwrites).
  // Built once and shared between the two endpoints that previously each
  // declared their own identical copy.
  const ADMIN_LOG_SKIP_IDS = new Set([
    LOG_COMMANDS_ID,
    LOG_MEMBERS_ID,
    LOG_INACTIVITY_ID,
    LOG_ACCOUNTABILITY_ID,
    LOG_ROLES_ID,
    LOG_POINTS_AUDIT_ID,
    LOG_DELETED_MESSAGES_ID,
  ]);

  // Single source of truth for points.json path — used by 5 handlers below.
  // Hoisted from previously-duplicated per-handler declarations (no behavioral
  // change: each handler still does its own fresh fs read/write).
  const POINTS_FILE = path.join(dataDir, 'points.json');

  const router = express.Router();

  // ── Auth middleware ──────────────────────────────────────────────────────────
  router.use((req, res, next) => {
    const auth = req.headers['authorization'] || '';
    if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // Helper: get guild or return 503
  function guild(res) {
    const g = client.guilds.cache.get(GUILD_ID);
    if (!g) { res.status(503).json({ error: 'Guild not cached — bot may still be starting' }); return null; }
    return g;
  }

  // Helper: combined protected IDs (core + .protected-ids file)
  function protectedIds() {
    return new Set([...CORE_PROTECTED_IDS, ...loadProtectedIds()]);
  }

  // ── GET /admin/health ────────────────────────────────────────────────────────
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      bot: client.user?.tag || 'starting',
      uptime: Math.floor(process.uptime()),
      ready: client.isReady(),
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CHANNELS
  // ════════════════════════════════════════════════════════════════════════════

  // GET /admin/channels
  router.get('/channels', (req, res) => {
    const g = guild(res); if (!g) return;
    const pid = protectedIds();
    const list = [...g.channels.cache.values()]
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
      .map(ch => ({
        id:        ch.id,
        name:      ch.name,
        type:      ch.type,
        topic:     ch.topic || null,
        parentId:  ch.parentId || null,
        position:  ch.rawPosition ?? 0,
        protected: pid.has(ch.id),
      }));
    res.json(list);
  });

  // GET /admin/channels/:id
  router.get('/channels/:id', (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    res.json({
      id: ch.id, name: ch.name, type: ch.type,
      topic: ch.topic || null, parentId: ch.parentId || null,
      position: ch.rawPosition ?? 0, protected: protectedIds().has(ch.id),
    });
  });

  // PATCH /admin/channels/:id  { name?, topic?, position?, parentId? }
  router.patch('/channels/:id', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    const { name, topic, position, parentId } = req.body;
    const edits = {};
    if (name     !== undefined) edits.name     = name;
    if (topic    !== undefined) edits.topic    = topic;
    if (position !== undefined) edits.position = position;
    if (parentId !== undefined) edits.parent   = parentId;
    if (!Object.keys(edits).length) return res.status(400).json({ error: 'No fields to update' });
    try {
      const up = await ch.edit(edits);
      console.log(`[admin-api] PATCH channel "${ch.name}" →`, edits);
      res.json({ id: up.id, name: up.name, topic: up.topic || null, position: up.rawPosition ?? 0, parentId: up.parentId || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/channels  { name, type?, parentId?, topic?, position? }
  router.post('/channels', async (req, res) => {
    const g = guild(res); if (!g) return;
    const { name, type = ChannelType.GuildText, parentId, topic, position } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const opts = { name, type };
    if (parentId !== undefined) opts.parent   = parentId;
    if (topic    !== undefined) opts.topic    = topic;
    if (position !== undefined) opts.position = position;
    try {
      const ch = await g.channels.create(opts);
      console.log(`[admin-api] POST channel created: "${ch.name}" (${ch.id})`);
      res.status(201).json({ id: ch.id, name: ch.name, type: ch.type, topic: ch.topic || null, parentId: ch.parentId || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /admin/channels/:id
  router.delete('/channels/:id', async (req, res) => {
    const g = guild(res); if (!g) return;
    const id = req.params.id;
    if (protectedIds().has(id)) return res.status(400).json({ error: 'Channel is protected from deletion' });
    const ch = g.channels.cache.get(id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try {
      await ch.delete('Deleted via admin API');
      console.log(`[admin-api] DELETE channel "${ch.name}" (${id})`);
      res.json({ deleted: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // MESSAGES
  // ════════════════════════════════════════════════════════════════════════════

  // POST /admin/channels/:id/messages  { content?, embeds? }
  router.post('/channels/:id/messages', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    const { content, embeds } = req.body;
    if (!content && (!embeds || !embeds.length)) return res.status(400).json({ error: 'content or embeds required' });
    const payload = {};
    if (content)             payload.content = content;
    if (embeds?.length)      payload.embeds  = embeds;   // raw embed data, discord.js accepts this
    try {
      const msg = await ch.send(payload);
      console.log(`[admin-api] POST message in #${ch.name}: ${msg.id}`);
      res.status(201).json({ id: msg.id, channelId: ch.id, content: msg.content || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /admin/messages/:channelId/:messageId  { content?, embeds? }
  router.patch('/messages/:channelId/:messageId', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try {
      const msg = await ch.messages.fetch(req.params.messageId);
      if (msg.author.id !== client.user.id) return res.status(403).json({ error: 'Can only edit messages the bot sent' });
      const { content, embeds } = req.body;
      const payload = {};
      if (content !== undefined) payload.content = content;
      if (embeds?.length)        payload.embeds  = embeds;
      const up = await msg.edit(payload);
      res.json({ id: up.id, content: up.content || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /admin/messages/:channelId/:messageId
  router.delete('/messages/:channelId/:messageId', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try {
      const msg = await ch.messages.fetch(req.params.messageId);
      await msg.delete();
      console.log(`[admin-api] DELETE message ${req.params.messageId} in #${ch.name}`);
      res.json({ deleted: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /admin/messages/pinned/:channelId
  router.get('/messages/pinned/:channelId', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try {
      const pins = await ch.messages.fetchPinned();
      res.json(pins.map(m => ({ id: m.id, author: m.author?.tag, createdAt: m.createdAt, content: m.content?.slice(0, 100) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/messages/:channelId/:messageId/pin
  router.post('/messages/:channelId/:messageId/pin', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try {
      const msg = await ch.messages.fetch(req.params.messageId);
      await msg.pin();
      console.log(`[admin-api] PIN message ${req.params.messageId} in #${ch.name}`);
      res.json({ pinned: true, id: msg.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /admin/messages/:channelId/:messageId/pin
  router.delete('/messages/:channelId/:messageId/pin', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(req.params.channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try {
      const msg = await ch.messages.fetch(req.params.messageId);
      await msg.unpin();
      console.log(`[admin-api] UNPIN message ${req.params.messageId} in #${ch.name}`);
      res.json({ unpinned: true, id: msg.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ROLES
  // ════════════════════════════════════════════════════════════════════════════

  // GET /admin/roles
  router.get('/roles', (req, res) => {
    const g = guild(res); if (!g) return;
    const list = [...g.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .map(r => ({
        id:          r.id,
        name:        r.name,
        color:       r.hexColor,
        position:    r.position,
        permissions: r.permissions.toArray(),
        mentionable: r.mentionable,
        hoist:       r.hoist,
        managed:     r.managed,
      }));
    res.json(list);
  });

  // PATCH /admin/roles/:id  { name?, color?, position?, permissions?, mentionable?, hoist? }
  router.patch('/roles/:id', async (req, res) => {
    const g = guild(res); if (!g) return;
    const role = g.roles.cache.get(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.id === g.id) return res.status(400).json({ error: 'Cannot modify @everyone' });
    const { name, color, position, permissions, mentionable, hoist } = req.body;
    const edits = {};
    if (name        !== undefined) edits.name        = name;
    if (color       !== undefined) edits.color       = color;
    if (position    !== undefined) edits.position    = position;
    if (permissions !== undefined) edits.permissions = permissions;
    if (mentionable !== undefined) edits.mentionable = mentionable;
    if (hoist       !== undefined) edits.hoist       = hoist;
    if (!Object.keys(edits).length) return res.status(400).json({ error: 'No fields to update' });
    try {
      const up = await role.edit(edits);
      console.log(`[admin-api] PATCH role "${role.name}" →`, edits);
      res.json({ id: up.id, name: up.name, color: up.hexColor, position: up.position, mentionable: up.mentionable, hoist: up.hoist });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/roles  { name, color?, permissions?, mentionable?, hoist? }
  router.post('/roles', async (req, res) => {
    const g = guild(res); if (!g) return;
    const { name, color, permissions, mentionable, hoist } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const role = await g.roles.create({ name, color, permissions, mentionable, hoist });
      console.log(`[admin-api] POST role created: "${role.name}" (${role.id})`);
      res.status(201).json({ id: role.id, name: role.name, color: role.hexColor, position: role.position });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /admin/roles/:id
  router.delete('/roles/:id', async (req, res) => {
    const g = guild(res); if (!g) return;
    const role = g.roles.cache.get(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.id === g.id)  return res.status(400).json({ error: 'Cannot delete @everyone' });
    if (role.managed)       return res.status(400).json({ error: 'Cannot delete a bot-managed role' });
    const safe = role.permissions.toArray();
    if (safe.includes('Administrator') || safe.includes('ManageGuild') || safe.includes('ManageRoles')) {
      return res.status(400).json({ error: 'Cannot delete a role with Administrator / ManageGuild / ManageRoles permission' });
    }
    try {
      await role.delete('Deleted via admin API');
      console.log(`[admin-api] DELETE role "${role.name}" (${req.params.id})`);
      res.json({ deleted: true, id: req.params.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CONFIG / RECONCILIATION
  // ════════════════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════════════════
  // POINTS (read-only — writes go through the bot's own point system)
  // ════════════════════════════════════════════════════════════════════════════

  // GET /admin/points/:userId
  router.get('/points/:userId', (req, res) => {
    try {
      if (!fs.existsSync(POINTS_FILE)) return res.json({ allTime: 0, weekly: 0, daily: 0, lastPost: {}, inactive: false });
      const data = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
      const user = data[req.params.userId] || { allTime: 0, weekly: 0, daily: 0, lastPost: {}, inactive: false };
      res.json(user);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /admin/points  (all users snapshot)
  router.get('/points', (req, res) => {
    try {
      if (!fs.existsSync(POINTS_FILE)) return res.json({});
      res.json(JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8')));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /admin/points/:userId  — remove a user's entry from points.json
  router.delete('/points/:userId', (req, res) => {
    try {
      if (!fs.existsSync(POINTS_FILE)) return res.status(404).json({ error: 'points.json not found' });
      const data = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
      const userId = req.params.userId;
      if (!data[userId]) return res.status(404).json({ error: 'User not found in points.json' });
      delete data[userId];
      fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2));
      console.log(`[admin-api] DELETE points/${userId}`);
      res.json({ deleted: true, userId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/points/cleanup  — remove all entries with inactive:true AND allTime:0
  router.post('/points/cleanup', (req, res) => {
    try {
      if (!fs.existsSync(POINTS_FILE)) return res.status(404).json({ error: 'points.json not found' });
      const data = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
      const removed = [];
      for (const [id, entry] of Object.entries(data)) {
        if (entry.inactive === true && entry.allTime === 0) {
          removed.push(id);
          delete data[id];
        }
      }
      fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2));
      console.log(`[admin-api] POST points/cleanup — removed ${removed.length} entries: ${removed.join(', ')}`);
      res.json({ cleaned: removed.length, removedIds: removed });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/points/reset-onboarding/:userId
  // Resets a member's onboarding state to PENDING and removes intermediate roles
  router.post('/points/reset-onboarding/:userId', async (req, res) => {
    const g = guild(res); if (!g) return;
    try {
      const userId = req.params.userId;
      const data = fs.existsSync(POINTS_FILE) ? JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8')) : {};
      if (!data[userId]) data[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {} };
      data[userId].onboardingState = 'PENDING';
      fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2));

      // Fix roles: remove intermediate onboarding roles, ensure PENDING_ROLE
      const member = await g.members.fetch(userId).catch(() => null);
      if (member) {
        for (const rid of [AGREED_ROLE_ID, TIMEZONE_SET_ROLE_ID, ACCOUNTABILITY_SET_ROLE_ID].filter(Boolean)) {
          if (member.roles.cache.has(rid)) await member.roles.remove(rid).catch(() => {});
        }
        if (PENDING_ROLE_ID && !member.roles.cache.has(PENDING_ROLE_ID)) {
          await member.roles.add(PENDING_ROLE_ID).catch(() => {});
        }
      }

      console.log(`[admin-api] POST points/reset-onboarding/${userId}`);
      res.json({ ok: true, userId, onboardingState: 'PENDING', memberFound: !!member });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/members/:userId/roles/:roleId
  // Additively grants a role to a guild member. Used for ops bootstraps such as
  // restoring the network tester bot's PROSPECT_ROLE on staging.
  router.post('/members/:userId/roles/:roleId', async (req, res) => {
    const g = guild(res); if (!g) return;
    try {
      const { userId, roleId } = req.params;
      const role = g.roles.cache.get(roleId);
      if (!role) return res.status(404).json({ error: 'Role not found' });
      const member = await g.members.fetch(userId).catch(() => null);
      if (!member) return res.status(404).json({ error: 'Member not found in guild' });
      if (member.roles.cache.has(roleId)) {
        console.log(`[admin-api] POST members/${userId}/roles/${roleId} — already has "${role.name}"`);
        return res.json({ ok: true, userId, roleId, roleName: role.name, alreadyHadRole: true });
      }
      await member.roles.add(roleId, 'Granted via admin API');
      console.log(`[admin-api] POST members/${userId}/roles/${roleId} — added "${role.name}"`);
      res.json({ ok: true, userId, roleId, roleName: role.name, alreadyHadRole: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/permissions/apply-lockdown
  // Locks channels so only Prospect+ can see/use them; PENDING_ROLE sees #rules only.
  router.post('/permissions/apply-lockdown', async (req, res) => {
    const g = guild(res); if (!g) return;
    const { dryRun = false } = req.body || {};

    const SKIP_CHANNEL_IDS = ADMIN_LOG_SKIP_IDS;

    const results = { applied: [], skipped: [], errors: [] };

    const textChannels = g.channels.cache.filter(ch =>
      ch.isTextBased() && !ch.isThread() && !SKIP_CHANNEL_IDS.has(ch.id)
    );

    for (const [id, ch] of textChannels) {
      try {
        const isRules         = id === RULES_CHANNEL_ID;
        const isChoppingBlock = CHOPPING_BLOCK_CHANNEL_ID && id === CHOPPING_BLOCK_CHANNEL_ID;
        const channelType = isRules ? 'rules'
                          : isChoppingBlock ? 'chopping-block-readonly'
                          : 'member-only';

        if (dryRun) {
          results.applied.push({ id, name: ch.name, type: channelType });
          continue;
        }

        if (isRules) {
          // #rules: @everyone can VIEW but not SEND; Prospect+ can VIEW+SEND
          await ch.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: true, SendMessages: false });
          for (const rid of TIER_ROLE_IDS) {
            const role = g.roles.cache.get(rid);
            if (role) await ch.permissionOverwrites.edit(role, { ViewChannel: true, SendMessages: true });
          }
        } else if (isChoppingBlock) {
          // #callouts: tier roles can VIEW but NOT SEND — bot-only posts.
          // @everyone stays denied (default for non-rules channels).
          await ch.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: false });
          for (const rid of TIER_ROLE_IDS) {
            const role = g.roles.cache.get(rid);
            if (role) await ch.permissionOverwrites.edit(role, { ViewChannel: true, SendMessages: false });
          }
        } else {
          // All other channels: deny @everyone ViewChannel; allow tier roles VIEW+SEND
          await ch.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: false });
          for (const rid of TIER_ROLE_IDS) {
            const role = g.roles.cache.get(rid);
            if (role) await ch.permissionOverwrites.edit(role, { ViewChannel: true, SendMessages: true });
          }
        }

        results.applied.push({ id, name: ch.name, type: channelType });
      } catch (e) {
        const errDetail = { id, name: ch.name, error: e.message, code: e.code, status: e.status };
        console.error(`[lockdown] FAILED #${ch.name} (${id}):`, e.message, '| code:', e.code, '| status:', e.status);
        results.errors.push(errDetail);
      }
    }

    // ── Voice channels ────────────────────────────────────────────────────────
    // apply-lockdown was previously text-only; voice channels need ViewChannel +
    // Connect + Speak + UseVAD so tier roles can actually join #war-room etc.
    const voiceChannels = g.channels.cache.filter(ch =>
      ch.type === ChannelType.GuildVoice && !SKIP_CHANNEL_IDS.has(ch.id)
    );

    for (const [id, ch] of voiceChannels) {
      try {
        if (dryRun) {
          results.applied.push({ id, name: ch.name, type: 'voice' });
          continue;
        }

        // @everyone: no visibility, no connect
        await ch.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: false, Connect: false });
        // tier roles (Prospect and above): full voice access
        for (const rid of TIER_ROLE_IDS) {
          const role = g.roles.cache.get(rid);
          if (role) await ch.permissionOverwrites.edit(role, {
            ViewChannel: true,
            Connect:     true,
            Speak:       true,
            UseVAD:      true,
            Stream:      true,
          });
        }

        results.applied.push({ id, name: ch.name, type: 'voice' });
      } catch (e) {
        const errDetail = { id, name: ch.name, error: e.message, code: e.code, status: e.status };
        console.error(`[lockdown] FAILED voice #${ch.name} (${id}):`, e.message, '| code:', e.code, '| status:', e.status);
        results.errors.push(errDetail);
      }
    }

    console.log(`[admin-api] POST permissions/apply-lockdown — text=${textChannels.size} voice=${voiceChannels.size} applied=${results.applied.length} errors=${results.errors.length}`);
    res.json({ ok: results.errors.length === 0, dryRun, ...results });
  });

  // POST /admin/permissions/apply-voice-permissions
  // Standalone endpoint: grant ViewChannel+Connect+Speak+UseVAD+Stream to all
  // tier roles on every voice channel. Run this after any apply-lockdown that
  // may have skipped voice channels, or whenever voice perms drift.
  router.post('/permissions/apply-voice-permissions', async (req, res) => {
    const g = guild(res); if (!g) return;
    const { dryRun = false } = req.body || {};

    const SKIP_IDS = ADMIN_LOG_SKIP_IDS;

    const voiceChannels = g.channels.cache.filter(ch =>
      ch.type === ChannelType.GuildVoice && !SKIP_IDS.has(ch.id)
    );

    const results = { applied: [], errors: [] };

    for (const [id, ch] of voiceChannels) {
      try {
        if (dryRun) {
          results.applied.push({ id, name: ch.name });
          continue;
        }

        // @everyone: no visibility, no connect
        await ch.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: false, Connect: false });
        // tier roles: full voice access
        for (const rid of TIER_ROLE_IDS) {
          const role = g.roles.cache.get(rid);
          if (role) await ch.permissionOverwrites.edit(role, {
            ViewChannel: true,
            Connect:     true,
            Speak:       true,
            UseVAD:      true,
            Stream:      true,
          });
        }

        results.applied.push({ id, name: ch.name });
        console.log(`[voice-perms] Applied to #${ch.name} (${id}) — roles: ${TIER_ROLE_IDS.filter(Boolean).length}`);
      } catch (e) {
        const errDetail = { id, name: ch.name, error: e.message, code: e.code, status: e.status };
        console.error(`[voice-perms] FAILED #${ch.name} (${id}):`, e.message, '| code:', e.code, '| status:', e.status);
        results.errors.push(errDetail);
      }
    }

    console.log(`[admin-api] POST permissions/apply-voice-permissions — voice=${voiceChannels.size} applied=${results.applied.length} errors=${results.errors.length}`);
    res.json({ ok: results.errors.length === 0, dryRun, voiceChannelCount: voiceChannels.size, ...results });
  });

  // POST /admin/permissions/apply-inner-circle  { channelId }
  // Sets Inner Circle work block permissions: @everyone + Prospect/Member/Veteran = DENY,
  // Elite + Proven = ALLOW ViewChannel+Connect+Speak+UseVAD+Stream.
  router.post('/permissions/apply-inner-circle', async (req, res) => {
    const g = guild(res); if (!g) return;
    const { channelId, dryRun = false } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const ch = g.channels.cache.get(channelId);
    if (!ch) return res.status(404).json({ error: `Channel ${channelId} not found` });

    // Roles that should be EXPLICITLY DENIED (even if tier hierarchy might inherit allow)
    const DENY_ROLE_IDS = [
      PROSPECT_ROLE_ID,
      MEMBER_ROLE_ID,
      VETERAN_ROLE_ID,
    ].filter(Boolean);

    // Roles that get FULL voice access
    const ALLOW_ROLE_IDS = [
      ELITE_ROLE_ID,
      TOP_ROLE_ID,
    ].filter(Boolean);

    if (dryRun) {
      return res.json({
        ok: true, dryRun: true, channelId, channelName: ch.name,
        deny: DENY_ROLE_IDS, allow: ALLOW_ROLE_IDS,
      });
    }

    try {
      // @everyone: deny everything
      await ch.permissionOverwrites.edit(g.roles.everyone, { ViewChannel: false, Connect: false });

      // Prospect / Member / Veteran: explicitly deny (no ambiguity)
      for (const rid of DENY_ROLE_IDS) {
        const role = g.roles.cache.get(rid);
        if (role) await ch.permissionOverwrites.edit(role, { ViewChannel: false, Connect: false });
      }

      // Elite / Proven: full voice access
      for (const rid of ALLOW_ROLE_IDS) {
        const role = g.roles.cache.get(rid);
        if (role) await ch.permissionOverwrites.edit(role, {
          ViewChannel: true,
          Connect:     true,
          Speak:       true,
          UseVAD:      true,
          Stream:      true,
        });
      }

      console.log(`[inner-circle] Permissions applied to #${ch.name} (${channelId})`);
      res.json({ ok: true, channelId, channelName: ch.name, deny: DENY_ROLE_IDS, allow: ALLOW_ROLE_IDS });
    } catch (e) {
      res.status(500).json({ error: e.message, code: e.code });
    }
  });

  // POST /admin/chopping-block/ensure-list-embeds
  // Seeds the #callouts channel with the two pinned list embeds
  // (Warning + Chopping Block) using empty placeholder data. Idempotent —
  // safe to call on freshly-deployed environments before the first Monday
  // eval. No DMs, no strike writes, no role changes. Just embed rendering.
  router.post('/chopping-block/ensure-list-embeds', async (req, res) => {
    if (typeof choppingBlockEnsureListEmbeds !== 'function') {
      return res.status(503).json({ error: 'chopping-block hook not wired in opts' });
    }
    try {
      const result = await choppingBlockEnsureListEmbeds(client);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/config/apply  { yaml: "<content>", prune?: bool }
  router.post('/config/apply', async (req, res) => {
    const g = guild(res); if (!g) return;
    const { yaml: yamlContent, prune = false } = req.body;
    if (!yamlContent) return res.status(400).json({ error: 'yaml content required in body.yaml' });
    try {
      const report = await reconcile(g, yamlContent, prune);
      res.json(report);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /admin/config/dump
  router.get('/config/dump', async (req, res) => {
    const g = guild(res); if (!g) return;
    try {
      const out = await dumpConfig(g);
      res.type('text/yaml').send(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SETUP — POST /admin/setup/:type
  // Triggers the same embed post+pin as the corresponding /setup slash command.
  // Valid types: rules, accountability, welcome
  // ════════════════════════════════════════════════════════════════════════════


  function buildAnnouncementsEmbed() {
    return new EmbedBuilder()
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
  }

  const EVENTS_FILE_PATH = path.join(dataDir, 'events-schedule.json');

  function loadEventsSchedule() {
    try {
      if (fs.existsSync(EVENTS_FILE_PATH)) return JSON.parse(fs.readFileSync(EVENTS_FILE_PATH, 'utf8'));
    } catch (e) { console.error('[admin-api] Error loading events schedule:', e); }
    return null;
  }

  function saveEventsSchedule(data) {
    try { fs.writeFileSync(EVENTS_FILE_PATH, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('[admin-api] Error saving events schedule:', e); }
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
    if (require('./config').roomMode) return require('./room-copy').events(); // war rooms only when scheduled
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
          value:
            'Cameras required. Audio required. No lurking.\n' +
            "Show up half-in, don't bother."
        },
        {
          name: '📆 Community Events',
          value:
            'Scheduled events appear automatically below this embed.\n' +
            '@everyone gets pinged when an event is scheduled.\n' +
            'Reminders fire 24h, 1h, and at start time.'
        }
      )
      .setColor(0xe63b1e)
      .setFooter({ text: 'Show up daily. The men climbing the leaderboard are in here often.' });
  }

  function buildWorldclockEmbed() {
    return new EmbedBuilder()
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
  }

  function buildVotingEmbed() {
    return new EmbedBuilder()
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
  }

  const WARROOM_MSG_FILE = path.join(dataDir, 'warroom_msg.json');

  function loadWarRoomMsgId() {
    try {
      if (fs.existsSync(WARROOM_MSG_FILE)) return JSON.parse(fs.readFileSync(WARROOM_MSG_FILE, 'utf8')).msgId || null;
    } catch (e) {}
    return null;
  }
  function saveWarRoomMsgId(msgId) {
    try { fs.writeFileSync(WARROOM_MSG_FILE, JSON.stringify({ msgId })); }
    catch (e) { console.error('[admin-api] Error saving war room msg ID:', e); }
  }

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

  function convertETTime(timeStr, targetTz) {
    const SOURCE_TZ = 'America/New_York';
    if (!timeStr) return 'TBD';
    const parts = timeStr.split('-').map(s => s.trim());
    const srcOffset = getTimezoneOffsetMinutes(SOURCE_TZ);
    const tgtOffset = getTimezoneOffsetMinutes(targetTz);
    const diffMin   = tgtOffset - srcOffset;
    function convertSingle(t) {
      // Strip TZ abbreviation that follows AM/PM (e.g. "AM ET", "PM EDT") but keep AM/PM itself
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

  const EVENTS_SCHEDULE_FILE = path.join(dataDir, 'events-schedule.json');

  function renderDailyItinerary() {
    return new EmbedBuilder()
      .setTitle('🕒 WHAT\'S ON YOUR SCHEDULE TODAY?')
      .setDescription(
        "*Every war room session and standings drop runs on Eastern Time.*\n" +
        "*Run `/myschedule` to see today's schedule converted to your local timezone.*"
      )
      .setColor(0xe63b1e)
      .setFooter({ text: 'The Eye is watching.' });
  }

  const SETUP_CHANNEL_IDS = {
    rules:          RULES_CHANNEL_ID,
    accountability: ACCOUNTABILITY_CHANNEL_ID,
    welcome:        WELCOME_CHANNEL_ID,
    announcements:  ANNOUNCEMENTS_CHANNEL_ID,
    events:         EVENTS_CHANNEL_ID,
    worldclock:     WORLD_CLOCK_CHANNEL_ID,
    voting:         VOTE_CHANNEL_ID,
    onboarding:     RULES_CHANNEL_ID, // posted in #rules (same channel, second pinned message)
  };

  function buildRulesEmbed() {
    return new EmbedBuilder()
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
  }

  function buildAccountabilityEmbed() {
    return new EmbedBuilder()
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
  }

  function buildWelcomeEmbed() {
    return new EmbedBuilder()
      .setTitle('👋 WELCOME TO EVOLVE')
      .setDescription('*You made it in. Now become him.*')
      .addFields(
        {
          name: '⚡ What Happens Next',
          value:
            'Go to **#rules**, read the contract, and click **Begin Onboarding**.\n\n' +
            'The process takes 2 minutes:\n' +
            '1. Acknowledge the rules\n' +
            '2. Set your real name\n' +
            '3. Set your timezone\n' +
            '4. Acknowledge the discipline standard\n' +
            '5. **Submit your introduction**\n\n' +
            "Once finished, you're a Prospect. The work begins."
        },
        {
          name: '📝 Your Introduction',
          value:
            'A form will pop up requiring you to fill in:\n' +
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
  }

  function buildOnboardingEmbed() {
    const { EmbedBuilder: EB } = require('discord.js');
    return new EB()
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
          '4. Acknowledge the discipline standard\n' +
          '5. Complete your introduction\n\n' +
          'Takes 2 minutes. Then you\'re in.',
      })
      .setColor(0xe63b1e)
      .setFooter({ text: 'One click. Then the work.' });
  }

  // POST /admin/events/schedule — save schedule + edit pinned embed in-place
  router.post('/events/schedule', async (req, res) => {
    const g = guild(res); if (!g) return;
    const { events } = req.body;
    if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
    if (events.length > 5) return res.status(400).json({ error: 'max 5 events' });
    for (const ev of events) {
      if (!ev.name || !ev.time || !ev.days) {
        return res.status(400).json({ error: 'each event needs name, time, days' });
      }
    }
    const scheduleData = {
      events,
      updated_at: new Date().toISOString(),
      updated_by: 'admin-api',
    };
    saveEventsSchedule(scheduleData);

    // Find pinned events embed and edit in-place
    const ch = g.channels.cache.get(EVENTS_CHANNEL_ID);
    let embedMessageId = null;
    if (ch) {
      try {
        const pins = await ch.messages.fetchPinned();
        const pinned = pins.find(m =>
          m.author.id === g.client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0].title?.includes('#EVENTS')
        );
        const newEmbed = buildEventsEmbed();
        if (pinned) {
          await pinned.edit({ embeds: [newEmbed] });
          embedMessageId = pinned.id;
        } else {
          const msg = await ch.send({ embeds: [newEmbed] });
          await msg.pin();
          embedMessageId = msg.id;
        }
      } catch (e) { console.error('[admin-api] Error editing events embed:', e.message); }
    }

    res.json({ ok: true, eventsCount: events.length, embedMessageId });
  });

  // GET /admin/warroom/events - list this guild's scheduled events (read-only).
  // Used to verify a cancel actually removed the War Room event. Safe on both envs.
  router.get('/warroom/events', async (req, res) => {
    const g = guild(res); if (!g) return;
    try {
      const events = await g.scheduledEvents.fetch();
      const list = [...events.values()].map(ev => ({
        id: ev.id,
        name: ev.name,
        status: ev.status, // 1=Scheduled 2=Active 3=Completed 4=Canceled
      }));
      res.json({ ok: true, events: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/warroom/cancel - cancel today's War Room scheduled event(s) and
  // post the cancellation announcement to #events. Same shared helper the
  // /cancelwarroom slash command uses, so behavior + announcement are identical.
  // Authenticated (admin bearer) ops action; available on both envs. 🔒 No points.
  router.post('/warroom/cancel', async (req, res) => {
    const g = guild(res); if (!g) return;
    try {
      const { cancelWarRoom } = require('./war-room-cancel');
      const result = await cancelWarRoom(g, client, {
        eventsChannelId: EVENTS_CHANNEL_ID,
        invokedBy: 'admin-api',
      });
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/setup/dailyitinerary — post or edit Daily Itinerary embed in #world-clock
  router.post('/setup/dailyitinerary', async (req, res) => {
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(WORLD_CLOCK_CHANNEL_ID);
    if (!ch) return res.status(404).json({ error: `World-clock channel ${WORLD_CLOCK_CHANNEL_ID} not found in cache` });
    try {
      const embed = renderDailyItinerary();
      const savedMsgId = loadWarRoomMsgId();
      let msgId = null;
      if (savedMsgId) {
        const existing = await ch.messages.fetch(savedMsgId).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [embed] });
          msgId = existing.id;
        }
      }
      if (!msgId) {
        const msg = await ch.send({ embeds: [embed] });
        await msg.pin().catch(() => {});
        saveWarRoomMsgId(msg.id);
        msgId = msg.id;
      }
      res.json({ ok: true, messageId: msgId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/setup/:type', async (req, res) => {
    const type = req.params.type;
    const channelId = SETUP_CHANNEL_IDS[type];
    if (!channelId) {
      return res.status(400).json({ error: `Unknown setup type: ${type}. Valid: ${Object.keys(SETUP_CHANNEL_IDS).join(', ')}` });
    }
    const g = guild(res); if (!g) return;
    const ch = g.channels.cache.get(channelId);
    if (!ch) return res.status(404).json({ error: `Channel ${channelId} not found in cache` });

    // Room mode (Lucca 2026-10-29): room copy from lib/room-copy.js; the points guide is parked.
    const roomMode = require('./config').roomMode;
    if (roomMode && type === 'accountability') {
      return res.status(409).json({ error: 'The points guide is parked in room mode (ROOM_MODE=off brings it back).' });
    }
    const roomCopy = require('./room-copy');
    let embed;
    if (type === 'rules')               embed = roomMode ? roomCopy.rules() : buildRulesEmbed();
    else if (type === 'accountability') embed = buildAccountabilityEmbed();
    else if (type === 'welcome')        embed = roomMode ? roomCopy.welcome() : buildWelcomeEmbed();
    else if (type === 'announcements')  embed = roomMode ? roomCopy.announcements() : buildAnnouncementsEmbed();
    else if (type === 'events')         embed = buildEventsEmbed();
    else if (type === 'worldclock')     embed = buildWorldclockEmbed();
    else if (type === 'voting')         embed = buildVotingEmbed();
    else if (type === 'onboarding')     embed = roomMode ? roomCopy.onboarding() : buildOnboardingEmbed();

    try {
      let msg;
      if (type === 'onboarding') {
        // Onboarding entry-point: check if one already exists; edit in-place if so
        const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
        const button = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('start_onboarding')
            .setLabel('Begin Onboarding')
            .setStyle(ButtonStyle.Danger)
        );

        const pins = await ch.messages.fetchPinned();
        const existing = pins.find(m =>
          m.author.id === g.client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0]?.title?.includes('START YOUR ONBOARDING')
        );

        if (existing) {
          await existing.edit({ embeds: [embed], components: [button] });
          msg = existing;
          console.log(`[admin-api] SETUP onboarding → edited existing pinned message ${msg.id} in #${ch.name}`);
        } else {
          msg = await ch.send({ embeds: [embed], components: [button] });
          await msg.pin();
          console.log(`[admin-api] SETUP onboarding → posted + pinned message ${msg.id} in #${ch.name}`);
        }
      } else {
        msg = await ch.send({ embeds: [embed] });
        await msg.pin();
        console.log(`[admin-api] SETUP ${type} → posted + pinned message ${msg.id} in #${ch.name}`);
      }
      res.json({ ok: true, type, channelId, messageId: msg.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TEST-ONLY ENDPOINTS — DOUBLE-GATED so they can never fire on the live service
  // ════════════════════════════════════════════════════════════════════════════
  // Gate 1: Bearer ADMIN_TOKEN (already required by /admin/* middleware above).
  //         Staging and live have separate bearers, so the live bearer can never
  //         reach these handlers from the staging caller and vice versa.
  // Gate 2: process.env.STAGING_TEST_TRIGGERS_ENABLED === '1'.
  //         Set ONLY on the staging Railway service. Live's env never has this
  //         variable, so even if someone obtained the live bearer the endpoint
  //         returns 403 with a clear "not enabled on this environment" message.
  function requireStagingTestGate(req, res) {
    if (process.env.STAGING_TEST_TRIGGERS_ENABLED !== '1') {
      res.status(403).json({ error: 'Test triggers not enabled on this service (set STAGING_TEST_TRIGGERS_ENABLED=1 on staging only)' });
      return false;
    }
    return true;
  }

  // POST /admin/test/plant-points  { userId, daily?, weekly?, allTime? }
  // Writes directly to points.json, bypassing IGNORED_USER_IDS — for test
  // setup only. Returns the resulting per-user state.
  // ── Diet Tracker: manual lapse-report trigger (ops + staging E2E) ────────
  // POST /admin/diet-streaks/run — bypasses the 10:00 ET gate and the
  // once-per-date guard. Announcement-only; awards no points.
  router.post('/diet-streaks/run', async (req, res) => {
    try {
      const dietTracker = require('./diet-tracker');
      if (!dietTracker.isConfigured()) return res.status(400).json({ error: 'diet tracker not configured (DIET_TRACKER_URL / DIET_TRACKER_API_KEY)' });
      const result = await dietTracker.announceLapses(null, client, { force: true });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Workout Tracker: manual lapse-report trigger (ops + staging E2E) ─────
  // POST /admin/workout-streaks/run — bypasses the 10:00 ET gate and the
  // once-per-date guard. Announcement-only; awards no points.
  router.post('/workout-streaks/run', async (req, res) => {
    try {
      const workoutTracker = require('./workout-tracker');
      if (!workoutTracker.isConfigured()) return res.status(400).json({ error: 'workout tracker not configured (WORKOUT_TRACKER_URL / WORKOUT_TRACKER_API_KEY)' });
      const result = await workoutTracker.announceLapses(null, client, { force: true });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Tracker Issues: manual status-poll trigger (ops + staging E2E) ──────
  // POST /admin/tracker-issues/poll — runs the Notion status sweep now.
  router.post('/tracker-issues/poll', async (req, res) => {
    try {
      const trackerIssues = require('./tracker-issues');
      if (!trackerIssues.isConfigured()) return res.status(400).json({ error: 'tracker issues not configured (NOTION_TOKEN / TRACKER_BUGS_CHANNEL_ID / TRACKER_ISSUES_DB_ID)' });
      const result = await trackerIssues.pollStatuses(client);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/test/create-warroom-event  { name?, minutesFromNow? }
  // STAGING-ONLY: create a War Room voice scheduled event so the cancel flow can
  // be E2E-verified end to end (create -> cancel -> verify gone + announced).
  // Double-gated like every other test trigger.
  router.post('/test/create-warroom-event', async (req, res) => {
    if (!requireStagingTestGate(req, res)) return;
    const g = guild(res); if (!g) return;
    if (!WAR_ROOM_ID) return res.status(503).json({ error: 'WAR_ROOM_ID not wired in opts' });
    const {
      GuildScheduledEventEntityType,
      GuildScheduledEventPrivacyLevel,
    } = require('discord.js');
    const name = (req.body && req.body.name) ? String(req.body.name) : 'War Room';
    const minutesFromNow = Number.isFinite(req.body?.minutesFromNow) ? req.body.minutesFromNow : 60;
    const scheduledStartTime = new Date(Date.now() + minutesFromNow * 60 * 1000);
    try {
      const ev = await g.scheduledEvents.create({
        name,
        scheduledStartTime,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.Voice,
        channel: WAR_ROOM_ID,
        description: 'E2E test War Room occurrence (staging only).',
      });
      console.log(`[admin-api] TEST create-warroom-event -> ${ev.id} "${ev.name}" status=${ev.status}`);
      res.json({ ok: true, id: ev.id, name: ev.name, status: ev.status });
    } catch (e) {
      console.error('[admin-api] TEST create-warroom-event error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/test/plant-points', (req, res) => {
    if (!requireStagingTestGate(req, res)) return;
    const { userId, daily, weekly, allTime } = req.body || {};
    if (!userId || !/^\d{17,20}$/.test(String(userId))) {
      return res.status(400).json({ error: 'userId required (17-20 digit Discord snowflake)' });
    }
    try {
      let data = {};
      if (fs.existsSync(POINTS_FILE)) data = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
      if (!data[userId]) data[userId] = { allTime: 0, weekly: 0, daily: 0, lastPost: {} };
      if (typeof daily   === 'number') data[userId].daily   = daily;
      if (typeof weekly  === 'number') data[userId].weekly  = weekly;
      if (typeof allTime === 'number') data[userId].allTime = allTime;
      fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2));
      console.log(`[admin-api] TEST plant-points ${userId} → ${JSON.stringify(data[userId])}`);
      res.json({ ok: true, userId, state: data[userId] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /admin/test/simulate-midnight-tick  { weekday }
  // Calls runMidnightTasks with et = { weekday, hour: 0, minute: 0, date: <today> }.
  // Mon–Sat ↔ daily branch; the WEEKLY_LEADERBOARD_DAY value (currently 'Monday')
  // additionally fires the weekly branch. Same code path as the real scheduler.
  router.post('/test/simulate-midnight-tick', async (req, res) => {
    if (!requireStagingTestGate(req, res)) return;
    if (typeof runMidnightTasks !== 'function' || !schedulerHooks) {
      return res.status(503).json({ error: 'Scheduler hooks not wired (runMidnightTasks/schedulerHooks missing in opts)' });
    }
    const { weekday, date: dateOverride } = req.body || {};
    const valid = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    if (!valid.includes(weekday)) {
      return res.status(400).json({ error: 'weekday must be one of ' + valid.join(', ') });
    }
    if (dateOverride && !/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD if provided' });
    }
    const g = guild(res); if (!g) return;
    const et = {
      weekday,
      hour: 0,
      minute: 0,
      date: dateOverride || new Date().toISOString().slice(0, 10),
    };
    try {
      console.log(`[admin-api] TEST simulate-midnight-tick et=${JSON.stringify(et)}`);
      await runMidnightTasks(et, g, client, schedulerHooks);
      res.json({ ok: true, simulated: et });
    } catch (e) {
      console.error('[admin-api] TEST simulate-midnight-tick error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /admin/test/simulate-events-reminder  { kind: "30-min" | "5-min" }
  // Fires the rolling fireEventsReminder helper directly with a chosen
  // event name + kind. For testing the rolling-delete behavior of the post
  // itself, independent of the schedule-driven orchestration.
  router.post('/test/simulate-events-reminder', async (req, res) => {
    if (!requireStagingTestGate(req, res)) return;
    if (typeof fireEventsReminder !== 'function') {
      return res.status(503).json({ error: 'fireEventsReminder not wired in opts' });
    }
    const { kind, eventName } = req.body || {};
    if (!/^\d+-min$/.test(String(kind || ''))) {
      return res.status(400).json({ error: 'kind must match /^\\d+-min$/ (e.g. "30-min", "5-min")' });
    }
    if (!eventName || typeof eventName !== 'string') {
      return res.status(400).json({ error: 'eventName required' });
    }
    if (!EVENTS_CHANNEL_ID || !WAR_ROOM_ID) {
      return res.status(503).json({ error: 'EVENTS_CHANNEL_ID / WAR_ROOM_ID not wired in opts' });
    }
    const eventsChannel = client.channels.cache.get(EVENTS_CHANNEL_ID);
    if (!eventsChannel) return res.status(503).json({ error: 'events channel not cached' });
    try {
      console.log(`[admin-api] TEST simulate-events-reminder kind=${kind} event=${eventName}`);
      await fireEventsReminder(eventsChannel, kind, eventName, WAR_ROOM_ID);
      res.json({ ok: true, kind, eventName });
    } catch (e) {
      console.error('[admin-api] TEST simulate-events-reminder error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /admin/test/simulate-events-tick { weekday, hour, minute, date? }
  // Drives the data-driven runScheduledReminders orchestrator with a
  // simulated ET tick. Reads the current events-schedule.json on staging,
  // computes which fires should happen at that minute, applies dedupe, and
  // fires via the rolling pattern. Used to verify the /setevents-driven
  // reminder firing without waiting for natural fire windows.
  router.post('/test/simulate-events-tick', async (req, res) => {
    if (!requireStagingTestGate(req, res)) return;
    if (typeof runScheduledReminders !== 'function') {
      return res.status(503).json({ error: 'runScheduledReminders not wired in opts' });
    }
    const { weekday, hour, minute, date: dateOverride } = req.body || {};
    const valid = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    if (!valid.includes(weekday)) {
      return res.status(400).json({ error: 'weekday must be one of ' + valid.join(', ') });
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return res.status(400).json({ error: 'hour must be integer 0-23' });
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      return res.status(400).json({ error: 'minute must be integer 0-59' });
    }
    if (dateOverride && !/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD if provided' });
    }
    if (!EVENTS_CHANNEL_ID || !WAR_ROOM_ID) {
      return res.status(503).json({ error: 'EVENTS_CHANNEL_ID / WAR_ROOM_ID not wired in opts' });
    }
    const eventsChannel = client.channels.cache.get(EVENTS_CHANNEL_ID);
    if (!eventsChannel) return res.status(503).json({ error: 'events channel not cached' });
    const et = { weekday, hour, minute, date: dateOverride || new Date().toISOString().slice(0, 10) };
    try {
      console.log(`[admin-api] TEST simulate-events-tick et=${JSON.stringify(et)}`);
      await runScheduledReminders(et, eventsChannel, WAR_ROOM_ID);
      res.json({ ok: true, simulated: et });
    } catch (e) {
      console.error('[admin-api] TEST simulate-events-tick error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
