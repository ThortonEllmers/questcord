const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserPrefix } = require('../utils/roles');
const config = require('../utils/config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('whereami')
    .setDescription('Show your current virtual location (server name and ID).'),

  async execute(interaction) {
    const { db } = require('../utils/store_sqlite');
    const userId = interaction.user.id;

    const player = db.prepare(`
      SELECT locationGuildId, travelArrivalAt, travelFromGuildId, travelStartAt
      FROM players
      WHERE userId=?`).get(userId) || {};

    const userPrefix = await getUserPrefix(interaction.client, interaction.user);

    if (player.travelArrivalAt && player.travelArrivalAt > Date.now()) {
      const fromServer = db.prepare('SELECT name FROM servers WHERE guildId=?').get(player.travelFromGuildId);
      const toServer = db.prepare('SELECT name FROM servers WHERE guildId=?').get(player.locationGuildId);
      
      const fromName = fromServer?.name || `Server (${player.travelFromGuildId})`;
      const toName = toServer?.name || `Server (${player.locationGuildId})`;
      
      const timeLeft = Math.ceil((player.travelArrivalAt - Date.now()) / 1000 / 60); // minutes
      const arrivalTime = new Date(player.travelArrivalAt);
      
      const travelEmbed = new EmbedBuilder()
        .setTitle('Currently Traveling')
        .setColor(0x3498DB)
        .addFields(
          {
            name: 'From',
            value: fromName,
            inline: true
          },
          {
            name: 'To',
            value: toName,
            inline: true
          },
          {
            name: 'ETA',
            value: `${timeLeft} minutes`,
            inline: true
          }
        )
        .setFooter({ text: 'QuestCord' })
        .setTimestamp();
      
      await interaction.reply({ embeds: [travelEmbed] });
    } else {
      // User is at a location
      const destinationGuildId = player.locationGuildId || config.spawn?.guildId || interaction.guildId;
      
      // Get server name from DB
      let serverName = null;
      let serverData = null;
      if (destinationGuildId) {
        serverData = db.prepare('SELECT name, biome FROM servers WHERE guildId=?').get(destinationGuildId);
        serverName = serverData?.name || null;

        if (!serverName) {
          const g = interaction.client.guilds.cache.get(destinationGuildId);
          if (g?.name) {
            serverName = g.name;
            // Keep DB fresh
            db.prepare(`
              INSERT INTO servers (guildId, name)
              VALUES (?, ?)
              ON CONFLICT(guildId) DO UPDATE SET name=excluded.name`)
              .run(destinationGuildId, serverName);
          }
        }
      }

      const displayName = serverName || `Server (${destinationGuildId})`;
      const biome = serverData?.biome || 'Unknown Biome';
      
      // Get region info from guild location if available, or use a default
      const region = interaction.guild?.preferredLocale ? 
        interaction.guild.preferredLocale.split('-')[1]?.toUpperCase() || 'Unknown Region' : 
        'Unknown Region';
      
      const locationEmbed = new EmbedBuilder()
        .setTitle('Current Location')
        .setColor(0x00AE86)
        .addFields(
          {
            name: 'Server',
            value: displayName,
            inline: true
          },
          {
            name: 'Region', 
            value: region,
            inline: true
          },
          {
            name: 'Biome',
            value: biome,
            inline: true
          }
        )
        .setFooter({ text: 'Use /travel to visit other servers' })
        .setTimestamp();
      
      await interaction.reply({ embeds: [locationEmbed] });
    }
  },
};
