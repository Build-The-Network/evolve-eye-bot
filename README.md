# Evolve Eye

The operations bot behind Evolve Trading, a paid Discord community sold through Whop. It runs the parts of a community that break when done by hand: onboarding, event reminders and member lifecycle.

## What it does

- **Gated onboarding.** Only members holding the paid role can start. A 7-step card walk shows the community standard one section at a time, with each card locked for a set read time, then collects a real name and an introduction.
- **Step tracking.** Every step is written to a member log, so a stuck member is visible.
- **Event operations.** Listens to Discord's native scheduled events and posts a notice on creation, then reminders 24 hours before, 1 hour before and at start. Time changes re-arm the reminders, cancellations clear them, and reminders survive a restart.
- **Room mode.** A switch that parks the older points, leaderboard and habit systems without deleting them.
- **Admin API.** Authenticated endpoints for posting channel content and reconciling server configuration.

## Built with

Node.js, discord.js, Express. Deployed on Railway. Built with AI-assisted development using Claude Code.

## Run it

```bash
npm install
cp .env.example .env
npm start
```

Fill `.env` with your own bot token and server IDs. No real IDs or credentials are in this repository.

```bash
npm test
```

## About this repository

A clean public copy of a private working repository, with fresh history. Internal notes, deployment scripts and server-specific tooling were left out. All rights reserved.
