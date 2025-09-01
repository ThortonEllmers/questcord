// src/commands/whereami.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUserPrefix } = require('../utils/roles');
const config = require('../utils/config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('whereami')
    .setDescription('Show your current virtual location (server name and ID).'),

  async execute(interaction) {
    const { db } = require('../utils/store_sqlite'); // Lazy require for deploy safety
    const userId = interaction.user.id;

    // Get full player info including travel data
    const player = db.prepare(`
      SELECT locationGuildId, travelArrivalAt, travelFromGuildId, travelStartAt
      FROM players
      WHERE userId=?`).get(userId) || {};

    const userPrefix = await getUserPrefix(interaction.client, interaction.user);

    // Check if currently traveling
    if (player.travelArrivalAt && player.travelArrivalAt > Date.now()) {
      // User is traveling
      const fromServer = db.prepare('SELECT name FROM servers WHERE guildId=?').get(player.travelFromGuildId);
      const toServer = db.prepare('SELECT name FROM servers WHERE guildId=?').get(player.locationGuildId);
      
      const fromName = fromServer?.name || `Server (${player.travelFromGuildId})`;
      const toName = toServer?.name || `Server (${player.locationGuildId})`;
      
      const timeLeft = Math.ceil((player.travelArrivalAt - Date.now()) / 1000 / 60); // minutes
      const arrivalTime = new Date(player.travelArrivalAt);
      
      const travelEmbed = new EmbedBuilder()
        .setTitle('✈️🌍 **CURRENTLY TRAVELING** 🌍✈️')
        .setDescription('🛫 *Your journey is in progress* 🛬')
        .setColor(0x3498DB)
        .setAuthor({ 
          name: userPrefix,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '🏃‍♀️ **Departure**',
            value: `**${fromName}**\n📍 Left your origin`,
            inline: true
          },
          {
            name: '🎯 **Destination**',
            value: `**${toName}**\n📍 Journey endpoint`,
            inline: true
          },
          {
            name: '⏰ **ETA**',
            value: `**${timeLeft} minutes**\n🕐 ${arrivalTime.toLocaleTimeString()}`,
            inline: true
          },
          {
            name: '🗺️ **Journey Status**',
            value: `🛫 **In Transit**\n✈️ Flying through the skies\n🌟 Adventure awaits at destination!`,
            inline: false
          }
        )
        .setFooter({ 
          text: `Safe travels! Your adventure continues shortly • QuestCord Travel`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
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
        .setTitle('🗺️📍 **CURRENT LOCATION** 📍🗺️')
        .setDescription('🏛️ *You have arrived at your destination* 🏛️')
        .setColor(0x00AE86)
        .setAuthor({ 
          name: userPrefix,
          iconURL: interaction.user.displayAvatarURL() 
        })
        .addFields(
          {
            name: '🏛️ **Server**',
            value: `**${displayName}**\n🆔 ${destinationGuildId}`,
            inline: true
          },
          {
            name: '🌍 **Region**',
            value: `**${region}**\n🗺️ Geographic location`,
            inline: true
          },
          {
            name: '🌿 **Biome**',
            value: `**${biome}**\n🌱 Environmental setting`,
            inline: true
          },
          {
            name: '✅ **Status**',
            value: `🏠 **Currently Located**\n📍 Ready for your next journey\n🚀 Use /travel to visit other servers!`,
            inline: false
          }
        )
        .setFooter({ 
          text: `Visit other servers with /travel or /nearby • QuestCord Navigation`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp();
      
      await interaction.reply({ embeds: [locationEmbed] });
    }
  },
};
