'use strict';
/**
 * lib/war-room-cancel.js
 * Shared "cancel today's War Room" logic for The Eye.
 *
 * Single source of truth used by BOTH:
 *   - the /cancelwarroom slash command (index.js)
 *   - POST /admin/warroom/cancel (lib/admin-api.js — ops + staging E2E)
 * so the command and the API produce byte-identical behavior + announcement.
 *
 * What it does:
 *   1. Fetches the guild's scheduled events.
 *   2. Finds the active/upcoming "War Room" event(s) — name contains "war room"
 *      (case-insensitive) AND status is Scheduled or Active. For a recurring
 *      daily event, deleting it cancels the upcoming occurrence.
 *   3. Deletes (cancels) each match.
 *   4. Posts a short cancellation notice — Eye's voice, @everyone — to the
 *      events channel, i.e. the same channel where event notices already post
 *      (guildScheduledEventCreate → EVENTS_CHANNEL_ID).
 *
 * 🔒 Zero point-economy paths. Announcement-only. No points are read or written.
 * Reminder cleanup is handled by the existing guildScheduledEventDelete listener
 * (which only clears the in-memory reminder timeouts — it posts nothing), so
 * there is no double-announcement.
 */

const { EmbedBuilder, GuildScheduledEventStatus } = require('discord.js');

const NETWORK_ACCENT = 0xe63b1e; // matches index.js / all member-facing embeds

// Default name the recurring production event is titled. Matching is done by
// case-insensitive substring so "War Room", "Daily War Room", etc. all match.
const WAR_ROOM_EVENT_NAME = 'War Room';

// A scheduled event counts as "the War Room to cancel" when its name contains
// "war room" and it is still Scheduled or currently Active (never Completed /
// already-Canceled). Status is the discord.js numeric enum (1=Scheduled, 2=Active).
function isCancelableWarRoom(ev) {
  if (!ev || !ev.name) return false;
  const nameMatch = ev.name.toLowerCase().includes('war room');
  const status = ev.status;
  const live =
    status === GuildScheduledEventStatus.Scheduled ||
    status === GuildScheduledEventStatus.Active;
  return nameMatch && live;
}

// The verbatim cancellation announcement. Kept here so command + API are identical.
function buildCancelAnnouncementEmbed() {
  return new EmbedBuilder()
    .setTitle('🚫 War Room Cancelled')
    .setDescription(
      "Today's War Room is cancelled. No live session.\n\n" +
      "The standard doesn't pause. Log your trades, your training, your meals. " +
      'Be in the room tomorrow.'
    )
    .setColor(NETWORK_ACCENT)
    .setFooter({ text: 'The Eye is watching.' });
}

/**
 * Cancel the War Room scheduled event(s) and announce the cancellation.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Client} client
 * @param {object} opts
 * @param {string} opts.eventsChannelId  channel where event notices post (#events)
 * @param {string} [opts.invokedBy]      tag/name for logging
 * @returns {Promise<{ok:boolean, cancelled:Array<{id:string,name:string}>, announced:boolean, error?:string}>}
 */
async function cancelWarRoom(guild, client, opts = {}) {
  const { eventsChannelId, invokedBy } = opts;
  if (!guild) return { ok: false, cancelled: [], announced: false, error: 'guild not available' };

  // Fetch fresh — cache may be cold or stale for scheduled events.
  const events = await guild.scheduledEvents.fetch();
  const targets = [...events.values()].filter(isCancelableWarRoom);

  if (targets.length === 0) {
    return {
      ok: false,
      cancelled: [],
      announced: false,
      error: 'No active or scheduled War Room event found to cancel.',
    };
  }

  const cancelled = [];
  for (const ev of targets) {
    await ev.delete();
    cancelled.push({ id: ev.id, name: ev.name });
  }

  // Announce to the events channel (where event notices already post).
  let announced = false;
  const channel = eventsChannelId ? client.channels.cache.get(eventsChannelId) : null;
  if (channel) {
    await channel.send({ content: '@everyone', embeds: [buildCancelAnnouncementEmbed()] });
    announced = true;
  }

  console.log(
    `[war-room] cancelled ${cancelled.length} event(s) ` +
    `(${cancelled.map(c => c.name).join(', ')}) by ${invokedBy || 'unknown'} — announced=${announced}`
  );

  return { ok: true, cancelled, announced };
}

module.e