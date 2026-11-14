# Sapphire Community Bot

A configurable Discord community bot with ticket workflows, moderation, member profiles, giveaways, and voice playback.

## Run locally or on Railway

1. Use Node.js 22.12 or newer.
2. Set `DISCORD_TOKEN` and `CLIENT_ID`.
3. Set `DATABASE_URL` to a persistent PostgreSQL database for production. `PGSSL=true` enables PostgreSQL TLS for hosts that require it.
4. Run `npm start`. The bot initializes its database tables and registers slash commands when it starts.
5. Enable the **Server Members Intent**, **Message Content Intent**, and **Guild Invites intent** in the Discord Developer Portal. Grant the bot the permissions required for the features you enable, including Manage Server for invite tracking, Attach Files in transcript/review channels, Manage Messages, Manage Roles, moderation permissions, and voice Connect/Speak as needed.

Without `DATABASE_URL`, the bot uses temporary in-memory storage; settings, tickets, XP, and giveaway data will not persist across restarts.

## Features

- `/profile` and `/leaderboard` with message-based XP and levels.
- `/invites check [member]` tracks invite-attributed joins; `/invites leaderboard` shows the top inviters. Invite attribution requires the Guild Invites intent and Manage Server permission.
- Configurable private ticket categories, custom themes, application questions, transcripts, and staff review controls.
- `/ticket block-role` and `/ticket unblock-role` to prevent or restore ticket creation for selected roles.
- A built-in **Partnership** ticket category. Links are allowed in partnership tickets even when automatic link removal is enabled elsewhere.
- Welcome and leave messages are opt-in: configure them with `/welcome setup` and `/leave setup`.
- Case-insensitive automod, triggers, and auto-replies. Configure link removal with `/automod links`; members receive three warnings before a five-minute timeout.
- Auto-role, scam phrase guard, and moderation log channel configuration.
- `/kick`, `/ban`, `/nick`, `/say`, `/giveaway`, YouTube voice playback with `/play`, and `/stop`.
- The configured global command admin (`1292815622413226035`) can use all commands in every server without server-owner status. Server owners can also grant command access to members or roles using `/permissions grant`. Moderation actions still require the bot itself to have the necessary Discord permissions and role hierarchy.
- `/clear` asks for confirmation and posts a completion notice.
- `/commands` sends a command guide by direct message.

Use `/application setup` to post the staff application panel and select its review channel, then set the transcript archive with `/ticket settings`. After the applicant answers everything, the ticket closes and the review channel gets a PDF and text copy of the questions and answers, with the applicant mentioned and Accept/Reject buttons. The archive receives a PDF and full text transcript. The applicant gets a DM with the decision; the review card is updated in the selected channel. Configure a staff role if accepted applicants should receive one automatically.

Use `/commands` for a paginated, plain-language command guide in your DMs. The server owner or configured global command admin can use `/permissions grant` or `/permissions revoke` to manage command access by role or individual member.
