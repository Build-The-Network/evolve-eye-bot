'use strict';
/**
 * lib/room-copy.js
 * Member-facing copy for ROOM MODE (Lucca 2026-10-29): Evolve Trading is a room of
 * men on the same path, with Lucca in it. No points, no scoring, no callouts. The one
 * rule is participation: show up. War rooms run only when scheduled.
 *
 * One home for this copy: index.js (/setup* slash commands + onboarding) and
 * lib/admin-api.js (/admin/setup/:type) both build from here, so the two
 * paths can't drift. The pre-room-mode embeds stay in those files, used only
 * when ROOM_MODE=off.
 */

const { EmbedBuilder } = require('discord.js');

const ACCENT = 0xe63b1e;
const BRAND = 'Evolve Trading';
const STEPS = 7; // 5 standard cards + name + intro

const ONBOARDING_STEPS =
  '1. Agree to the rules\n' +
  '2. Set your real name\n' +
  '3. Introduce yourself';

// The standard, in Lucca's words (2026-10-30). One home: rules() posts it in full in
// #rules, and standardCard() walks a new member through it one section at a time.
const STANDARD = [
  {
    title: 'What This Is',
    body:
      "This is a room with other men on the same path as you. It is designed to create a standard you cannot ignore. " +
      "You'll see me and our members continue to show up and move the needle forward in their trading success. " +
      'You will trade alone but you will not grow alone.\n\n' +
      "Anytime you feel stuck, lost, or want to quit, we've got your back. We're here to remind you that you are " +
      "capable and show you what it's like to go through the struggle but continue to fall back on your systems " +
      'and persist. The men in this room are committed to their success and you will be too.',
  },
  {
    title: 'One Rule: Show Up',
    body:
      'Your success is solely determined by you and the actions you take. The men in this room that are serious ' +
      'about their success will show up and prove they are committed to the process through consistency in their actions.\n\n' +
      'There is no other way to make it other than to show up for yourself daily and take this journey one step at ' +
      'a time, knowing one day you will achieve the success you are seeking. It is all on you.',
  },
  {
    title: 'Your Trades Are Yours',
    body:
      'This is a solo sport. No one is going to hold your hand and execute the trades for you. If you are serious ' +
      'about trading, you know that you have to learn how to feed yourself.\n\n' +
      'We are not here to give you trade ideas, trade signals, or tell you what to do. This circle is designed with ' +
      'the specific intent to PUSH YOU FORWARD in the right direction through consistent action. All the other men ' +
      'around you are doing it. You will too.\n\n' +
      "DO NOT ASK for signals. DO NOT ASK for trade ideas. Your idea is the best idea. Do not let someone else's bias " +
      'for the day mess with what you think is true for that day.\n\n' +
      'What you should be sharing is your faults and wins. Constantly document where you are going right and where ' +
      'you are going wrong, MEASURING your progress and sharing it with the group to ensure you are EVOLVING as a trader.',
  },
  {
    title: 'War Room',
    body:
      'War Room is for live voice sessions where you can communicate with the other men in your circle about anything. ' +
      'You have the opportunity to receive feedback on the trades you took, how your week is going, or anything going ' +
      "on in your personal life. Utilize the other men in your network. Ask them for anything and don't be afraid to " +
      'ask for help. We are here for you.\n\n' +
      "When you're in the War Room, CAMERAS ARE ON, MICS ARE ON. Engage and show that you are serious about your development.\n\n" +
      "War Room events can also be scheduled. You can schedule your own whenever you'd like!",
  },
  {
    title: 'Direct Access to Me',
    body:
      'I am here for you. Do not be afraid to come to me for advice on ANYTHING, no matter the subject. You need help ' +
      'fixing your daily routine, dialing in your nutrition, or being consistent in the gym? I got you.\n\n' +
      'Know that this circle is a resource for EVERYTHING, not just trading. Me and all the other men in your circle ' +
      'have accumulated a lot of knowledge partaking in this journey. Ask for it and be ready to share your own.',
  },
];

