# Sapphire Community Bot

A configurable Discord community bot with ticket workflows, moderation, member profiles, giveaways, and voice playback.

## Run locally or on Railway

1. Use Node.js 22.12 or newer.
2. Set `DISCORD_TOKEN` and `CLIENT_ID`.
3. Set `DATABASE_URL` to a persistent PostgreSQL database for production. `PGSSL=true` enables PostgreSQL TLS for hosts that require it.
4. Run `npm start`. The bot initializes its database tables and registers slash commands when it starts.
5. Enable the **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal. Grant the bot the permissions required for the features you enable, including Manage Messages, Manage Roles, moderation permissions, and voice Connect/Speak as needed.

Without `DATABASE_URL`, the bot uses temporary in-memory storage; settings, tickets, XP, and giveaway data will not persist across restarts.

## Features

- `/profile` and `/leaderboard` with message-based XP and levels.
- Configurable private ticket categories, custom themes, application questions, transcripts, and staff review controls.
- `/ticket block-role` and `/ticket unblock-role` to prevent or restore ticket creation for selected roles.
- A built-in **Partnership** ticket category. Links are allowed in partnership tickets even when automatic link removal is enabled elsewhere.
- Welcome and leave messages are opt-in: configure them with `/welcome setup` and `/leave setup`.
- Case-insensitive automod, triggers, and auto-replies. Configure link removal with `/automod links`; members receive three warnings before a five-minute timeout.
- Auto-role, scam phrase guard, and moderation log channel configuration.
- `/kick`, `/ban`, `/nick`, `/say`, `/giveaway`, YouTube voice playback with `/play`, and `/stop`.
- Restricted commands are available to the server owner, members granted direct access, or members with a role granted access using `/permissions grant`. Moderation commands also retain their Discord permission checks. `/clear` asks for confirmation and posts a completion notice.
- `/commands` sends a command guide by direct message.

Use `/ticket settings` to configure the ticket category, staff role, transcript destination, application review destination, and role granted when an application is accepted. The server owner can use `/permissions grant` or `/permissions revoke` to manage access by command for a role or an individual member. `/permissions` remains owner-only.
