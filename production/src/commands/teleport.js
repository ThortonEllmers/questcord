const { SlashCommandBuilder } = require('discord.js');
const { db } = require('../utils/store_sqlite');
const { getUserPrefix, isStaffOrDev } = require('../utils/roles');
const { isBanned } = require('./_guard');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('teleport')
    .setDescription('Instantly teleport to a server (Staff/Developer only)')
    .addStringOption(o =>
      o.setName('serverid')
        .setDescription('Server ID to teleport to')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    try {
      // Get current input
      const focusedValue = interaction.options.getFocused().toLowerCase();
      
      // Search servers by ID or name
      const servers = db.prepare(`
        SELECT guildId, name FROM servers 
        WHERE archived = 0 
        AND (guildId LIKE ? OR name LIKE ?)
        AND lat IS NOT NULL AND lon IS NOT NULL
        ORDER BY name 
        LIMIT 25
      `).all(`%${focusedValue}%`, `%${focusedValue}%`);

      const choices = servers.map(s => ({
        name: `${s.name || 'Unknown'} (${s.guildId})`,
        value: s.guildId
      }));

      await interaction.respond(choices);
    } catch (error) {
      console.error('Teleport autocomplete error:', error);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const userPrefix = await getUserPrefix(interaction.client, interaction.user);
    if (isBanned(interaction.user.id)) {
      return interaction.reply({ content: `${userPrefix} You are banned from using this bot.`, ephemeral: true });
    }

    const targetServerId = interaction.options.getString('serverid');
    const userId = interaction.user.id;

    // Check if user has permission (Staff or Developer role)
    if (!(await isStaffOrDev(interaction.client, userId))) {
      return interaction.reply({ 
        content: `${userPrefix} This command is restricted to Staff and Developers only.`, 
        ephemeral: true 
      });
    }

    try {
      // Check if target server exists and has coordinates
      const targetServer = db.prepare(`
        SELECT guildId, name, lat, lon 
        FROM servers 
        WHERE guildId = ? AND archived = 0 
        AND lat IS NOT NULL AND lon IS NOT NULL
      `).get(targetServerId);

      if (!targetServer) {
        return interaction.reply({ 
          content: `${userPrefix} Server not found or has no coordinates set.`, 
          ephemeral: true 
        });
      }

      // Get or create player record
      let player = db.prepare('SELECT * FROM players WHERE userId = ?').get(userId);
      if (!player) {
        db.prepare('INSERT INTO players(userId, name, locationGuildId) VALUES(?, ?, ?)')
          .run(userId, interaction.user.username, interaction.guild.id);
        player = db.prepare('SELECT * FROM players WHERE userId = ?').get(userId);
      }

      // Get current location for logging
      const currentServer = db.prepare('SELECT name FROM servers WHERE guildId = ?')
        .get(player.locationGuildId);

      // Instant teleport - set location directly and mark arrival as complete
      const now = Date.now();
      db.prepare(`
        UPDATE players 
        SET locationGuildId = ?, 
            travelArrivalAt = 0, 
            travelStartAt = NULL, 
            travelFromGuildId = NULL 
        WHERE userId = ?
      `).run(targetServerId, userId);

      // Log the teleport action
      logger.info('teleport: staff user %s teleported from %s to %s (%s)', 
        userId, 
        currentServer?.name || 'unknown', 
        targetServer.name, 
        targetServerId
      );

      const config = require('../utils/config');
      const baseUrl = (config.web?.publicBaseUrl || '').replace(/\/$/, '');

      await interaction.reply({
        content: `${userPrefix} 🌟 **Teleported instantly** to **${targetServer.name}**!\n` +
                `📍 Location: ${baseUrl}/${targetServerId}`,
        ephemeral: false
      });

    } catch (error) {
      console.error('Teleport command error:', error);
      await interaction.reply({ 
        content: `${userPrefix} An error occurred while teleporting. Please try again.`, 
        ephemeral: true 
      });
    }
  }
};