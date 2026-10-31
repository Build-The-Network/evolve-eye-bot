'use strict';
/**
 * lib/reconciler.js
 * Diffs current Discord server state against a YAML config and applies changes.
 *
 * Safety:
 *   - Default: additive only. Creates missing categories/channels/roles and updates
 *     mismatched properties. Never deletes unless --prune is explicitly passed.
 *   - Wraps everything in try/catch — never crashes the bot.
 *   - Every change is console.log'd with a timestamp.
 */

const yaml         = require('js-yaml');
const { ChannelType } = require('discord.js');

// ── Channel type mappings ─────────────────────────────────────────────────────
const TYPE_STR_TO_DISCORD = {
  text:         ChannelType.GuildText,
  voice:        ChannelType.GuildVoice,
  category:     ChannelType.GuildCategory,
  forum:        ChannelType.GuildForum,
  announcement: ChannelType.GuildAnnouncement,
  news:         ChannelType.GuildAnnouncement,
  stage:        ChannelType.GuildStageVoice,
};

const TYPE_DISCORD_TO_STR = {
  [ChannelType.GuildText]:         'text',
  [ChannelType.GuildVoice]:        'voice',
  [ChannelType.GuildCategory]:     'category',
  [ChannelType.GuildForum]:        'forum',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildStageVoice]:   'stage',
};

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(msg) { console.log(`[${ts()}] [reconciler] ${msg}`); }

// Substitute {{VAR}} tokens in a topic string from the vars map.
// Behavior:
//   - vars undefined/empty           → byte-identical passthrough (no substitution attempted)
//   - vars non-empty, topic has no   → byte-identical passthrough
//     {{...}}
//   - vars non-empty, all {{...}}    → substituted result
//     tokens present in vars
//   - vars non-empty, {{TOKEN}}      → throws Error naming the missing token
//     not in vars                      (caught by per-channel try/catch upstream;
//                                       channel creation is skipped, error reported)
function substituteTopic(topic, vars) {
  if (topic == null) return topic;
  if (!vars || Object.keys(vars).length === 0) return topic;
  if (!/\{\{[A-Z0-9_]+\}\}/.test(topic)) return topic;
  return topic.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`reconcile: topic placeholder {{${name}}} has no value in vars map`);
    }
    return vars[name];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// reconcile(guild, yamlContent, prune, vars)
