const { EmbedBuilder } = require('discord.js');

function createTextEmbed(title, description, member, color = 0x7564d8) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(String(title ?? '').slice(0, 256))
    .setDescription(String(description ?? '').slice(0, 4000));
  const user = member?.user || member;
  if (user?.displayAvatarURL) {
    embed.setThumbnail(user.displayAvatarURL({ size: 256 }));
  }
  return embed;
}

module.exports = { createTextEmbed };
