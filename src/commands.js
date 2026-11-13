const { SlashCommandBuilder } = require('discord.js');

const permissionChoices = [
  ['ticket', 'ticket'],
  ['application', 'application'],
  ['automod', 'automod'],
  ['welcome', 'welcome'],
  ['leave', 'leave'],
  ['autoreply', 'autoreply'],
  ['trigger', 'trigger'],
  ['scam guard', 'scamguard'],
  ['moderation logs', 'logs'],
  ['announcements', 'say'],
  ['giveaways', 'giveaway'],
  ['clear', 'clear']
].map(([name, value]) => ({ name, value }));

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot and its database are responding.'),
  new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Refresh slash commands for this server (server owner only).'),
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View a server member profile and level.')
    .addUserOption(option => option.setName('member').setDescription('Member to view')),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the server XP leaderboard.'),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage ticket panels, themes, access, transcripts, and review.')
    .addSubcommand(sub => sub.setName('panel').setDescription('Post the ticket categories and themes.')
      .addChannelOption(option => option.setName('channel').setDescription('Channel for the panel').setRequired(true)))
    .addSubcommand(sub => sub.setName('settings').setDescription('Configure ticket access and archive channels.')
      .addChannelOption(option => option.setName('category').setDescription('Category for new tickets'))
      .addRoleOption(option => option.setName('staff_role').setDescription('Role that can view tickets'))
      .addChannelOption(option => option.setName('transcript_channel').setDescription('Private channel for closed ticket transcripts'))
      .addChannelOption(option => option.setName('review_channel').setDescription('Channel where completed applications are reviewed'))
      .addRoleOption(option => option.setName('staff_role_to_apply').setDescription('Role granted when staff applications are accepted')))
    .addSubcommand(sub => sub.setName('theme-add').setDescription('Add a selectable support/application ticket theme.')
      .addStringOption(option => option.setName('key').setDescription('Unique key, for example youtuber').setRequired(true).setMaxLength(20))
      .addStringOption(option => option.setName('label').setDescription('Theme shown on the ticket panel').setRequired(true).setMaxLength(80))
      .addStringOption(option => option.setName('description').setDescription('Short description shown on the panel').setRequired(true).setMaxLength(100))
      .addStringOption(option => option.setName('questions').setDescription('Optional application questions, one per line').setMaxLength(4000)))
    .addSubcommand(sub => sub.setName('theme-remove').setDescription('Remove a custom ticket theme.')
      .addStringOption(option => option.setName('key').setDescription('Theme key to remove').setRequired(true).setMaxLength(20)))
    .addSubcommand(sub => sub.setName('block-role').setDescription('Prevent a role from opening tickets.')
      .addRoleOption(option => option.setName('role').setDescription('Role that cannot open tickets').setRequired(true)))
    .addSubcommand(sub => sub.setName('unblock-role').setDescription('Allow a role to open tickets again.')
      .addRoleOption(option => option.setName('role').setDescription('Role to allow').setRequired(true))),
  new SlashCommandBuilder()
    .setName('application')
    .setDescription('Configure the staff application panel and questions.')
    .addSubcommand(sub => sub.setName('setup').setDescription('Post an application panel and review workflow.')
      .addChannelOption(option => option.setName('channel').setDescription('Channel for the application panel').setRequired(true))
      .addStringOption(option => option.setName('questions').setDescription('One question per line').setRequired(true).setMaxLength(4000))
      .addChannelOption(option => option.setName('review_channel').setDescription('Channel where completed applications are sent'))
      .addRoleOption(option => option.setName('staff_role').setDescription('Role to grant when an application is accepted'))),
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Grant or remove a role for a management command.')
    .addSubcommand(sub => sub.setName('grant').setDescription('Authorize a role for a command.')
      .addStringOption(option => option.setName('command').setDescription('Command to grant').setRequired(true).addChoices(...permissionChoices))
      .addRoleOption(option => option.setName('role').setDescription('Role to authorize').setRequired(true)))
    .addSubcommand(sub => sub.setName('revoke').setDescription('Remove a role authorization.')
      .addStringOption(option => option.setName('command').setDescription('Command to revoke').setRequired(true).addChoices(...permissionChoices))
      .addRoleOption(option => option.setName('role').setDescription('Role to remove').setRequired(true))),
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure abuse detection and link filtering.')
    .addSubcommand(sub => sub.setName('add-word').setDescription('Add a word or phrase to the filter.')
      .addStringOption(option => option.setName('term').setDescription('Case-insensitive term').setRequired(true).setMaxLength(100)))
    .addSubcommand(sub => sub.setName('remove-word').setDescription('Remove a word or phrase from the filter.')
      .addStringOption(option => option.setName('term').setDescription('Term to remove').setRequired(true).setMaxLength(100)))
    .addSubcommand(sub => sub.setName('links').setDescription('Enable or disable automatic link removal.')
      .addBooleanOption(option => option.setName('enabled').setDescription('Remove links from member messages').setRequired(true)))
    .addSubcommand(sub => sub.setName('status').setDescription('Show filter terms and link-filter status.')),
  ...['welcome', 'leave'].map(name =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(`Configure ${name} messages.`)
      .addSubcommand(sub => sub.setName('setup').setDescription(`Set the ${name} channel and optional message.`)
        .addChannelOption(option => option.setName('channel').setDescription('Text channel').setRequired(true))
        .addStringOption(option => option.setName('message').setDescription('Optional custom message; leave blank to use the default').setMaxLength(1000))
        .addStringOption(option => option.setName('banner_text').setDescription('Optional extra line in the text embed').setMaxLength(64)))
  ),
  new SlashCommandBuilder()
    .setName('autoreply')
    .setDescription('Configure automatic keyword replies.')
    .addSubcommand(sub => sub.setName('add').setDescription('Add or update a case-insensitive keyword reply.')
      .addStringOption(option => option.setName('keyword').setDescription('Whole word or phrase').setRequired(true).setMaxLength(80))
      .addStringOption(option => option.setName('response').setDescription('Bot response').setRequired(true).setMaxLength(1500)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove an automatic reply.')
      .addStringOption(option => option.setName('keyword').setDescription('Keyword to remove').setRequired(true).setMaxLength(80))),
  new SlashCommandBuilder()
    .setName('trigger')
    .setDescription('Add a phrase trigger and its automatic response.')
    .addSubcommand(sub => sub.setName('add').setDescription('Respond when a member says a phrase.')
      .addStringOption(option => option.setName('word').setDescription('Case-insensitive trigger phrase').setRequired(true).setMaxLength(80))
      .addStringOption(option => option.setName('response').setDescription('Bot response').setRequired(true).setMaxLength(1500)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove a phrase trigger.')
      .addStringOption(option => option.setName('word').setDescription('Trigger phrase to remove').setRequired(true).setMaxLength(80))),
  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Set or remove the role automatically given to new members (owner only).')
    .addSubcommand(sub => sub.setName('setup').setDescription('Set the role for new members.')
      .addRoleOption(option => option.setName('role').setDescription('Role to give on join').setRequired(true)))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable automatic roles.')),
  new SlashCommandBuilder()
    .setName('scamguard')
    .setDescription('Configure exact scam phrases that cause removal in one channel.')
    .addSubcommand(sub => sub.setName('setup').setDescription('Set the channel and exact phrases that trigger a kick.')
      .addChannelOption(option => option.setName('channel').setDescription('Dedicated scam-monitor channel').setRequired(true))
      .addStringOption(option => option.setName('terms').setDescription('Exact phrases, one per line').setRequired(true).setMaxLength(1000)))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable scam phrase enforcement.')),
  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Set the channel for moderation and staff-action logs.')
    .addSubcommand(sub => sub.setName('setup').setDescription('Set the private moderation log channel.')
      .addChannelOption(option => option.setName('channel').setDescription('Private staff log channel').setRequired(true))),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Remove a member from the server.')
    .addUserOption(option => option.setName('member').setDescription('Member to kick').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('Reason for the kick').setMaxLength(500)),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server.')
    .addUserOption(option => option.setName('member').setDescription('Member to ban').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('Reason for the ban').setMaxLength(500)),
  new SlashCommandBuilder()
    .setName('nick')
    .setDescription('Change a member nickname.')
    .addUserOption(option => option.setName('member').setDescription('Member to rename').setRequired(true))
    .addStringOption(option => option.setName('nickname').setDescription('New nickname; leave blank to reset it').setMaxLength(32)),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Post a bot announcement, optionally with an image.')
    .addChannelOption(option => option.setName('channel').setDescription('Channel to post in').setRequired(true))
    .addStringOption(option => option.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(4000))
    .addAttachmentOption(option => option.setName('image').setDescription('Optional image attachment')),
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a timed giveaway.')
    .addSubcommand(sub => sub.setName('start').setDescription('Post a giveaway with an entry button.')
      .addChannelOption(option => option.setName('channel').setDescription('Giveaway channel').setRequired(true))
      .addStringOption(option => option.setName('prize').setDescription('Giveaway prize').setRequired(true).setMaxLength(200))
      .addIntegerOption(option => option.setName('duration').setDescription('Duration in minutes (1-10080)').setRequired(true).setMinValue(1).setMaxValue(10080))
      .addIntegerOption(option => option.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube video in your current voice channel.')
    .addStringOption(option => option.setName('url').setDescription('Public YouTube video URL').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music and disconnect from your voice channel.'),
  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Show useful information about this server.'),
  new SlashCommandBuilder()
    .setName('commands')
    .setDescription('Get a direct message with this bot’s commands.'),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear this channel (owner or granted role; confirms first and notifies players).')
];

module.exports = commands.map(command => command.toJSON());