//   vars: optional map of {{TOKEN}} → string substitutions applied to channel
//         topics. Undefined/empty → no substitution (existing call sites
//         unaffected).
// ─────────────────────────────────────────────────────────────────────────────
async function reconcile(guild, yamlContent, prune = false, vars = undefined) {
  const report = { created: [], updated: [], deleted: [], skipped: [], errors: [] };

  let config;
  try {
    config = yaml.load(yamlContent);
  } catch (e) {
    report.errors.push({ type: 'parse', error: `YAML parse error: ${e.message}` });
    return report;
  }

  // ── Roles ──────────────────────────────────────────────────────────────────
  if (Array.isArray(config.roles)) {
    for (const spec of config.roles) {
      if (!spec.name) continue;
      try {
        const existing = guild.roles.cache.find(r => r.name === spec.name);
        if (!existing) {
          const newRole = await guild.roles.create({
            name:        spec.name,
            color:       spec.color        || '#000000',
            mentionable: spec.mentionable  ?? false,
            hoist:       spec.hoist        ?? false,
          });
          log(`Created role: "${newRole.name}" (${newRole.id})`);
          report.created.push({ type: 'role', name: newRole.name, id: newRole.id });
        } else {
          const edits = {};
          if (spec.color       !== undefined && existing.hexColor    !== spec.color.toLowerCase())   edits.color       = spec.color;
          if (spec.mentionable !== undefined && existing.mentionable !== spec.mentionable)            edits.mentionable = spec.mentionable;
          if (spec.hoist       !== undefined && existing.hoist       !== spec.hoist)                 edits.hoist       = spec.hoist;
          if (Object.keys(edits).length) {
            await existing.edit(edits);
            log(`Updated role "${existing.name}": ${JSON.stringify(edits)}`);
            report.updated.push({ type: 'role', name: existing.name, id: existing.id, changes: edits });
          } else {
            report.skipped.push({ type: 'role', name: existing.name, reason: 'no changes needed' });
          }
        }
      } catch (e) {
        log(`ERROR on role "${spec.name}": ${e.message}`);
        report.errors.push({ type: 'role', name: spec.name, error: e.message });
      }
    }
  }

  // ── Categories + channels ──────────────────────────────────────────────────
  if (config.categories && typeof config.categories === 'object') {
    for (const [catName, channelSpecs] of Object.entries(config.categories)) {
      // Skip the _no_category pseudo-key from dumps (read-only)
      if (catName === '_no_category') {
        report.skipped.push({ type: 'category', name: catName, reason: '_no_category is read-only' });
        continue;
      }

      let category;
      try {
        // Case-insensitive match on category name
        category = guild.channels.cache.find(
          ch => ch.type === ChannelType.GuildCategory && ch.name.toUpperCase() === catName.toUpperCase()
        );
        if (!category) {
          category = await guild.channels.create({ name: catName, type: ChannelType.GuildCategory });
          log(`Created category: "${category.name}" (${category.id})`);
          report.created.push({ type: 'category', name: category.name, id: category.id });
        } else {
          report.skipped.push({ type: 'category', name: category.name, reason: 'already exists' });
        }
      } catch (e) {
        log(`ERROR creating category "${catName}": ${e.message}`);
        report.errors.push({ type: 'category', name: catName, error: e.message });
        continue;
      }

      // Reconcile channels under this category
      for (const spec of (channelSpecs || [])) {
        if (!spec.name) continue;
        try {
          const chType = TYPE_STR_TO_DISCORD[spec.type] ?? ChannelType.GuildText;
          const existing = guild.channels.cache.find(
            ch => ch.parentId === category.id && ch.name === spec.name
          );
          const desiredTopic = substituteTopic(spec.topic || null, vars);
          if (!existing) {
            const newCh = await guild.channels.create({
              name:   spec.name,
              type:   chType,
              parent: category.id,
              topic:  desiredTopic,
            });
            log(`Created channel: "${catName}/${newCh.name}" (${newCh.id})`);
            report.created.push({ type: 'channel', name: newCh.name, id: newCh.id, parent: catName });
          } else {
            const edits = {};
            const topicMatch = (existing.topic || null) === (desiredTopic || null);
            if (!topicMatch) edits.topic = desiredTopic;
            if (Object.keys(edits).length) {
              await existing.edit(edits);
              log(`Updated channel "${existing.name}": ${JSON.stringify(edits)}`);
              report.updated.push({ type: 'channel', name: existing.name, id: existing.id, changes: edits });
            } else {
              report.skipped.push({ type: 'channel', name: existing.name, reason: 'no changes needed' });
            }
          }
        } catch (e) {
          log(`ERROR on channel "${catName}/${spec.name}": ${e.message}`);
          report.errors.push({ type: 'channel', name: `${catName}/${spec.name}`, error: e.message });
        }
      }
    }
  }

  // ── Prune ──────────────────────────────────────────────────────────────────
  if (prune) {
    // Safety: prune is intentionally not implemented by default.
    // To enable channel/role deletion via reconcile, this block must be
    // explicitly implemented after additional safety review.
    report.skipped.push({ type: 'prune', reason: 'Prune is not yet implemented for safety. Use the DELETE endpoints directly.' });
  }

  log(`Reconciliation complete. created=${report.created.length} updated=${report.updated.length} skipped=${report.skipped.length} errors=${report.errors.length}`);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// dumpConfig(guild) → YAML string of current server state
// ─────────────────────────────────────────────────────────────────────────────
async function dumpConfig(guild) {
  const allChannels = await guild.channels.fetch();

  // Build categories
  const categories = {};
  const cats = [...allChannels.values()]
    .filter(ch => ch && ch.type === ChannelType.GuildCategory)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));

  for (const cat of cats) {
    const children = [...allChannels.values()]
      .filter(ch => ch && ch.parentId === cat.id)
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
      .map(ch => {
        const entry = {
          name: ch.name,
          type: TYPE_DISCORD_TO_STR[ch.type] || 'text',
        };
        if (ch.topic) entry.topic = ch.topic;
        return entry;
      });
    categories[cat.name] = children;
  }

  // Channels with no category
  const orphans = [...allChannels.values()]
    .filter(ch => ch && !ch.parentId && ch.type !== ChannelType.GuildCategory)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
  if (orphans.length) {
    categories['_no_category'] = orphans.map(ch => ({
      name: ch.name,
      type: TYPE_DISCORD_TO_STR[ch.type] || 'text',
      ...(ch.topic ? { topic: ch.topic } : {}),
    }));
  }

  // Build roles (exclude @everyone and bot-managed roles)
  const roles = [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map(r => {
      const entry = {
        name:        r.name,
        mentionable: r.mentionable,
        hoist:       r.hoist,
        position:    r.position,
      };
      if (r.hexColor && r.hexColor !== '#000000') entry.color = r.hexColor;
      return entry;
    });

  const doc = { categories, roles };
  return '# The Eye — Server Config\n# Generated by /admin/config/dump — ' + new Date().toISOString() + '\n\n'
    + yaml.dump(doc, { indent: 2, lineWidth: 120, noRefs: true });
}

module.exports = { reconcile, dumpConfig };
