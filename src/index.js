  require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
  const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    Client,
    EmbedBuilder,
    GatewayIntentBits,
    PermissionFlagsBits,
    StringSelectMenuBuilder
  } = require('discord.js');
  const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    createAudioPlayer,
    createAudioResource,
    entersState,
    joinVoiceChannel,
    VoiceConnectionStatus
  } = require('@discordjs/voice');
  const play = require('play-dl');
  const { randomInt, randomUUID } = require('node:crypto');
  const { pool, initializeDatabase, getGuildSettings, updateGuildSettings } = require('./db');
  const { createTextEmbed } = require('./embeds');
  const { createPdfBuffer } = require('./pdf');
  const {
    applyTemplate,
    findUsedInvite,
    formatApplicationAnswers,
    getApplicationStep,
    isGlobalCommandAdmin,
    isCommandAuthorized,
    levelForXp,
    memberHasBlockedRole,
    matchesWholePhrase,
    shouldRemoveLink,
    xpForMessages,
    xpForNextLevel
  } = require('./utils');
  const {
    DEFAULT_WELCOME_MESSAGE,
    DEFAULT_LEAVE_MESSAGE
  } = require('./defaults');
  const commandSchemas = require('./commands');

  const required = ['DISCORD_TOKEN', 'CLIENT_ID'];
  const botName = 'Hawk Client';
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} is required.`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  const spamHistory = new Map();
  const musicPlayers = new Map();
  const giveawayTimers = new Map();
  const inviteSnapshots = new Map();
  const inviteInitialization = new Map();
  const inviteTrackingQueues = new Map();

  async function saveInviteSnapshot(guildId, invites) {
    const previous = inviteSnapshots.get(guildId) || new Map();
    const current = new Map(invites.map(invite => [
      invite.code,
      { uses: Number(invite.uses) || 0, inviterId: invite.inviter?.id || null }
    ]));
    for (const [code, invite] of current) {
      await pool.query(
        `INSERT INTO invite_snapshots (guild_id, invite_code, inviter_id, uses)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (guild_id, invite_code) DO UPDATE
        SET inviter_id = EXCLUDED.inviter_id, uses = EXCLUDED.uses`,
        [guildId, code, invite.inviterId, invite.uses]
      );
    }
    for (const code of previous.keys()) {
      if (!current.has(code)) {
        await pool.query(
          'DELETE FROM invite_snapshots WHERE guild_id = $1 AND invite_code = $2',
          [guildId, code]
        );
      }
    }
    inviteSnapshots.set(guildId, current);
  }

  async function initializeInviteSnapshot(guild) {
    try {
      const invites = await guild.invites.fetch();
      await pool.query('DELETE FROM invite_snapshots WHERE guild_id = $1', [guild.id]);
      await saveInviteSnapshot(guild.id, [...invites.values()]);
    } catch (error) {
      console.warn(`Invite tracking is unavailable in guild ${guild.id}; grant Manage Server and enable Guild Invites intent.`);
      console.error(`Unable to initialize invite tracking for guild ${guild.id}:`, error);
    }
  }

  async function recordInviteJoin(member) {
    const guildId = member.guild.id;
    const invites = await member.guild.invites.fetch();
    const currentInvites = [...invites.values()];
    const previous = inviteSnapshots.get(guildId);
    if (previous) {
      const usedInvite = findUsedInvite(
        [...previous].map(([code, value]) => ({ code, ...value })),
        currentInvites.map(invite => ({
          code: invite.code,
          uses: invite.uses,
          inviterId: invite.inviter?.id || null
        }))
      );
      if (usedInvite?.inviterId) {
        await pool.query(
          'INSERT INTO invite_joins (id, guild_id, member_id, inviter_id, invite_code) VALUES ($1, $2, $3, $4, $5)',
          [randomUUID(), guildId, member.id, usedInvite.inviterId, usedInvite.code]
        );
      }
    }
    await saveInviteSnapshot(guildId, currentInvites);
  }

  async function trackInviteJoin(member) {
    const guildId = member.guild.id;
    await inviteInitialization.get(guildId);
    const previous = inviteTrackingQueues.get(guildId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => recordInviteJoin(member));
    inviteTrackingQueues.set(guildId, current);
    try {
      await current;
    } finally {
      if (inviteTrackingQueues.get(guildId) === current) inviteTrackingQueues.delete(guildId);
    }
  }

  async function hasCommandAccess(interaction, commandName) {
    if (isGlobalCommandAdmin(interaction.user.id) ||
        interaction.user.id === interaction.guild?.ownerId) return true;
    const [{ rows: roleRows }, { rows: userRows }] = await Promise.all([
      pool.query(
        'SELECT role_id FROM command_roles WHERE guild_id = $1 AND command_name = $2',
        [interaction.guildId, commandName]
      ),
      pool.query(
        'SELECT user_id FROM command_users WHERE guild_id = $1 AND command_name = $2',
        [interaction.guildId, commandName]
      )
    ]);
    if (userRows.some(({ user_id: userId }) => userId === interaction.user.id)) return true;
    return isCommandAuthorized(
      interaction.user.id,
      interaction.guild?.ownerId,
      interaction.member?.roles?.cache?.keys() || [],
      roleRows.map(({ role_id: roleId }) => roleId)
    );
  }

  async function requireCommandAccess(interaction, commandName) {
    if (await hasCommandAccess(interaction, commandName)) return true;
    await replyWithEmbed(interaction, 'Access denied', 'You are not authorized to use this management command.', { ephemeral: true });
    return false;
  }

  async function replyWithEmbed(interaction, title, description, options = {}) {
    const payload = {
      embeds: [createTextEmbed(
        title,
        description,
        options.member === undefined ? interaction.member : options.member,
        options.color
      )],
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      ...(options.components ? { components: options.components } : {})
    };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload);
    }
    return interaction.reply(payload);
  }

  async function hasTicketStaffAccess(interaction) {
    if (await hasCommandAccess(interaction, 'ticket')) return true;
    const settings = await getGuildSettings(interaction.guildId);
    return Boolean(settings.ticket_staff_role_id &&
      interaction.member?.roles?.cache?.has(settings.ticket_staff_role_id));
  }

  async function botCanAssignRole(guild, role) {
    const botMember = guild.members.me || await guild.members.fetchMe();
    return botMember.permissions.has(PermissionFlagsBits.ManageRoles) &&
      !role.managed &&
      role.position < botMember.roles.highest.position;
  }

  async function postTicketPanel(channel, guildId) {
    const { rows: customThemes } = await pool.query(
      'SELECT theme_key, label, description FROM ticket_themes WHERE guild_id = $1 ORDER BY label LIMIT 20',
      [guildId]
    );
    const embed = new EmbedBuilder()
      .setColor(0x7564d8)
      .setAuthor({ name: 'Hawk Client • Support Centre', iconURL: client.user.displayAvatarURL() })
      .setTitle('How can we help you today?')
      .setDescription([
        'Our team is here to help. Select the option that best matches your request and a private ticket will be created.',
        '',
        '🎓 **Staff Application** — Apply to join our team',
        '🚩 **Player Report** — Report a player or rule violation',
        '💬 **General Support** — Get help with anything else',
        '🤝 **Partnership** — Share a partnership proposal and community links',
        '🪲 **Bug Report** — Tell us about a technical issue',
        ...customThemes.map(theme => `• **${theme.label}**`)
      ].join('\n'))
      .addFields({
        name: 'Before you open a ticket',
        value: 'Please choose the right category and share clear, accurate details. Our team will respond as soon as possible.'
      })
      .setFooter({ text: 'Private support • Please do not open duplicate tickets' })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:select')
        .setPlaceholder('🎫  Select a ticket category')
        .addOptions(
          { label: 'Staff Application', description: 'Apply to join the staff team', value: 'staff_application', emoji: '🎓' },
          { label: 'Player Report', description: 'Report a player or rule violation', value: 'player_report', emoji: '🚩' },
          { label: 'General Support', description: 'Get help from our support team', value: 'general_support', emoji: '💬' },
          { label: 'Partnership', description: 'Share a proposal and community links', value: 'partnership', emoji: '🤝' },
          { label: 'Bug Report', description: 'Report a bug or technical issue', value: 'bug_report', emoji: '🪲' },
          ...customThemes.map(theme => ({
            label: theme.label,
            description: theme.description,
            value: theme.theme_key
          }))
        )
    );
    await channel.send({ embeds: [embed], components: [row] });
  }

  async function postApplicationPanel(channel) {
    const embed = new EmbedBuilder()
      .setColor(0x40b8a4)
      .setTitle('Staff applications')
      .setDescription('Interested in joining the staff team? Click **Apply** to answer the questions one at a time in a private channel.');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('application:start').setLabel('Apply').setStyle(ButtonStyle.Success)
    );
    await channel.send({ embeds: [embed], components: [row] });
  }

  function createCommandGuideEmbeds() {
    const commandList = commandSchemas.flatMap(command => {
      const subcommands = command.options?.filter(option => option.type === 1);
      if (!subcommands?.length) {
        const options = command.options?.filter(option => option.type !== 1) || [];
        const usage = options.map(option => option.required ? `<${option.name}>` : `[${option.name}]`).join(' ');
        return [`/${command.name}${usage ? ` ${usage}` : ''} — ${command.description}`];
      }

      return subcommands.map(subcommand => {
        const options = (subcommand.options || [])
          .map(option => option.required ? `<${option.name}>` : `[${option.name}]`)
          .join(' ');
        const usage = `/${command.name} ${subcommand.name}${options ? ` ${options}` : ''}`;
        return `${usage} — ${subcommand.description}`;
      });
    });
    const intro = [
      `${botName} — COMMAND GUIDE`,
      'HOW TO USE',
      'In a server channel, type / and choose a command. Fill in options marked required; options in [brackets] are optional.',
      'Examples: /profile • /invites check • /invites leaderboard',
      'Application setup: /application setup posts the form and sets its review channel. Use /ticket settings to choose a transcript archive and staff access.',
      'Completed applications are closed; the review channel gets a PDF/text Q&A copy with the applicant pinged and Accept/Reject buttons. The applicant is notified by DM.',
      'Invite counts need the bot to have Manage Server and the Guild Invites intent enabled.',
      '',
      'COMMANDS'
    ].join('\n');
    const pages = [];
    let page = intro;
    for (const line of commandList) {
      if (page.length + line.length + 1 > 3500) {
        pages.push(page);
        page = `${botName} — COMMAND GUIDE (CONTINUED)\n`;
      }
      page += `${page.endsWith('\n') ? '' : '\n'}${line}`;
    }
    page += '\n\nRestricted commands are available to the global bot admin, server owner, directly granted members, or members with an authorized role.';
    pages.push(page);
    return pages.map((description, index) => new EmbedBuilder()
      .setColor(0x7564d8)
      .setTitle(`${botName} — Guide ${index + 1}/${pages.length}`)
      .setDescription(description)
      .setFooter({ text: 'Use /commands any time to get this guide in your DMs.' }));
  }

  async function deleteChannelMessages(channel) {
    const twoWeeks = 14 * 24 * 60 * 60 * 1000;
    let before;
    let deletedCount = 0;

    while (true) {
      const options = { limit: 100 };
      if (before) options.before = before;
      const batch = await channel.messages.fetch(options);
      if (batch.size === 0) break;

      const messages = [...batch.values()];
      const oldestMessage = messages.reduce((oldest, message) =>
        message.createdTimestamp < oldest.createdTimestamp ? message : oldest
      );
      const recentMessages = messages.filter(message => Date.now() - message.createdTimestamp < twoWeeks);
      const oldMessages = messages.filter(message => Date.now() - message.createdTimestamp >= twoWeeks);

      if (recentMessages.length > 0) {
        const deleted = await channel.bulkDelete(recentMessages, true);
        deletedCount += deleted.size;
      }
      for (let index = 0; index < oldMessages.length; index += 10) {
        const results = await Promise.allSettled(
          oldMessages.slice(index, index + 10).map(message => message.delete())
        );
        const failures = results.filter(result => result.status === 'rejected');
        deletedCount += results.length - failures.length;
        if (failures.length > 0) {
          throw new Error(`Could not delete ${failures.length} older message(s): ${failures[0].reason.message}`);
        }
      }

      before = oldestMessage.id;
    }

    return deletedCount;
  }

  function getClearPermissionError(channel) {
    const permissions = channel.permissionsFor(client.user);
    if (!permissions?.has([
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages
    ])) {
      return 'I need Manage Messages, Read Message History, and Send Messages in this channel to clear it and notify players.';
    }
    return null;
  }

  function createGiveawayControls(giveawayId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway:enter:${giveawayId}`)
        .setLabel('Enter giveaway')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success)
    );
  }

  function scheduleGiveaway(giveawayId, endsAt) {
    const timer = setTimeout(() => {
      giveawayTimers.delete(giveawayId);
      finishGiveaway(giveawayId).catch(error => console.error(`Unable to finish giveaway ${giveawayId}:`, error));
    }, Math.max(0, new Date(endsAt).getTime() - Date.now()));
    giveawayTimers.set(giveawayId, timer);
  }

  async function finishGiveaway(giveawayId) {
    const { rows } = await pool.query(
      `UPDATE giveaways SET status = 'finished'
      WHERE id = $1 AND status = 'open'
      RETURNING guild_id, channel_id, prize, winner_count`,
      [giveawayId]
    );
    const giveaway = rows[0];
    if (!giveaway) return;
    const { rows: entries } = await pool.query(
      'SELECT user_id FROM giveaway_entries WHERE giveaway_id = $1',
      [giveawayId]
    );
    const participants = entries.map(entry => entry.user_id);
    const winners = [];
    while (participants.length && winners.length < Number(giveaway.winner_count)) {
      winners.push(participants.splice(randomInt(participants.length), 1)[0]);
    }
    const channel = await client.channels.fetch(giveaway.channel_id);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Giveaway channel ${giveaway.channel_id} is unavailable.`);
    }
    const result = winners.length
      ? `Winner${winners.length > 1 ? 's' : ''}: ${winners.map(id => `<@${id}>`).join(', ')}`
      : 'No valid entries were received.';
    await channel.send({
      embeds: [createTextEmbed('Giveaway ended', `**Prize:** ${giveaway.prize}\n${result}`, null, 0x40b8a4)]
    });
  }

  async function createTicket(interaction, kind, questions = [], customLabel) {
    const { rows: blockedRoles } = await pool.query(
      'SELECT role_id FROM ticket_blocked_roles WHERE guild_id = $1',
      [interaction.guildId]
    );
    const memberRoles = interaction.member?.roles?.cache;
    if (memberHasBlockedRole(
      memberRoles?.keys() || [],
      blockedRoles.map(({ role_id: roleId }) => roleId)
    )) {
      await replyWithEmbed(
        interaction,
        'Ticket access unavailable',
        'A role assigned to you is not allowed to open tickets in this server.',
        { ephemeral: true }
      );
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const settings = await getGuildSettings(interaction.guildId);
    const type = ticketType(kind, customLabel);
    const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 18) || 'member';
    const channelPrefix = kind.replaceAll('_', '-');
    const channel = await interaction.guild.channels.create({
      name: `${channelPrefix}-${safeName}`.slice(0, 90),
      topic: `${type.label} ticket for ${interaction.user.tag} (${interaction.user.id})`,
      type: ChannelType.GuildText,
      parent: settings.ticket_category_id || undefined,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
        },
        ...(settings.ticket_staff_role_id ? [{
          id: settings.ticket_staff_role_id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
        }] : []),
        {
          id: client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory]
        }
      ]
    });

    await pool.query(
      'INSERT INTO tickets (channel_id, guild_id, opener_id, kind, application_questions) VALUES ($1, $2, $3, $4, $5)',
      [channel.id, interaction.guildId, interaction.user.id, kind, JSON.stringify(questions)]
    );
    const closeRow = createTicketControls();
    const ticketDetails = [
      `Hello ${interaction.member.displayName}, your private ${type.label.toLowerCase()} ticket is ready.`,
      `**Category:** ${type.label}`,
      '**Status:** Open',
      questions.length
        ? 'Please answer the application questions below one at a time.'
        : ticketOpeningPrompt(kind)
    ].join('\n\n');
    await replyWithEmbed(interaction, `${type.label} ticket ready`, `Your private ticket is ready: ${channel}`, {
      ephemeral: true
    });
    await channel.send({
      embeds: [createTextEmbed(`${type.label} • Private Ticket`, ticketDetails, interaction.member)],
      components: [closeRow]
    });

    if (questions.length > 0) {
      await sendStyledMemberMessage(
        channel,
        interaction.member,
        `APPLICATION FORM • STEP 1/${questions.length}`,
        questions[0]
      );
      await pool.query('UPDATE tickets SET question_index = 1 WHERE channel_id = $1', [channel.id]);
    }
  }

  function createTicketControls(claimedBy) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:claim')
        .setLabel(claimedBy ? 'Ticket claimed' : 'Claim ticket')
        .setEmoji(claimedBy ? '✅' : '🙋')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(Boolean(claimedBy)),
      new ButtonBuilder()
        .setCustomId('ticket:close')
        .setLabel('Close ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger)
    );
  }

  function createApplicationReviewControls(channelId, applicantId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`application:review:accept:${channelId}:${applicantId}`)
        .setLabel('Accept')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`application:review:reject:${channelId}:${applicantId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
    );
  }

  function ticketType(kind, customLabel) {
    const types = {
      staff_application: { emoji: '🎓', label: 'Staff Application' },
      player_report: { emoji: '🚩', label: 'Player Report' },
      general_support: { emoji: '💬', label: 'General Support' },
      partnership: { emoji: '🤝', label: 'Partnership' },
      bug_report: { emoji: '🪲', label: 'Bug Report' }
    };
    return types[kind] || { emoji: '🎫', label: customLabel || 'Support' };
  }

  function ticketOpeningPrompt(kind) {
    if (kind === 'player_report') {
      return 'Please provide the player’s username, what happened, when it happened, and any evidence or screenshots you have.';
    }
    if (kind === 'bug_report') {
      return 'Please describe the issue, the steps to reproduce it, what you expected to happen, and any screenshots or error messages.';
    }
    if (kind === 'partnership') {
      return 'Please share your community name, a short partnership proposal, and the relevant invite or website links. Links are allowed in this ticket.';
    }
    return 'Please describe what you need help with. Share any relevant details so our team can assist you quickly.';
  }

  async function sendMemberBanner(channel, member, message, bannerText, title) {
    const content = applyTemplate(message, member, member.guild)
      .replaceAll(`<@${member.id}>`, `**${member.displayName}**`)
      .replaceAll(`<@!${member.id}>`, `**${member.displayName}**`);
    const heading = title === 'welcome' ? 'Welcome to the server' : 'Goodbye for now';
    const description = [content, bannerText].filter(Boolean).join('\n\n');
    await channel.send({ embeds: [createTextEmbed(heading, description, member, 0x40b8a4)] });
  }

  async function sendStyledMemberMessage(channel, member, heading, message, components = []) {
    return channel.send({
      embeds: [createTextEmbed(heading, message, member)],
      ...(components.length ? { components } : {})
    });
  }

  async function sendModerationLog(guild, settings, title, description) {
    if (!settings.moderation_log_channel_id) return;
    const channel = await guild.channels.fetch(settings.moderation_log_channel_id);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Configured moderation log channel ${settings.moderation_log_channel_id} is unavailable.`);
    }
    await channel.send({
      embeds: [createTextEmbed(title, description, null, 0xd96b72)]
    });
  }

  async function logModerationAction(guild, settings, title, description) {
    try {
      await sendModerationLog(guild, settings, title, description);
    } catch (error) {
      console.error(`Unable to write moderation log "${title}":`, error);
    }
  }

  async function saveTicketTranscript(channel, guildId, openerId, kind) {
    const settings = await getGuildSettings(guildId);
    if (!settings.transcript_channel_id) return false;
    const destination = await channel.guild.channels.fetch(settings.transcript_channel_id);
    if (!destination?.isTextBased() || destination.isDMBased()) {
      throw new Error(`Configured transcript channel ${settings.transcript_channel_id} is unavailable.`);
    }
    const messages = [];
    let before;
    while (messages.length < 1000) {
      const batch = await channel.messages.fetch({
        limit: Math.min(100, 1000 - messages.length),
        ...(before ? { before } : {})
      });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      before = batch.last().id;
    }
    const opener = messages.find(message => message.author.id === openerId)?.author;
    const openerName = opener?.username || 'Unknown member';
    const transcript = [
      `Ticket transcript: ${channel.name}`,
      `Guild: ${channel.guild.name} (${guildId})`,
      `Category: ${ticketType(kind).label}`,
      `Opened by: ${openerName} (${openerId})`,
      `Captured: ${new Date().toISOString()}`,
      messages.length >= 1000 ? '[Transcript truncated at 1000 messages]' : '',
      '',
      ...messages.reverse().map(message => {
        const body = message.content || '';
        const attachmentUrls = [...message.attachments.values()].map(item => item.url);
        const embedText = message.embeds.map(embed => [embed.title, embed.description].filter(Boolean).join('\n')).filter(Boolean);
        const detail = [body, ...attachmentUrls, ...embedText].filter(Boolean).join('\n');
        return `[${message.createdAt.toISOString()}] ${message.author.tag}: ${detail || '[no text content]'}`;
      })
    ].join('\n');
    const pdf = new AttachmentBuilder(await createPdfBuffer(transcript), {
      name: `ticket-${channel.id}.pdf`
    });
    const text = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
      name: `ticket-${channel.id}.txt`
    });
    await destination.send({
      content: `<@${openerId}> • **${openerName}**`,
      allowedMentions: { users: [openerId] },
      embeds: [createTextEmbed('Ticket transcript saved', `Transcript for <#${channel.id}> • applicant: **${openerName}**.`, null)],
      files: [pdf, text]
    });
    return true;
  }

  async function getAnnouncementChannel(guild, configuredChannelId) {
    const botMember = guild.members.me || await guild.members.fetchMe();
    const requiredPermissions = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (configuredChannelId) {
      const channel = await guild.channels.fetch(configuredChannelId);
      if (!channel?.isTextBased() || channel.isDMBased() ||
          !channel.permissionsFor(botMember)?.has(requiredPermissions)) {
        throw new Error(`Configured announcement channel ${configuredChannelId} is unavailable or lacks send-message/embed permissions.`);
      }
      return channel;
    }

    const systemChannel = guild.systemChannel;
    if (systemChannel?.permissionsFor(botMember)?.has(requiredPermissions)) {
      return systemChannel;
    }
    const channel = guild.channels.cache.find(candidate =>
      candidate.isTextBased() &&
      !candidate.isDMBased() &&
      candidate.permissionsFor(botMember)?.has(requiredPermissions)
    );
    if (!channel) throw new Error(`No sendable text channel found in guild ${guild.id}.`);
    return channel;
  }

  async function handleManagementCommand(interaction, commandName) {
    if (!(await requireCommandAccess(interaction, commandName))) return;
    const subcommand = interaction.options.getSubcommand();

    if (commandName === 'permissions') {
      if (interaction.user.id !== interaction.guild.ownerId &&
          !isGlobalCommandAdmin(interaction.user.id)) {
        await replyWithEmbed(interaction, 'Owner only', 'Only this server owner or the configured global command admin can grant or revoke command access.', { ephemeral: true });
        return;
      }
      const command = interaction.options.getString('command');
      const role = interaction.options.getRole('role');
      const member = interaction.options.getUser('member');
      if (Boolean(role) === Boolean(member)) {
        await replyWithEmbed(interaction, 'Choose one target', 'Select exactly one role or member to grant or revoke access.', { ephemeral: true });
        return;
      }
      const target = role || member;
      const targetName = role ? `${role}` : `**${member.tag}**`;
      if (subcommand === 'grant') {
        if (role) {
          await pool.query(
            'INSERT INTO command_roles (guild_id, command_name, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [interaction.guildId, command, role.id]
          );
        } else {
          await pool.query(
            'INSERT INTO command_users (guild_id, command_name, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [interaction.guildId, command, member.id]
          );
        }
        await replyWithEmbed(interaction, 'Permission granted', `${targetName} can now use \`/${command}\`.`, { ephemeral: true });
      } else {
        if (role) {
          await pool.query(
            'DELETE FROM command_roles WHERE guild_id = $1 AND command_name = $2 AND role_id = $3',
            [interaction.guildId, command, role.id]
          );
        } else {
          await pool.query(
            'DELETE FROM command_users WHERE guild_id = $1 AND command_name = $2 AND user_id = $3',
            [interaction.guildId, command, member.id]
          );
        }
        await replyWithEmbed(interaction, 'Permission removed', `Removed ${targetName}'s access to \`/${command}\`.`, { ephemeral: true });
      }
      return;
    }

    if (commandName === 'ticket') {
      if (subcommand === 'panel') {
        const channel = interaction.options.getChannel('channel');
        if (!channel.isTextBased()) {
          await replyWithEmbed(interaction, 'Invalid channel', 'Choose a text channel.', { ephemeral: true });
          return;
        }
        await postTicketPanel(channel, interaction.guildId);
        await replyWithEmbed(interaction, 'Ticket panel posted', `The public ticket panel is now available in ${channel}.`, { ephemeral: true });
      } else if (subcommand === 'theme-add') {
        const key = interaction.options.getString('key').trim().toLowerCase();
        const label = interaction.options.getString('label').trim();
        const description = interaction.options.getString('description').trim();
        const questions = (interaction.options.getString('questions') || '')
          .split(/\r?\n/).map(question => question.trim()).filter(Boolean);
        if (!/^[a-z0-9_-]{1,20}$/.test(key) || ['staff_application', 'player_report', 'general_support', 'partnership', 'bug_report'].includes(key) || !label || !description || questions.length > 20) {
          await replyWithEmbed(interaction, 'Invalid ticket theme', 'Use a key of 1–20 letters, numbers, underscores, or hyphens; enter a label, description, and no more than 20 questions.', { ephemeral: true });
          return;
        }
        const { rows: themes } = await pool.query(
          'SELECT COUNT(*) AS count FROM ticket_themes WHERE guild_id = $1',
          [interaction.guildId]
        );
        const { rows: existing } = await pool.query(
          'SELECT theme_key FROM ticket_themes WHERE guild_id = $1 AND theme_key = $2',
          [interaction.guildId, key]
        );
        if (!existing.length && Number(themes[0].count) >= 20) {
          await replyWithEmbed(interaction, 'Ticket theme limit reached', 'A panel can show at most 20 custom themes alongside the five built-in themes.', { ephemeral: true });
          return;
        }
        await pool.query(
          `INSERT INTO ticket_themes (guild_id, theme_key, label, description, questions)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (guild_id, theme_key) DO UPDATE
          SET label = EXCLUDED.label, description = EXCLUDED.description, questions = EXCLUDED.questions`,
          [interaction.guildId, key, label, description, JSON.stringify(questions)]
        );
        await replyWithEmbed(interaction, 'Ticket theme saved', `Saved **${label}**. Post a new /ticket panel to publish the updated list.`, { ephemeral: true });
      } else if (subcommand === 'theme-remove') {
        const key = interaction.options.getString('key').trim().toLowerCase();
        const result = await pool.query(
          'DELETE FROM ticket_themes WHERE guild_id = $1 AND theme_key = $2',
          [interaction.guildId, key]
        );
        await replyWithEmbed(interaction, result.rowCount ? 'Ticket theme removed' : 'Ticket theme not found', result.rowCount ? `Removed \`${key}\`. Repost the ticket panel to update it.` : `No custom theme \`${key}\` was found.`, { ephemeral: true });
      } else if (subcommand === 'block-role' || subcommand === 'unblock-role') {
        const role = interaction.options.getRole('role');
        if (subcommand === 'block-role') {
          await pool.query(
            'INSERT INTO ticket_blocked_roles (guild_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [interaction.guildId, role.id]
          );
          await replyWithEmbed(interaction, 'Ticket access restricted', `${role} can no longer open tickets.`, { ephemeral: true });
        } else {
          const result = await pool.query(
            'DELETE FROM ticket_blocked_roles WHERE guild_id = $1 AND role_id = $2',
            [interaction.guildId, role.id]
          );
          await replyWithEmbed(interaction, result.rowCount ? 'Ticket access restored' : 'Role was not blocked', result.rowCount ? `${role} can open tickets again.` : `${role} was not blocked from opening tickets.`, { ephemeral: true });
        }
      } else {
        const category = interaction.options.getChannel('category');
        const staffRole = interaction.options.getRole('staff_role');
        const transcriptChannel = interaction.options.getChannel('transcript_channel');
        const reviewChannel = interaction.options.getChannel('review_channel');
        const applicationStaffRole = interaction.options.getRole('staff_role_to_apply');
        const updates = {};
        if ([transcriptChannel, reviewChannel].some(channel =>
          channel && (!channel.isTextBased() || channel.isDMBased())
        )) {
          await replyWithEmbed(interaction, 'Invalid channel', 'Transcript and application review destinations must be server text channels.', { ephemeral: true });
          return;
        }
        if (applicationStaffRole && !(await botCanAssignRole(interaction.guild, applicationStaffRole))) {
          await replyWithEmbed(interaction, 'Role cannot be assigned', 'The bot needs Manage Roles, and the application role must be below its highest role.', { ephemeral: true });
          return;
        }
        if (category) {
          if (category.type !== ChannelType.GuildCategory) {
            await replyWithEmbed(interaction, 'Invalid category', 'The category option must be a server category.', { ephemeral: true });
            return;
          }
          updates.ticket_category_id = category.id;
        }
        if (staffRole) updates.ticket_staff_role_id = staffRole.id;
        if (transcriptChannel) updates.transcript_channel_id = transcriptChannel.id;
        if (reviewChannel) updates.application_review_channel_id = reviewChannel.id;
        if (applicationStaffRole) updates.application_staff_role_id = applicationStaffRole.id;
        if (Object.keys(updates).length === 0) {
          await replyWithEmbed(interaction, 'Missing settings', 'Choose at least one ticket category, staff role, transcript channel, review channel, or application role.', { ephemeral: true });
          return;
        }
        await updateGuildSettings(interaction.guildId, updates);
        await replyWithEmbed(interaction, 'Ticket settings saved', 'Your selected ticket category, staff access, transcript, and application review settings have been updated.', { ephemeral: true });
      }
      return;
    }

    if (commandName === 'application') {
      const channel = interaction.options.getChannel('channel');
      const questions = interaction.options.getString('questions').split(/\r?\n/).map(question => question.trim()).filter(Boolean);
      const reviewChannel = interaction.options.getChannel('review_channel');
      const staffRole = interaction.options.getRole('staff_role');
      if (!channel.isTextBased() || channel.isDMBased() ||
          !reviewChannel || !reviewChannel.isTextBased() || reviewChannel.isDMBased() ||
          questions.length === 0 || questions.length > 20) {
        await replyWithEmbed(interaction, 'Invalid application setup', 'Choose a panel channel, a review text channel, and provide between 1 and 20 questions, one per line.', { ephemeral: true });
        return;
      }
      if (staffRole && !(await botCanAssignRole(interaction.guild, staffRole))) {
        await replyWithEmbed(interaction, 'Role cannot be assigned', 'The bot needs Manage Roles, and the application role must be below its highest role.', { ephemeral: true });
        return;
      }
      await updateGuildSettings(interaction.guildId, {
        application_channel_id: channel.id,
        application_questions: JSON.stringify(questions),
        ...(reviewChannel ? { application_review_channel_id: reviewChannel.id } : {}),
        ...(staffRole ? { application_staff_role_id: staffRole.id } : {})
      });
      await postApplicationPanel(channel);
      await replyWithEmbed(interaction, 'Application panel posted', `The panel is live in ${channel} with ${questions.length} questions.`, { ephemeral: true });
      return;
    }

    if (commandName === 'automod') {
      if (subcommand === 'status') {
        const { rows } = await pool.query('SELECT term FROM automod_terms WHERE guild_id = $1 ORDER BY term', [interaction.guildId]);
        const settings = await getGuildSettings(interaction.guildId);
        await replyWithEmbed(
          interaction,
          'Automod filter',
          `${rows.length ? `Filtered terms: ${rows.map(row => `\`${row.term}\``).join(', ')}` : 'No custom filter terms are configured.'}\nLink removal: **${settings.links_enabled ? 'enabled' : 'disabled'}**`,
          { ephemeral: true }
        );
        return;
      }
      if (subcommand === 'links') {
        const enabled = interaction.options.getBoolean('enabled');
        await updateGuildSettings(interaction.guildId, { links_enabled: enabled });
        await replyWithEmbed(interaction, 'Link filter updated', `Automatic link removal is now **${enabled ? 'enabled' : 'disabled'}**.`, { ephemeral: true });
        return;
      }
      const term = interaction.options.getString('term').trim().toLocaleLowerCase();
      if (!term) {
        await replyWithEmbed(interaction, 'Invalid filter term', 'The filter term cannot be empty.', { ephemeral: true });
        return;
      }
      if (subcommand === 'add-word') {
        await pool.query('INSERT INTO automod_terms (guild_id, term) VALUES ($1, $2) ON CONFLICT DO NOTHING', [interaction.guildId, term]);
        await replyWithEmbed(interaction, 'Filter term added', `Added \`${term}\` to the case-insensitive filter.`, { ephemeral: true });
      } else {
        await pool.query('DELETE FROM automod_terms WHERE guild_id = $1 AND term = $2', [interaction.guildId, term]);
        await replyWithEmbed(interaction, 'Filter term removed', `Removed \`${term}\` from the filter.`, { ephemeral: true });
      }
      return;
    }

    if (commandName === 'welcome' || commandName === 'leave') {
      const channel = interaction.options.getChannel('channel');
      if (!channel.isTextBased()) {
        await replyWithEmbed(interaction, 'Invalid channel', 'Choose a text channel.', { ephemeral: true });
        return;
      }
      const prefix = commandName === 'welcome' ? 'welcome' : 'leave';
      await updateGuildSettings(interaction.guildId, {
        [`${prefix}_channel_id`]: channel.id,
        [`${prefix}_message`]: interaction.options.getString('message') ||
          (commandName === 'welcome' ? DEFAULT_WELCOME_MESSAGE : DEFAULT_LEAVE_MESSAGE),
        [`${prefix}_banner`]: interaction.options.getString('banner_text')
      });
      await replyWithEmbed(
        interaction,
        `${commandName === 'welcome' ? 'Welcome' : 'Leave'} settings saved`,
        `${commandName} messages will be posted in ${channel}. ${interaction.options.getString('message') ? 'Your custom message is saved.' : 'The professional default message will be used.'}`,
        { ephemeral: true }
      );
      return;
    }

    if (commandName === 'autorole') {
      if (subcommand === 'disable') {
        await updateGuildSettings(interaction.guildId, { auto_role_id: null });
        await replyWithEmbed(interaction, 'Automatic role disabled', 'New members will no longer receive an automatic role.', { ephemeral: true });
        return;
      }
      const role = interaction.options.getRole('role');
      if (!(await botCanAssignRole(interaction.guild, role))) {
        await replyWithEmbed(interaction, 'Role cannot be assigned', 'The bot needs Manage Roles, and you must choose a non-managed role below its highest role.', { ephemeral: true });
        return;
      }
      await updateGuildSettings(interaction.guildId, { auto_role_id: role.id });
      await replyWithEmbed(interaction, 'Automatic role configured', `${role} will be given to new members.`, { ephemeral: true });
      return;
    }

    if (commandName === 'scamguard') {
      if (subcommand === 'disable') {
        await updateGuildSettings(interaction.guildId, {
          scamguard_channel_id: null,
          scamguard_terms: JSON.stringify([])
        });
        await replyWithEmbed(interaction, 'Scam guard disabled', 'Phrase-based scam enforcement is disabled.', { ephemeral: true });
        return;
      }
      const channel = interaction.options.getChannel('channel');
      const terms = interaction.options.getString('terms').split(/\r?\n/).map(term => term.trim()).filter(Boolean);
      if (!channel.isTextBased() || terms.length === 0 || terms.length > 20) {
        await replyWithEmbed(interaction, 'Invalid scam guard setup', 'Choose a text channel and provide 1–20 phrases, one per line.', { ephemeral: true });
        return;
      }
      await updateGuildSettings(interaction.guildId, {
        scamguard_channel_id: channel.id,
        scamguard_terms: JSON.stringify(terms)
      });
      await replyWithEmbed(interaction, 'Scam guard configured', `Exact phrase enforcement is active in ${channel}. Matching messages are removed and their authors are kicked.`, { ephemeral: true });
      return;
    }

    if (commandName === 'logs') {
      const channel = interaction.options.getChannel('channel');
      if (!channel.isTextBased()) {
        await replyWithEmbed(interaction, 'Invalid channel', 'Choose a text channel.', { ephemeral: true });
        return;
      }
      await updateGuildSettings(interaction.guildId, { moderation_log_channel_id: channel.id });
      await replyWithEmbed(interaction, 'Moderation logs configured', `Staff actions will be logged in ${channel}.`, { ephemeral: true });
      return;
    }

    if (commandName === 'autoreply' || commandName === 'trigger') {
      const table = commandName === 'trigger' ? 'triggers' : 'auto_replies';
      const value = interaction.options.getString(commandName === 'trigger' ? 'word' : 'keyword')
        .trim().toLocaleLowerCase();
      if (subcommand === 'add') {
        const response = interaction.options.getString('response');
        await pool.query(
          `INSERT INTO ${table} (guild_id, keyword, response) VALUES ($1, $2, $3)
          ON CONFLICT (guild_id, keyword) DO UPDATE SET response = EXCLUDED.response`,
          [interaction.guildId, value, response]
        );
        await replyWithEmbed(interaction, commandName === 'trigger' ? 'Trigger saved' : 'Auto-reply saved', `The case-insensitive reply for \`${value}\` is ready.`, { ephemeral: true });
      } else {
        const result = await pool.query(`DELETE FROM ${table} WHERE guild_id = $1 AND keyword = $2`, [interaction.guildId, value]);
        await replyWithEmbed(
          interaction,
          result.rowCount ? (commandName === 'trigger' ? 'Trigger removed' : 'Auto-reply removed') : (commandName === 'trigger' ? 'No trigger found' : 'No auto-reply found'),
          result.rowCount ? `Removed \`${value}\`.` : `No reply was set for \`${value}\`.`,
          { ephemeral: true }
        );
      }
    }
  }

  async function handleInteraction(interaction) {
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:select') {
      const kind = interaction.values[0];
      if (['player_report', 'general_support', 'partnership', 'bug_report'].includes(kind)) {
        await createTicket(interaction, kind);
        return;
      }
      if (kind === 'staff_application') {
        const settings = await getGuildSettings(interaction.guildId);
        const questions = settings.application_questions || [];
        if (questions.length === 0) {
          await interaction.reply({
            embeds: [createTextEmbed('Applications are closed', 'Staff applications are not open yet. Please contact a server administrator.', interaction.member)],
            ephemeral: true
          });
          return;
        }
        await createTicket(interaction, kind, questions);
        return;
      }
      const { rows: themes } = await pool.query(
        'SELECT label, questions FROM ticket_themes WHERE guild_id = $1 AND theme_key = $2',
        [interaction.guildId, kind]
      );
      if (themes.length) {
        await createTicket(interaction, kind, themes[0].questions || [], themes[0].label);
        return;
      }
      await replyWithEmbed(interaction, 'Ticket category unavailable', 'Please select one of the available ticket categories.', { ephemeral: true });
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('giveaway:enter:')) {
        const giveawayId = interaction.customId.split(':')[2];
        const { rows: giveaways } = await pool.query(
          'SELECT id FROM giveaways WHERE id = $1 AND guild_id = $2 AND status = $3',
          [giveawayId, interaction.guildId, 'open']
        );
        if (!giveaways.length) {
          await replyWithEmbed(interaction, 'Giveaway ended', 'This giveaway is no longer accepting entries.', { ephemeral: true });
          return;
        }
        const { rows: entry } = await pool.query(
          `INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES ($1, $2)
          ON CONFLICT DO NOTHING RETURNING user_id`,
          [giveawayId, interaction.user.id]
        );
        await replyWithEmbed(
          interaction,
          entry.length ? 'Entry confirmed' : 'Already entered',
          entry.length ? 'You are entered in this giveaway. Good luck!' : 'You already have an entry in this giveaway.',
          { ephemeral: true }
        );
        return;
      }
      if (interaction.customId.startsWith('clear:cancel:')) {
        const initiatorId = interaction.customId.split(':')[2];
        if (interaction.user.id !== initiatorId) {
          await replyWithEmbed(interaction, 'Confirmation owner only', 'Only the person who started this cleanup can cancel it.', { ephemeral: true });
          return;
        }
        await interaction.update({
          content: null,
          embeds: [createTextEmbed('Cleanup cancelled', 'No messages were deleted.', interaction.member)],
          components: []
        });
        return;
      }
      if (interaction.customId.startsWith('clear:confirm:')) {
        const [, , ownerId, channelId] = interaction.customId.split(':');
        if (interaction.user.id !== ownerId) {
          await replyWithEmbed(interaction, 'Confirmation owner only', 'Only the person who started this cleanup can confirm it.', { ephemeral: true });
          return;
        }
        if (!(await hasCommandAccess(interaction, 'clear'))) {
          await replyWithEmbed(interaction, 'Access revoked', 'You no longer have permission to clear this channel.', { ephemeral: true });
          return;
        }
        if (interaction.channelId !== channelId || !interaction.channel?.messages) {
          await replyWithEmbed(interaction, 'Confirmation expired', 'This confirmation is no longer valid in this channel.', { ephemeral: true });
          return;
        }
        const permissionError = getClearPermissionError(interaction.channel);
        if (permissionError) {
          await replyWithEmbed(interaction, 'Missing permissions', permissionError, { ephemeral: true });
          return;
        }
        await interaction.update({
          content: null,
          embeds: [createTextEmbed('Cleaning channel', 'Deleting messages. Please wait…', interaction.member)],
          components: []
        });
        const deletedCount = await deleteChannelMessages(interaction.channel);
        let noticeError;
        try {
          await sendStyledMemberMessage(
            interaction.channel,
            interaction.member,
            'CHANNEL CLEANUP',
            `Channel cleanup complete — ${deletedCount} message${deletedCount === 1 ? '' : 's'} deleted by ${interaction.user.tag}.`
          );
        } catch (error) {
          noticeError = error;
          console.error(`Channel was cleared, but the public cleanup notice failed in ${interaction.channelId}:`, error);
        }
        await replyWithEmbed(
          interaction,
          noticeError ? 'Cleanup finished with a notice error' : 'Channel cleanup complete',
          noticeError
            ? `Deleted ${deletedCount} messages, but I could not post the public notice: ${noticeError.message}`
            : `Deleted ${deletedCount} messages and posted a notice for players in this channel.`
        );
        return;
      }
      if (interaction.customId.startsWith('application:review:')) {
        if (!(await hasTicketStaffAccess(interaction))) {
          await replyWithEmbed(interaction, 'Staff only', 'Only ticket-authorized staff can review applications.', { ephemeral: true });
          return;
        }
        const [, , action, channelId, applicantId] = interaction.customId.split(':');
        if (!['accept', 'reject'].includes(action)) {
          await replyWithEmbed(interaction, 'Invalid review action', 'This application review button is not valid.', { ephemeral: true });
          return;
        }
        const { rows } = await pool.query(
          'SELECT opener_id, status, kind FROM tickets WHERE channel_id = $1',
          [channelId]
        );
        const ticket = rows[0];
        if (!ticket || ticket.opener_id !== applicantId || ticket.status !== 'pending_review') {
          await replyWithEmbed(interaction, 'Application unavailable', 'This application has already been reviewed or its ticket no longer exists.', { ephemeral: true });
          return;
        }
        const status = action === 'accept' ? 'accepted' : 'rejected';
        const { rows: updated } = await pool.query(
          `UPDATE tickets SET status = $2 WHERE channel_id = $1 AND status = 'pending_review' RETURNING opener_id`,
          [channelId, status]
        );
        if (!updated.length) {
          await replyWithEmbed(interaction, 'Application already reviewed', 'Another staff member has already reviewed this application.', { ephemeral: true });
          return;
        }
        const settings = await getGuildSettings(interaction.guildId);
        let roleGranted = false;
        let applicantUser;
        if (action === 'accept' && ticket.kind === 'staff_application' && settings.application_staff_role_id) {
          try {
            const applicant = await interaction.guild.members.fetch(applicantId);
            applicantUser = applicant.user;
            await applicant.roles.add(settings.application_staff_role_id, `Application accepted by ${interaction.user.tag}`);
            roleGranted = true;
          } catch (error) {
            await pool.query(
              "UPDATE tickets SET status = 'pending_review' WHERE channel_id = $1 AND status = 'accepted'",
              [channelId]
            );
            throw new Error(`Application status was restored because the staff role could not be assigned: ${error.message}`);
          }
        }
        let applicantNotified = false;
        let applicantNotificationError;
        try {
          applicantUser ||= await client.users.fetch(applicantId);
          await applicantUser.send({
            embeds: [createTextEmbed(
              `Staff application ${status}`,
              action === 'accept'
                ? `Congratulations! Your staff application in **${interaction.guild.name}** was accepted.${roleGranted ? ' Your staff role has been assigned.' : ''}`
                : `Your staff application in **${interaction.guild.name}** was not accepted this time.`,
              applicantUser,
              action === 'accept' ? 0x40b8a4 : 0xd96b72
            )]
          });
          applicantNotified = true;
        } catch (error) {
          applicantNotificationError = error;
          console.error(`Unable to DM application decision to applicant ${applicantId}:`, error);
        }
        await logModerationAction(
          interaction.guild,
          settings,
          `Application ${status}`,
          `Applicant: <@${applicantId}>\nReviewed by: ${interaction.user.tag}\nClosed application ticket ID: ${channelId}`
        );
        await interaction.message.edit({
          embeds: [createTextEmbed(
            `Application ${status}`,
            `Applicant: <@${applicantId}>\nReviewed by ${interaction.user.tag}.\n${applicantNotified ? 'Applicant notified by DM.' : 'Applicant DM could not be delivered.'}`,
            null,
            status === 'accepted' ? 0x40b8a4 : 0xd96b72
          )],
          attachments: [...interaction.message.attachments.keys()].map(id => ({ id })),
          components: []
        });
        const roleResult = roleGranted ? ' The configured staff role was assigned.' : '';
        const notificationResult = applicantNotified
          ? ' The applicant was notified by DM.'
          : ` The DM could not be delivered${applicantNotificationError ? `: ${applicantNotificationError.message}` : '.'}`;
        await replyWithEmbed(interaction, `Application ${status}`, `Review completed.${roleResult}${notificationResult}`, { ephemeral: true });
        return;
      }
      if (interaction.customId.startsWith('ticket:create:')) {
        const kind = interaction.customId.split(':')[2];
        await createTicket(interaction, kind);
        return;
      }
      if (interaction.customId === 'application:start') {
        const settings = await getGuildSettings(interaction.guildId);
        const questions = settings.application_questions || [];
        if (!questions.length) {
          await replyWithEmbed(interaction, 'Applications are closed', 'The staff application form is not configured yet.', { ephemeral: true });
          return;
        }
        await createTicket(interaction, 'staff_application', questions);
        return;
      }
      if (interaction.customId === 'ticket:claim') {
        if (!(await hasTicketStaffAccess(interaction))) {
          await replyWithEmbed(interaction, 'Staff only', 'Only ticket-authorized staff can claim this ticket.', { ephemeral: true });
          return;
        }
        const { rows } = await pool.query(
          `UPDATE tickets SET claimed_by = $2
          WHERE channel_id = $1 AND status IN ('open', 'pending_review') AND claimed_by IS NULL
          RETURNING claimed_by`,
          [interaction.channelId, interaction.user.id]
        );
        if (rows.length === 0) {
          await replyWithEmbed(interaction, 'Ticket unavailable', 'This ticket has already been claimed or is closed.', { ephemeral: true });
          return;
        }
        const embed = interaction.message.embeds[0]
          ? EmbedBuilder.from(interaction.message.embeds[0]).setFooter({
            text: `Claimed by ${interaction.user.tag} • ${botName} Support`
          })
          : undefined;
        await interaction.update({
          ...(embed ? { embeds: [embed] } : {}),
          components: [createTicketControls(interaction.user.id)]
        });
        return;
      }
      if (interaction.customId === 'ticket:close') {
        const { rows } = await pool.query('SELECT opener_id, status, kind FROM tickets WHERE channel_id = $1', [interaction.channelId]);
        const ticket = rows[0];
        if (!ticket || !['open', 'pending_review'].includes(ticket.status)) {
          await replyWithEmbed(interaction, 'Ticket unavailable', 'This ticket is already closed or is not registered.', { ephemeral: true });
          return;
        }
        if (!(await hasTicketStaffAccess(interaction))) {
          await replyWithEmbed(interaction, 'Staff only', 'Only the global bot admin, server owner, or ticket-authorized staff can delete this ticket.', { ephemeral: true });
          return;
        }
        const transcriptSaved = await saveTicketTranscript(
          interaction.channel,
          interaction.guildId,
          ticket.opener_id,
          ticket.kind
        );
        await pool.query("UPDATE tickets SET status = 'closed' WHERE channel_id = $1", [interaction.channelId]);
        await replyWithEmbed(
          interaction,
          'Ticket closed',
          `This channel will be deleted in 5 seconds.${transcriptSaved ? ' A transcript was saved.' : ' No transcript channel is configured, so no transcript was saved.'}`,
          { ephemeral: true }
        );
        setTimeout(() => interaction.channel.delete('Ticket closed').catch(error => console.error('Unable to delete closed ticket:', error)), 5000);
        await sendStyledMemberMessage(
          interaction.channel,
          interaction.member,
          'TICKET CLOSED',
          'This private ticket is now closed and will be deleted in 5 seconds.'
        );
      }
      return;
    }

    if (!interaction.isChatInputCommand() || !interaction.guildId) return;
    const { commandName } = interaction;

    if (commandName === 'clear') {
      if (!(await requireCommandAccess(interaction, 'clear'))) return;
      if (!interaction.channel?.messages) {
        await replyWithEmbed(interaction, 'Text channel required', 'This command can only be used in a text channel.', { ephemeral: true });
        return;
      }
      const permissionError = getClearPermissionError(interaction.channel);
      if (permissionError) {
        await replyWithEmbed(interaction, 'Missing permissions', permissionError, { ephemeral: true });
        return;
      }
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`clear:confirm:${interaction.user.id}:${interaction.channelId}`)
          .setLabel('Delete all channel messages')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`clear:cancel:${interaction.user.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        embeds: [createTextEmbed(
          'Confirm channel cleanup',
          'This permanently deletes every message in this channel, including messages older than 14 days. Confirm to continue.',
          interaction.member,
          0xd96b72
        )],
        components: [confirmRow],
        ephemeral: true
      });
      return;
    }

    if (commandName === 'commands') {
      try {
        await interaction.user.send({ embeds: createCommandGuideEmbeds() });
        await replyWithEmbed(interaction, 'Command guide sent', 'I sent you a direct message with the command guide.', { ephemeral: true });
      } catch (error) {
        console.error(`Unable to DM command guide to user ${interaction.user.id}:`, error);
        await replyWithEmbed(
          interaction,
          'Could not send command guide',
          'Please enable direct messages from server members, then try `/commands` again.',
          { ephemeral: true }
        );
      }
      return;
    }

    if (commandName === 'ping') {
      await interaction.deferReply({ ephemeral: true });
      const startedAt = Date.now();
      await pool.query('SELECT 1');
      await replyWithEmbed(
        interaction,
        'Bot online',
        `Discord ping: **${client.ws.ping} ms**\nDatabase: **OK** (${Date.now() - startedAt} ms).`,
        { ephemeral: true }
      );
      return;
    }

    if (commandName === 'refresh') {
      if (!(await requireCommandAccess(interaction, 'refresh'))) return;

      await interaction.deferReply({ ephemeral: true });
      const [globalCommands, guildCommands] = await Promise.all([
        client.application.commands.set(commandSchemas),
        client.application.commands.set(commandSchemas, interaction.guildId)
      ]);
      await replyWithEmbed(
        interaction,
        'Commands refreshed',
        `${guildCommands.size} commands are ready in this server. Global commands: ${globalCommands.size}.`,
        { ephemeral: true }
      );
      return;
    }

    if (['ticket', 'application', 'permissions', 'automod', 'welcome', 'leave', 'autoreply', 'trigger', 'autorole', 'scamguard', 'logs'].includes(commandName)) {
      await handleManagementCommand(interaction, commandName);
      return;
    }

    if (commandName === 'profile') {
      await interaction.deferReply();
      const user = interaction.options.getUser('member') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id);
      const { rows } = await pool.query(
        'SELECT xp, messages FROM member_stats WHERE guild_id = $1 AND user_id = $2',
        [interaction.guildId, user.id]
      );
      const stats = rows[0] || { xp: 0, messages: 0 };
      const xp = Number(stats.xp);
      const level = levelForXp(xp);
      const nextLevelXp = xpForNextLevel(level);
      const roleNames = member.roles.cache
        .filter(role => role.id !== interaction.guildId)
        .sort((first, second) => second.position - first.position)
        .map(role => role.name)
        .slice(0, 10);
      const roles = roleNames.length ? roleNames.join(', ').slice(0, 1000) : 'No additional roles';
      const embed = createTextEmbed(
        `${member.displayName} • Player Profile`,
        `**${user.tag}**\nServer member profile for **${interaction.guild.name}**.`,
        member
      ).addFields(
        { name: 'Level', value: `${level}${level === 100 ? ' (MAX)' : ''}`, inline: true },
        { name: 'Points', value: `${xp.toLocaleString()} XP`, inline: true },
        { name: 'Messages', value: Number(stats.messages).toLocaleString(), inline: true },
        { name: 'Next level', value: level === 100 ? 'Maximum level reached' : `${Math.max(0, nextLevelXp - xp).toLocaleString()} XP remaining`, inline: true },
        { name: 'Joined server', value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'Unknown', inline: true },
        { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`, inline: true },
        { name: 'Roles', value: roles, inline: false }
      );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === 'leaderboard') {
      await interaction.deferReply();
      const { rows } = await pool.query(
        'SELECT user_id, xp, messages FROM member_stats WHERE guild_id = $1 ORDER BY xp DESC LIMIT 10',
        [interaction.guildId]
      );
      const lines = await Promise.all(rows.map(async (row, index) => {
        const user = await client.users.fetch(row.user_id).catch(() => null);
        return `${index + 1}. ${user ? user.username : 'Unknown member'} — Level ${levelForXp(Number(row.xp))} (${row.xp} XP)`;
      }));
      await interaction.editReply({
        embeds: [createTextEmbed('Server Leaderboard', lines.join('\n') || 'No XP earned yet.', null, 0x40b8a4)]
      });
      return;
    }

    if (commandName === 'invites') {
      await interaction.deferReply({ ephemeral: true });
      if (interaction.options.getSubcommand() === 'leaderboard') {
        const { rows } = await pool.query(
          `SELECT inviter_id, COUNT(*) AS invite_count
          FROM invite_joins
          WHERE guild_id = $1 AND inviter_id IS NOT NULL
          GROUP BY inviter_id
          ORDER BY COUNT(*) DESC, inviter_id
          LIMIT 10`,
          [interaction.guildId]
        );
        const lines = await Promise.all(rows.map(async (row, index) => {
          let name = row.inviter_id;
          try {
            const user = await client.users.fetch(row.inviter_id);
            name = user.username;
          } catch (error) {
            console.warn(`Unable to resolve invite leader ${row.inviter_id}:`, error);
          }
          return `${index + 1}. **${name}** — ${Number(row.invite_count)} invite${Number(row.invite_count) === 1 ? '' : 's'}`;
        }));
        await replyWithEmbed(
          interaction,
          'Invite leaderboard',
          lines.join('\n') || 'No invite-attributed joins have been recorded yet.',
          { ephemeral: true }
        );
        return;
      }

      const member = interaction.options.getUser('member') || interaction.user;
      const { rows } = await pool.query(
        'SELECT COUNT(*) AS invite_count FROM invite_joins WHERE guild_id = $1 AND inviter_id = $2',
        [interaction.guildId, member.id]
      );
      const inviteCount = Number(rows[0]?.invite_count || 0);
      await replyWithEmbed(
        interaction,
        'Invite count',
        `${member} has **${inviteCount}** invite-attributed join${inviteCount === 1 ? '' : 's'}.`,
        { ephemeral: true }
      );
      return;
    }

    if (commandName === 'kick' || commandName === 'ban' || commandName === 'nick') {
      const requiredPermission = commandName === 'kick'
        ? PermissionFlagsBits.KickMembers
        : commandName === 'ban'
          ? PermissionFlagsBits.BanMembers
          : PermissionFlagsBits.ManageNicknames;
      const hasConfiguredAccess = await hasCommandAccess(interaction, commandName);
      if (!hasConfiguredAccess && !interaction.memberPermissions?.has(requiredPermission)) {
        await replyWithEmbed(interaction, 'Missing permission', `You need the ${commandName === 'nick' ? 'Manage Nicknames' : commandName === 'kick' ? 'Kick Members' : 'Ban Members'} permission to use this command.`, { ephemeral: true });
        return;
      }
      const user = interaction.options.getUser('member');
      let target;
      try {
        target = await interaction.guild.members.fetch(user.id);
      } catch (error) {
        if (error.code !== 10007) throw error;
        target = null;
      }
      if (commandName !== 'ban' && !target) {
        await replyWithEmbed(interaction, 'Member not found', 'That user is not currently in this server.', { ephemeral: true });
        return;
      }
      if (target && interaction.user.id !== interaction.guild.ownerId &&
          !isGlobalCommandAdmin(interaction.user.id) &&
          target.roles.highest.position >= interaction.member.roles.highest.position) {
        await replyWithEmbed(interaction, 'Role hierarchy restriction', 'You cannot moderate a member with an equal or higher role.', { ephemeral: true });
        return;
      }
      const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
      if (target && target.roles.highest.position >= botMember.roles.highest.position) {
        await replyWithEmbed(interaction, 'Role hierarchy restriction', 'I cannot moderate a member with an equal or higher role than mine.', { ephemeral: true });
        return;
      }
      const reason = interaction.options.getString('reason')?.trim() || `Action by ${interaction.user.tag}`;
      if (commandName === 'kick') {
        await target.kick(reason);
      } else if (commandName === 'ban') {
        await interaction.guild.members.ban(user.id, { reason });
      } else {
        const nickname = interaction.options.getString('nickname')?.trim() || null;
        await target.setNickname(nickname, reason);
      }
      const settings = await getGuildSettings(interaction.guildId);
      await logModerationAction(
        interaction.guild,
        settings,
        `${commandName[0].toUpperCase()}${commandName.slice(1)} action`,
        `Member: ${user.tag} (${user.id})\nModerator: ${interaction.user.tag}\nReason: ${reason}${commandName === 'nick' ? `\nNickname: ${interaction.options.getString('nickname')?.trim() || '[reset]'}` : ''}`
      );
      const actionResult = commandName === 'kick' ? 'kicked' : commandName === 'ban' ? 'banned' : 'renamed';
      await replyWithEmbed(interaction, `${commandName[0].toUpperCase()}${commandName.slice(1)} complete`, `${user.tag} was ${actionResult}.`, { ephemeral: true });
      return;
    }

    if (commandName === 'say') {
      if (!(await requireCommandAccess(interaction, 'say'))) return;
      const channel = interaction.options.getChannel('channel');
      if (!channel.isTextBased() || channel.isDMBased()) {
        await replyWithEmbed(interaction, 'Invalid channel', 'Choose a server text channel.', { ephemeral: true });
        return;
      }
      const image = interaction.options.getAttachment('image');
      if (image && !(image.contentType?.startsWith('image/') ||
          /\.(?:png|jpe?g|gif|webp|avif)$/i.test(new URL(image.url).pathname))) {
        await replyWithEmbed(interaction, 'Invalid attachment', 'The optional attachment must be an image.', { ephemeral: true });
        return;
      }
      const announcement = new EmbedBuilder()
        .setColor(0x7564d8)
        .setTitle('Announcement')
        .setDescription(interaction.options.getString('message'))
        .setFooter({ text: `Posted by ${interaction.user.tag}` })
        .setTimestamp();
      if (image) announcement.setImage(image.url);
      await channel.send({ embeds: [announcement], allowedMentions: { parse: [] } });
      await replyWithEmbed(interaction, 'Announcement posted', `Your announcement was posted in ${channel}.`, { ephemeral: true });
      return;
    }

    if (commandName === 'giveaway') {
      if (!(await requireCommandAccess(interaction, 'giveaway'))) return;
      const channel = interaction.options.getChannel('channel');
      if (!channel.isTextBased() || channel.isDMBased()) {
        await replyWithEmbed(interaction, 'Invalid channel', 'Choose a server text channel.', { ephemeral: true });
        return;
      }
      const giveawayId = randomUUID();
      const duration = interaction.options.getInteger('duration');
      const endsAt = new Date(Date.now() + duration * 60 * 1000);
      const prize = interaction.options.getString('prize').trim();
      const winnerCount = interaction.options.getInteger('winners') || 1;
      await pool.query(
        'INSERT INTO giveaways (id, guild_id, channel_id, host_id, prize, winner_count, ends_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [giveawayId, interaction.guildId, channel.id, interaction.user.id, prize, winnerCount, endsAt]
      );
      let giveawayMessage;
      try {
        giveawayMessage = await channel.send({
          embeds: [createTextEmbed(
            '🎉 Giveaway',
            `**Prize:** ${prize}\n**Winners:** ${winnerCount}\n**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>\nHosted by ${interaction.user}`,
            null,
            0x40b8a4
          )],
          components: [createGiveawayControls(giveawayId)]
        });
      } catch (error) {
        await pool.query('DELETE FROM giveaways WHERE id = $1 AND status = $2', [giveawayId, 'open']);
        throw error;
      }
      scheduleGiveaway(giveawayId, endsAt);
      await replyWithEmbed(interaction, 'Giveaway started', `Giveaway message posted: ${giveawayMessage.url}`, { ephemeral: true });
      return;
    }

    if (commandName === 'play') {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) {
        await replyWithEmbed(interaction, 'Join a voice channel', 'Join a voice channel before starting music.', { ephemeral: true });
        return;
      }
      const url = interaction.options.getString('url').trim();
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        await replyWithEmbed(interaction, 'Invalid URL', 'Provide a complete audio or video URL.', { ephemeral: true });
        return;
      }
      const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be']);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password ||
          !youtubeHosts.has(parsedUrl.hostname.toLowerCase())) {
        await replyWithEmbed(interaction, 'Unsupported URL', 'Only public YouTube video links are supported.', { ephemeral: true });
        return;
      }
      const voicePermissions = voiceChannel.permissionsFor(interaction.guild.members.me);
      if (!voicePermissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        await replyWithEmbed(interaction, 'Missing voice permissions', 'I need Connect and Speak permissions in your voice channel.', { ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const previous = musicPlayers.get(interaction.guildId);
      musicPlayers.delete(interaction.guildId);
      previous?.player.stop();
      previous?.connection.destroy();
      const stream = await play.stream(parsedUrl.href);
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (error) {
        connection.destroy();
        throw new Error(`Could not connect to the voice channel: ${error.message}`);
      }
      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
      });
      player.once('error', error => {
        console.error(`Voice playback failed in guild ${interaction.guildId}:`, error);
        if (musicPlayers.get(interaction.guildId)?.player === player) {
          musicPlayers.delete(interaction.guildId);
          connection.destroy();
        }
      });
      player.once(AudioPlayerStatus.Idle, () => {
        if (musicPlayers.get(interaction.guildId)?.player === player) {
          musicPlayers.delete(interaction.guildId);
          connection.destroy();
        }
      });
      connection.subscribe(player);
      player.play(createAudioResource(stream.stream, { inputType: stream.type }));
      musicPlayers.set(interaction.guildId, { connection, player, channelId: voiceChannel.id });
      await replyWithEmbed(interaction, 'Now playing', `Connected to ${voiceChannel} and started playback.`, { ephemeral: true });
      return;
    }

    if (commandName === 'stop') {
      const active = musicPlayers.get(interaction.guildId);
      if (!active) {
        await replyWithEmbed(interaction, 'Nothing is playing', 'There is no active music playback in this server.', { ephemeral: true });
        return;
      }
      if (interaction.member.voice.channelId !== active.channelId &&
          !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await replyWithEmbed(interaction, 'Join the music channel', 'Join the voice channel currently playing music, or ask a server manager to stop it.', { ephemeral: true });
        return;
      }
      active.player.stop();
      active.connection.destroy();
      musicPlayers.delete(interaction.guildId);
      await replyWithEmbed(interaction, 'Playback stopped', 'Music stopped and the bot disconnected.', { ephemeral: true });
      return;
    }

    if (commandName === 'serverinfo') {
      const guild = interaction.guild;
      const embed = new EmbedBuilder()
        .setColor(0x40b8a4)
        .setTitle(guild.name)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
          { name: 'Members', value: `${guild.memberCount}`, inline: true },
          { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true }
        );
      await interaction.reply({ embeds: [embed] });
    }
  }

  client.on('interactionCreate', interaction => {
    handleInteraction(interaction).catch(async error => {
      console.error('Interaction failed:', error);
      if (interaction.isRepliable()) {
        const details = error instanceof Error ? error.message : 'Unknown error';
        const response = {
          embeds: [createTextEmbed('Command failed', details, interaction.member)],
          ephemeral: true
        };
        const reportError = replyError => console.error('Unable to report interaction failure:', replyError);
        if (interaction.deferred) {
          await interaction.editReply(response).catch(reportError);
        } else if (!interaction.replied) {
          await interaction.reply(response).catch(reportError);
        }
      }
    });
  });

  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    try {
      const now = Date.now();
      const member = message.member || await message.guild.members.fetch(message.author.id);
      const settings = await getGuildSettings(message.guild.id);
      let partnershipTicket = false;
      if (settings.links_enabled) {
        const { rows: activeTickets } = await pool.query(
          'SELECT kind FROM tickets WHERE channel_id = $1 AND status = $2',
          [message.channelId, 'open']
        );
        partnershipTicket = activeTickets[0]?.kind === 'partnership';
      }
      const isPrivileged = member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.roles.cache.some(role => role.permissions.has(PermissionFlagsBits.ManageMessages));
      if (!isPrivileged && message.content && settings.scamguard_channel_id === message.channelId &&
          Array.isArray(settings.scamguard_terms) &&
          settings.scamguard_terms.some(term => matchesWholePhrase(message.content, term))) {
        await message.delete().catch(error => console.error('Unable to delete scam-guard message:', error));
        await member.kick('Matched a configured scam phrase in the monitored channel');
        await logModerationAction(
          message.guild,
          settings,
          'Scam guard kick',
          `Member: ${message.author.tag} (${message.author.id})\nChannel: <#${message.channelId}>\nMatched a configured scam phrase.`
        );
        return;
      }
      if (!isPrivileged && message.content) {
        const { rows: terms } = await pool.query('SELECT term FROM automod_terms WHERE guild_id = $1', [message.guild.id]);
        const mentionAbuse = message.mentions.users.size >= 5;
        const matchedTerm = terms.some(({ term }) => matchesWholePhrase(message.content, term));
        const linkDetected = shouldRemoveLink(message.content, settings.links_enabled, partnershipTicket);
        const spamKey = `${message.guild.id}:${message.author.id}`;
        const recentMessages = (spamHistory.get(spamKey) || [])
          .filter(item => now - item.timestamp < 10000);
        recentMessages.push({ content: message.content.trim().toLocaleLowerCase(), timestamp: now });
        spamHistory.set(spamKey, recentMessages);
        const repeatedSpam = recentMessages.filter(item => item.content === message.content.trim().toLocaleLowerCase()).length >= 3;
        const violation = mentionAbuse || matchedTerm || repeatedSpam || linkDetected;

        if (violation) {
          spamHistory.delete(spamKey);
          await message.delete().catch(error => console.error('Unable to delete moderated message:', error));
          const { rows } = await pool.query(
            `INSERT INTO moderation_strikes (guild_id, user_id, strikes) VALUES ($1, $2, 1)
            ON CONFLICT (guild_id, user_id) DO UPDATE SET strikes = moderation_strikes.strikes + 1
            RETURNING strikes`,
            [message.guild.id, message.author.id]
          );
          const strikes = Number(rows[0].strikes);
          const reason = linkDetected ? 'links are not allowed' : matchedTerm ? 'a filtered phrase' :
            mentionAbuse ? 'excessive mentions' : 'repeated spam';
          if (strikes < 3) {
            await sendStyledMemberMessage(
              message.channel,
              member,
              'COMMUNITY WARNING',
              `Warning ${strikes}/3: ${reason}. Please follow the server rules.`
            )
              .then(warning => setTimeout(() => warning.delete().catch(() => {}), 10000));
          } else {
            await member.timeout(5 * 60 * 1000, 'Automatic moderation: three abuse/filter violations');
            await pool.query('UPDATE moderation_strikes SET strikes = 0 WHERE guild_id = $1 AND user_id = $2', [message.guild.id, message.author.id]);
            await sendStyledMemberMessage(
              message.channel,
              member,
              'MODERATION NOTICE',
              'Warning 3/3: your message violated the server rules. You have been timed out for 5 minutes after three warnings.'
            )
              .then(warning => setTimeout(() => warning.delete().catch(() => {}), 15000));
          }
          await logModerationAction(
            message.guild,
            settings,
            strikes < 3 ? 'Automatic moderation warning' : 'Automatic moderation timeout',
            `Member: ${message.author.tag} (${message.author.id})\nChannel: <#${message.channelId}>\nReason: ${reason}\nWarnings: ${strikes}/3`
          );
          return;
        }
      }

      await pool.query(
        `INSERT INTO member_stats (guild_id, user_id, xp, messages)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (guild_id, user_id)
        DO UPDATE SET xp = member_stats.xp + EXCLUDED.xp, messages = member_stats.messages + 1`,
        [message.guild.id, message.author.id, xpForMessages(1)]
      );

      if (message.content) {
        const { rows: replies } = await pool.query(
          `SELECT keyword, response FROM auto_replies WHERE guild_id = $1
          UNION ALL
          SELECT keyword, response FROM triggers WHERE guild_id = $1`,
          [message.guild.id]
        );
        const reply = replies
          .sort((first, second) => second.keyword.length - first.keyword.length)
          .find(item => matchesWholePhrase(message.content, item.keyword));
        if (reply) {
          const content = reply.response
            .replaceAll('{user}', member.displayName)
            .replaceAll('{username}', message.author.username)
            .replaceAll('{server}', message.guild.name);
          await sendStyledMemberMessage(message.channel, member, 'COMMUNITY ASSISTANT', content);
        }
      }

      const { rows: applications } = await pool.query(
        `SELECT opener_id, kind, application_questions, question_index, application_answers
        FROM tickets
        WHERE channel_id = $1 AND status = 'open'`,
        [message.channelId]
      );
      const application = applications[0];
      if (application && application.opener_id === message.author.id &&
          Array.isArray(application.application_questions) && application.application_questions.length > 0) {
        const questions = application.application_questions;
        const answers = Array.isArray(application.application_answers)
          ? [...application.application_answers]
          : [];
        const answerIndex = Math.min(Number(application.question_index), questions.length) - 1;
        const answerText = [
          message.content.trim(),
          ...[...message.attachments.values()].map(attachment => attachment.url)
        ].filter(Boolean).join('\n') || '[no text content]';
        if (answerIndex >= 0) {
          answers[answerIndex] = { question: questions[answerIndex], answer: answerText };
        }
        const step = getApplicationStep(questions, application.question_index);
        if (step) {
          const { rows: updated } = await pool.query(
            `UPDATE tickets SET question_index = $2, application_answers = $3
            WHERE channel_id = $1 AND status = $4 AND question_index = $5
            RETURNING channel_id`,
            [message.channelId, step.nextIndex, JSON.stringify(answers), 'open', application.question_index]
          );
          if (!updated.length) return;
          await sendStyledMemberMessage(
            message.channel,
            member,
            `APPLICATION FORM • STEP ${step.nextIndex}/${questions.length}`,
            step.question
          );
        } else {
          const settings = await getGuildSettings(message.guild.id);
          const transcriptSaved = await saveTicketTranscript(
            message.channel,
            message.guild.id,
            application.opener_id,
            applications[0].kind
          );
          if (!settings.application_review_channel_id) {
            const { rows: submitted } = await pool.query(
              `UPDATE tickets SET question_index = $2, application_answers = $3, status = 'pending_review'
              WHERE channel_id = $1 AND status = 'open' AND question_index = $4
              RETURNING channel_id`,
              [message.channelId, questions.length, JSON.stringify(answers), application.question_index]
            );
            if (!submitted.length) return;
            await message.channel.permissionOverwrites.edit(application.opener_id, {
              SendMessages: false
            }, 'Application completed without a configured review channel');
            await sendStyledMemberMessage(
              message.channel,
              member,
              'APPLICATION COMPLETE',
              `Your answers are saved${transcriptSaved ? ' and a transcript was sent to the configured archive channel' : ''}. A review channel is not set, so staff cannot accept or reject this application yet. Ask an admin to configure one with /ticket settings.`,
              [createTicketControls()]
            );
          } else {
            const reviewChannel = await message.guild.channels.fetch(settings.application_review_channel_id);
            if (!reviewChannel?.isTextBased() || reviewChannel.isDMBased()) {
              throw new Error(`Configured application review channel ${settings.application_review_channel_id} is unavailable.`);
            }
            await message.channel.permissionOverwrites.edit(application.opener_id, {
              SendMessages: false
            }, 'Application submitted for review');
            const { rows: submitted } = await pool.query(
              `UPDATE tickets SET question_index = $2, application_answers = $3, status = 'pending_review'
              WHERE channel_id = $1 AND status = 'open' AND question_index = $4
              RETURNING channel_id`,
              [message.channelId, questions.length, JSON.stringify(answers), application.question_index]
            );
            if (!submitted.length) return;
            const answersText = [
              `Staff application from ${message.author.tag} (${application.opener_id})`,
              '',
              formatApplicationAnswers(questions, answers)
            ].join('\n');
            const answersPdf = new AttachmentBuilder(
              await createPdfBuffer(answersText),
              { name: `application-${message.channelId}.pdf` }
            );
            const answersTextFile = new AttachmentBuilder(
              Buffer.from(answersText, 'utf8'),
              { name: `application-${message.channelId}.txt` }
            );
            try {
              await reviewChannel.send({
                content: `<@${application.opener_id}> (**${message.author.username}**) submitted a staff application.`,
                allowedMentions: { users: [application.opener_id] },
                embeds: [createTextEmbed(
                  'Application ready for review',
                  `Applicant: **${message.author.username}** (<@${application.opener_id}>)\nQuestion-and-answer PDF attached. ${transcriptSaved ? `Full ticket transcript: <#${settings.transcript_channel_id}>.` : 'No transcript archive channel is configured.'}`,
                  null,
                  0x40b8a4
                )],
                files: [answersPdf, answersTextFile],
                components: [createApplicationReviewControls(message.channelId, application.opener_id)]
              });
            } catch (error) {
              await pool.query(
                "UPDATE tickets SET status = 'open' WHERE channel_id = $1 AND status = 'pending_review'",
                [message.channelId]
              );
              await message.channel.permissionOverwrites.edit(application.opener_id, {
                SendMessages: true
              }, 'Application review message could not be posted');
              throw error;
            }
            setTimeout(() => message.channel.delete('Application submitted for review').catch(error => {
              console.error(`Unable to delete completed application ticket ${message.channelId}:`, error);
            }), 5000);
            await sendStyledMemberMessage(
              message.channel,
              member,
              'APPLICATION CLOSED',
              'Your completed application has been sent to staff for review. This private ticket will now close.'
            );
            await logModerationAction(
              message.guild,
              settings,
              'Application submitted',
              `Applicant: <@${application.opener_id}>\nClosed application ticket ID: ${message.channelId}`
            );
          }
        }
      }
    } catch (error) {
      console.error('Message handling failed:', error);
    }
  });

  client.on('guildMemberAdd', async member => {
    trackInviteJoin(member).catch(error => {
      console.error(`Unable to track invite attribution for member ${member.id} in guild ${member.guild.id}:`, error);
    });
    try {
      const settings = await getGuildSettings(member.guild.id);
      if (settings.auto_role_id) {
        try {
          await member.roles.add(settings.auto_role_id, 'Configured automatic member role');
        } catch (error) {
          console.error(`Unable to assign configured auto-role ${settings.auto_role_id} to ${member.id}:`, error);
        }
      }
      if (settings.welcome_channel_id) {
        const channel = await getAnnouncementChannel(member.guild, settings.welcome_channel_id);
        await sendMemberBanner(
          channel,
          member,
          settings.welcome_message || DEFAULT_WELCOME_MESSAGE,
          settings.welcome_banner,
          'welcome'
        );
      }
    } catch (error) {
      console.error('Welcome message failed:', error);
    }
  });

  client.on('guildMemberRemove', async member => {
    try {
      const settings = await getGuildSettings(member.guild.id);
      if (settings.leave_channel_id) {
        const channel = await getAnnouncementChannel(member.guild, settings.leave_channel_id);
        await sendMemberBanner(
          channel,
          member,
          settings.leave_message || DEFAULT_LEAVE_MESSAGE,
          settings.leave_banner,
          'goodbye'
        );
      }
    } catch (error) {
      console.error('Leave message failed:', error);
    }
  });

  client.on('guildCreate', async guild => {
    const inviteInitializationPromise = initializeInviteSnapshot(guild);
    inviteInitialization.set(guild.id, inviteInitializationPromise);
    try {
      const owner = await guild.fetchOwner();
      try {
        await owner.send({
          embeds: createCommandGuideEmbeds()
        });
        return;
      } catch (error) {
        console.warn(`Could not DM the command guide to owner ${owner.id} of guild ${guild.id}; trying a server channel.`);
        console.error('Command-guide DM failed:', error);
      }

      const botMember = guild.members.me || await guild.members.fetchMe();
      const channel = guild.systemChannel?.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)
        ? guild.systemChannel
        : guild.channels.cache.find(candidate =>
          candidate.isTextBased() &&
          !candidate.isDMBased() &&
          candidate.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)
        );
      if (!channel) {
        console.warn(`Could not find a channel to post the command guide in guild ${guild.id}.`);
        return;
      }

      await channel.send({ embeds: createCommandGuideEmbeds() });
    } catch (error) {
      console.error(`Unable to post the command guide for guild ${guild.id}:`, error);
    }
  });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    for (const guild of client.guilds.cache.values()) {
      const inviteInitializationPromise = initializeInviteSnapshot(guild);
      inviteInitialization.set(guild.id, inviteInitializationPromise);
    }
    try {
      const { rows } = await pool.query('SELECT id, ends_at FROM giveaways WHERE status = $1', ['open']);
      for (const giveaway of rows) scheduleGiveaway(giveaway.id, giveaway.ends_at);
    } catch (error) {
      console.error('Unable to resume open giveaways:', error);
    }
    try {
      const globalCommands = await client.application.commands.set(commandSchemas);
      console.log(`Registered ${globalCommands.size} global slash commands.`);
    } catch (error) {
      console.error('Unable to register global slash commands:', error);
    }

    for (const guild of client.guilds.cache.values()) {
      try {
        const guildCommands = await client.application.commands.set(commandSchemas, guild.id);
        console.log(`Registered ${guildCommands.size} slash commands in guild ${guild.id}.`);
      } catch (error) {
        console.error(`Unable to register slash commands in guild ${guild.id}:`, error);
      }
    }
  });

  async function start() {
    await initializeDatabase();
    await client.login(process.env.DISCORD_TOKEN);
  }

  start().catch(async error => {
    console.error('Bot startup failed:', error);
    await pool.end().catch(closeError => console.error('Unable to close database pool:', closeError));
    process.exitCode = 1;
  });