function rules() {
  const [intro, ...sections] = STANDARD;
  return new EmbedBuilder()
    .setTitle('EVOLVE TRADING — THE STANDARD')
    .setDescription(intro.body)
    .addFields(sections.map(s => ({ name: s.title, value: s.body })))
    .setColor(ACCENT);
}

function standardCard(i) {
  return new EmbedBuilder()
    .setAuthor({ name: `Step ${i + 1} of ${STEPS}` })
    .setTitle(STANDARD[i].title)
    .setDescription(STANDARD[i].body)
    .setColor(ACCENT);
}

// #welcome is the intro feed, nothing else (Lucca 2026-10-30). The greeting lives in the
// channel topic; this only exists so /setupwelcome can't bring the old embed back.
function welcome() {
  return new EmbedBuilder()
    .setTitle('WELCOME NEW MEMBERS')
    .setColor(ACCENT);
}

function onboarding() {
  return new EmbedBuilder()
    .setTitle('🎯 START YOUR ONBOARDING')
    .setDescription(
      `*You just joined ${BRAND}. Read the standard above, then click below.*`
    )
    .addFields({
      name: "📋 What You'll Do",
      value: ONBOARDING_STEPS + "\n\nTakes 2 minutes. Then you're in.",
    })
    .setColor(ACCENT)
    .setFooter({ text: 'One click. Then show up.' });
}

function announcements() {
  return new EmbedBuilder()
    .setTitle('📢 #ANNOUNCEMENTS')
    .setDescription('*Official server communications. Read-only for members.*')
    .addFields(
      {
        name: '📌 What Gets Posted Here',
        value: 'Community updates\nServer-wide communications',
      },
      {
        name: '🔕 Notifications',
        value: 'Keep notifications on for this channel.',
      }
    )
    .setColor(ACCENT)
    .setFooter({ text: 'Read-only. No replies.' });
}

function events() {
  return new EmbedBuilder()
    .setTitle('Scheduled Events')
    .setDescription(
      'Live sessions to interact with your circle will be scheduled.\n\n' +
      "Every one is posted here and in the server's **Events** tab. " +
      'Click **Interested** and Discord reminds you before it starts.'
    )
    .addFields({
      name: 'War Room Rules',
      value:
        'Join with CAMERAS ON and MICS ON. Engage with your circle!\n\n' +
        "Do not lurk. If you're not going to engage, don't show up at all.",
    })
    .setColor(ACCENT);
}

// ── Onboarding steps (ephemeral) ────────────────────────────────────────────
function step2() {
  return new EmbedBuilder()
    .setTitle(`👤 STEP 6 OF ${STEPS} — YOUR REAL NAME`)
    .setColor(ACCENT)
    .setDescription(
      '*Your Discord username is anonymous. This room is not.\n\n' +
      'Real names carry weight. The men in here see who they are talking to.*'
    );
}

function step3(nickname) {
  return new EmbedBuilder()
    .setTitle(`📝 STEP 7 OF ${STEPS} — YOUR INTRODUCTION`)
    .setColor(ACCENT)
    .setDescription(
      `*✅ Name set to **${nickname}**.\n\n` +
      'Last step. Tell the room who you are: where you are, what you trade, why you are here.\n\n' +
      'Specific answers earn respect. It posts in #welcome.*'
    );
}

function complete() {
  return "✅ **You're in.** The channels are open. Start in #chat and tell us where you're at.";
}

function introPost(memberId, { name, location, trading, why, commit }) {
  return (
    `🆕 **NEW MEMBER**\n\n` +
    `<@${memberId}> just joined ${BRAND}.\n\n` +
    `📛 **Name:** ${name}\n` +
    `📍 **Location:** ${location}\n` +
    `📊 **Trading:** ${trading}\n` +
    `🎯 **Why I'm here:** ${why}\n` +
    `🤝 **Commitment to Show Up:** ${commit}\n\n` +
    `Welcome to ${BRAND}.`
  );
}

module.exports = {
  STEPS, STANDARD, rules, standardCard, welcome, onboarding, announcements, events,
  step2, step3, complete, introPost,
};
